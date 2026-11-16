#!/usr/bin/env node
// MCP server (stdio): tools for building, checking, simulating and exporting
// a ladder logic project from a chat interface.

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { renderRung } from '../core/ascii.js';
import { blockReference } from '../core/blocks.js';
import { DSL_REFERENCE, formatRung } from '../core/dsl.js';
import { Project, emptyProject } from '../core/model.js';
import { OpError, addRung, describeProject, moveRung, removeRung, removeTag, renameTag, setProjectInfo, updateRung, upsertTags } from '../core/ops.js';
import { exportPlcopen } from '../core/plcopen.js';
import { formatScenarioResult, runScenario } from '../core/scenario.js';
import { formatIssues, hasErrors, validate } from '../core/validate.js';
import { HttpHandle, startHttp } from './http.js';
import { ProjectStore, defaultPort, defaultProjectPath } from './store.js';

const store = new ProjectStore(defaultProjectPath());
const port = defaultPort();
let web: HttpHandle | undefined;

const INSTRUCTIONS = `Build IEC 61131-3 ladder logic for a PLC, check it, simulate it and export it as PLCopen XML.

Workflow:
1. set_tags: declare every signal first, with an address for physical I/O (%IX0.0 inputs, %QX0.0 outputs) and no address for internal bits.
2. add_rungs: write the logic in rung text syntax (below). Rungs execute top to bottom every scan; the last write to a bit wins.
3. Read the validation result returned by each edit and fix errors.
4. simulate: prove the behaviour with a scenario of inputs, elapsed time and expected values before calling the work done.
5. export_plcopen: write the importable project file. open_simulator gives the user a live view they can operate and edit.

Physical wiring matters. A contact tests the input BIT, not the device. Stop buttons, emergency stops and overload contacts are wired normally closed (NC) so that a broken wire stops the machine: their bit is 1 when healthy and 0 when pressed or tripped. Declare such inputs with field_contact "NC" and use a normally open contact (plain tag name) for them in the logic, e.g. (start_pb | motor) & stop_pb & overload_ok -> motor.

Generated logic must not be the only protection for people or equipment: emergency stops and guards belong in hardwired or safety-rated circuits. Say so when the user asks for safety functions.

${DSL_REFERENCE}

Blocks:
${blockReference()}`;

const server = new McpServer({ name: 'ladder-plc', version: '0.1.0' }, { instructions: INSTRUCTIONS });

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }] });

/** Run a tool body, turning expected failures into tool errors the model can act on. */
function guard<A>(fn: (args: A) => string | Promise<string>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return text(await fn(args));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!(e instanceof OpError)) console.error(e);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  };
}

const validation = (project: Project) => `Validation:\n${formatIssues(validate(project))}`;
const showRungs = (project: Project, numbers: number[]) => numbers.map((n) => `${renderRung(project.rungs[n - 1], n)}\n   text: ${formatRung(project.rungs[n - 1])}`).join('\n\n');

