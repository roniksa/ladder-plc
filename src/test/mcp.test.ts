// End-to-end test: start the MCP server as a child process and drive it
// through a real MCP client, the way a chat application would.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../server/mcp.js', import.meta.url));

test('MCP tools build, simulate and export a project', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-plc-'));
  const projectFile = path.join(dir, 'project.ladder.json');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...(process.env as Record<string, string>), LADDER_PROJECT: projectFile, LADDER_PORT: '47917' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text).join('\n'), isError: Boolean(result.isError) };
  };

  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ['get_project', 'new_project', 'set_tags', 'add_rungs', 'update_rung', 'simulate', 'export_plcopen', 'open_simulator']) {
      assert.ok(tools.includes(name), `missing tool ${name}`);
    }
    assert.match(client.getInstructions() ?? '', /Rung text syntax/);

    assert.equal((await call('new_project', { name: 'Pump' })).isError, false);
    const tags = await call('set_tags', {
      tags: [
        { name: 'start_pb', address: '%IX0.0', field_contact: 'NO', comment: 'Start pushbutton' },
        { name: 'stop_pb', address: '%IX0.1', field_contact: 'NC', comment: 'Stop pushbutton' },
        { name: 'pump', address: '%QX0.0' },
      ],
    });
    assert.match(tags.text, /No issues/);

    const bad = await call('add_rungs', { rungs: [{ logic: 'start_pb & & -> pump' }] });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Cannot parse rung/);

    const added = await call('add_rungs', { rungs: [{ logic: '(start_pb | pump) & stop_pb -> pump', comment: 'Seal-in' }, { logic: 'ghost -> pump' }] });
    assert.match(added.text, /-\| \|-/);
    assert.match(added.text, /ERROR \(rung 2\): Contact uses undeclared tag "ghost"/);

    const refused = await call('export_plcopen');
    assert.equal(refused.isError, true);
    assert.equal((await call('remove_rung', { rung: 2 })).isError, false);

    const sim = await call('simulate', {
      steps: [
        { label: 'press start', set: { start_pb: true }, expect: { pump: true } },
        { label: 'release start', set: { start_pb: false }, run_ms: 200, expect: { pump: true } },
        { label: 'press stop', set: { stop_pb: false }, expect: { pump: false } },
      ],
    });
    assert.match(sim.text, /^PASSED/);

    const failing = await call('simulate', { steps: [{ set: { start_pb: true }, expect: { pump: false } }] });
    assert.match(failing.text, /^FAILED/);
    assert.match(failing.text, /pump is TRUE, expected FALSE/);

    const exported = await call('export_plcopen');
    assert.equal(exported.isError, false);
    const xml = fs.readFileSync(path.join(dir, 'Pump.xml'), 'utf8');
    assert.match(xml, /<pou name="program0" pouType="program">/);

    const overwrite = await call('new_project', { name: 'Other' });
    assert.equal(overwrite.isError, true);
    assert.match((await call('get_project')).text, /1\. \(start_pb \| pump\) & stop_pb -> pump/);

    const simulator = await call('open_simulator');
    assert.match(simulator.text, /localhost:47917/);
    const served = await (await fetch('http://localhost:47917/api/project')).json();
    assert.equal(served.project.name, 'Pump');
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