server.registerTool(
  'get_project',
  {
    title: 'Get project',
    description: 'Show the whole project: tags, block instances, every rung in text form and as a ladder diagram, and the validation result. Call this before editing an existing project.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  guard(() => `${describeProject(store.load())}\n\nProject file: ${store.path}`),
);

server.registerTool(
  'new_project',
  {
    title: 'New project',
    description: 'Start an empty project in the project file. Fails if the file already holds tags or rungs unless overwrite is true; ask the user before overwriting.',
    inputSchema: {
      name: z.string().min(1).describe('Project name'),
      description: z.string().optional().describe('What the machine or process does'),
      scan_ms: z.number().int().min(1).max(10000).optional().describe('Scan (task) interval in ms, default 20'),
      overwrite: z.boolean().optional().describe('Replace an existing non-empty project'),
    },
  },
  guard(({ name, description, scan_ms, overwrite }) => {
    if (store.exists()) {
      const current = store.load();
      if ((current.tags.length > 0 || current.rungs.length > 0) && !overwrite) {
        throw new OpError(`${store.path} already contains project "${current.name}" (${current.tags.length} tags, ${current.rungs.length} rungs). Confirm with the user, then pass overwrite: true.`);
      }
    }
    const project = setProjectInfo(emptyProject(name), { description, scanMs: scan_ms });
    store.save(project);
    return `Created empty project "${project.name}" (scan time ${project.scanMs} ms) in ${store.path}`;
  }),
);

server.registerTool(
  'set_project_info',
  {
    title: 'Set project info',
    description: 'Change the project name, description or scan time.',
    inputSchema: {
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      scan_ms: z.number().int().min(1).max(10000).optional(),
    },
  },
  guard(({ name, description, scan_ms }) => {
    const project = store.update((p) => setProjectInfo(p, { name, description, scanMs: scan_ms }));
    return `Project "${project.name}", scan time ${project.scanMs} ms.`;
  }),
);

server.registerTool(
  'set_tags',
  {
    title: 'Create or update tags',
    description: 'Declare tags (variables) or change existing ones. Tags must exist before rungs can use them. Omitted fields keep their current value.',
    inputSchema: {
      tags: z
        .array(
          z.object({
            name: z.string().describe('IEC identifier, e.g. start_pb'),
            type: z.enum(['BOOL', 'INT', 'DINT', 'REAL', 'TIME']).optional().describe('Default BOOL'),
            address: z.string().optional().describe('Direct address for physical I/O or memory: %IX0.0 input bit, %QX0.0 output bit, %IW0/%QW0 analog word, %MW0 memory word. Leave out for internal tags. Empty string clears it.'),
            initial: z.union([z.boolean(), z.number(), z.string()]).optional().describe('Power-on value, e.g. true, 10, "T#5s". Empty string clears it.'),
            comment: z.string().optional().describe('What the signal is, e.g. "Start pushbutton (green)"'),
            field_contact: z.enum(['NO', 'NC', 'none']).optional().describe('For physical inputs: how the device is wired. NC devices (stop buttons, overloads) read 1 until actuated.'),
          }),
        )
        .min(1),
    },
  },
  guard(({ tags }) => {
    const project = store.update((p) =>
      upsertTags(
        p,
        tags.map((t) => ({ ...t, fieldContact: t.field_contact === undefined ? undefined : t.field_contact === 'none' ? null : t.field_contact })),
      ),
    );
    return `Saved ${tags.length} tag(s): ${tags.map((t) => t.name).join(', ')}\n\n${validation(project)}`;
  }),
);

server.registerTool(
  'rename_tag',
  {
    title: 'Rename tag',
    description: 'Rename a tag and update every rung that uses it.',
    inputSchema: { name: z.string(), new_name: z.string() },
  },
  guard(({ name, new_name }) => {
    store.update((p) => renameTag(p, name, new_name));
    return `Renamed "${name}" to "${new_name}".`;
  }),
);

server.registerTool(
  'remove_tag',
  {
    title: 'Remove tag',
    description: 'Delete a tag. Fails while any rung still uses it.',
    inputSchema: { name: z.string() },
  },
  guard(({ name }) => {
    store.update((p) => removeTag(p, name));
    return `Removed tag "${name}".`;
  }),
);

server.registerTool(
  'add_rungs',
  {
    title: 'Add rungs',
    description: `Add one or more rungs, written in rung text syntax. Returns the drawn rungs and the validation result.\n\n${DSL_REFERENCE}`,
    inputSchema: {
      rungs: z
        .array(
          z.object({
            logic: z.string().describe('Rung text, e.g. "(start_pb | motor) & stop_pb -> motor"'),
            comment: z.string().optional().describe('Short description of what the rung does'),
          }),
        )
        .min(1),
      position: z.number().int().min(1).optional().describe('Rung number the first new rung should take; omit to append at the end'),
    },
  },
  guard(({ rungs, position }) => {
    let start = 0;
    const project = store.update((p) => {
      start = position ?? p.rungs.length + 1;
      return rungs.reduce((acc, r, i) => addRung(acc, r.logic, r.comment, start + i), p);
    });
    const numbers = rungs.map((_, i) => start + i);
    return `${showRungs(project, numbers)}\n\n${validation(project)}`;
  }),
);

server.registerTool(
  'update_rung',
  {
    title: 'Update rung',
    description: 'Replace the logic and/or comment of an existing rung (by its number in get_project).',
    inputSchema: {
      rung: z.number().int().min(1).describe('Rung number'),
      logic: z.string().optional().describe('New rung text'),
      comment: z.string().optional().describe('New comment; empty string removes it'),
    },
  },
  guard(({ rung, logic, comment }) => {
    const project = store.update((p) => updateRung(p, rung, { text: logic, comment: comment === '' ? null : comment }));
    return `${showRungs(project, [rung])}\n\n${validation(project)}`;
  }),
);

server.registerTool(
  'remove_rung',
  {
    title: 'Remove rung',
    description: 'Delete a rung by number. Later rungs move up by one.',
    inputSchema: { rung: z.number().int().min(1) },
  },
  guard(({ rung }) => {
    const project = store.update((p) => removeRung(p, rung));
    return `Removed rung ${rung}; ${project.rungs.length} rung(s) remain.\n\n${validation(project)}`;
  }),
);

server.registerTool(
  'move_rung',
  {
    title: 'Move rung',
    description: 'Move a rung to a new position. Order matters: rungs execute top to bottom each scan.',
    inputSchema: { rung: z.number().int().min(1), to: z.number().int().min(1).describe('New rung number') },
  },
  guard(({ rung, to }) => {
    const project = store.update((p) => moveRung(p, rung, to));
    return `Moved rung ${rung} to position ${to}.\n\n${project.rungs.map((r, i) => `${i + 1}. ${formatRung(r)}`).join('\n')}`;
  }),
);

server.registerTool(
  'validate_project',
  {
    title: 'Validate project',
    description: 'Check the project for errors (undeclared tags, type mismatches, missing block inputs) and warnings (duplicate coils, shared instances).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  guard(() => formatIssues(validate(store.load()))),
);

const scalar = z.union([z.boolean(), z.number(), z.string()]);

server.registerTool(
  'simulate',
  {
    title: 'Simulate a scenario',
    description:
      'Run the program in the scan-cycle simulator from power-on and check its behaviour. Each step applies tag values, runs for some simulated time, then checks expectations. ' +
      'Values are the input BITS: an NC-wired input (field_contact "NC") starts at true and goes false when its device is pressed or tripped. ' +
      'Expectations may name tags or block pins such as "T1.Q", "T1.ET", "C1.CV". Times may be numbers in ms or literals like "T#5s".',
    inputSchema: {
      steps: z
        .array(
          z.object({
            label: z.string().optional().describe('What this step represents, e.g. "press start"'),
            set: z.record(z.string(), scalar).optional().describe('Tag values to apply before running'),
            run_ms: z.number().min(0).optional().describe('Simulated time to run; omit for a single scan'),
            expect: z.record(z.string(), scalar).optional().describe('Values that must hold after running'),
          }),
        )
        .min(1),
      watch: z.array(z.string()).optional().describe('Tags or block pins to report at every step (default: outputs plus everything set or expected)'),
    },
    annotations: { readOnlyHint: true },
  },
  guard(({ steps, watch }) => {
    const project = store.load();
    const issues = validate(project);
    const result = formatScenarioResult(runScenario(project, steps, watch));
    return hasErrors(issues) ? `${result}\n\nThe project has validation errors, so this result is unreliable:\n${formatIssues(issues)}` : result;
  }),
);

server.registerTool(
  'export_plcopen',
  {
    title: 'Export PLCopen XML',
    description:
      'Write the project as a PLCopen XML (TC6 v2.01) file that PLC editors can open or import (OpenPLC Editor, Beremiz, CODESYS). Refuses while the project has validation errors unless force is true.',
    inputSchema: {
      path: z.string().optional().describe('Output file; default is <project name>.xml next to the project file'),
      force: z.boolean().optional().describe('Export even though validation reports errors'),
    },
  },
  guard(({ path: target, force }) => {
    const project = store.load();
    const issues = validate(project);
    if (hasErrors(issues) && !force) throw new OpError(`The project has validation errors; fix them or pass force: true.\n${formatIssues(issues)}`);
    const name = (project.name || 'project').replace(/[^A-Za-z0-9_-]+/g, '_');
    const file = path.resolve(path.dirname(store.path), target ?? `${name}.xml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, exportPlcopen(project));
    return `Exported ${project.rungs.length} rung(s) and ${project.tags.length} tag(s) to ${file}\n\n${formatIssues(issues)}`;
  }),
);

server.registerTool(
  'open_simulator',
  {
    title: 'Open simulator',
    description: 'Get the address of the live simulator front end, where the user can watch power flow, operate inputs and edit rungs and tags. Changes made there and here share one project file.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  guard(async () => {
    web ??= await startHttp(store, port);
    if (web) return `Simulator running at ${web.url} (project file ${store.path}).`;
    return `Port ${port} is already in use, most likely by another ladder-plc server. Try http://localhost:${port}; if that shows a different project, restart this server with LADDER_PORT set to a free port.`;
  }),
);

server.registerTool(
  'ladder_reference',
  {
    title: 'Ladder syntax reference',
    description: 'Rung text syntax and the list of supported timer, counter, compare and math blocks.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  guard(() => `${DSL_REFERENCE}\n\nBlocks:\n${blockReference()}`),
);

try {
  web = await startHttp(store, port);
  if (web) console.error(`ladder-plc simulator at ${web.url}`);
} catch (e) {
  console.error('Could not start the simulator web server:', e);
}
await server.connect(new StdioServerTransport());
console.error(`ladder-plc MCP server ready (project file ${store.path})`);
