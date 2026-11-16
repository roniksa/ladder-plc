// Editing operations on a project. Each returns a new project and throws
// OpError with a user-facing message when the request cannot be applied.
// Used by the MCP tools, the web editor's HTTP API and the browser-only editor.

import { renderLadder } from './ascii.js';
import { blockDef } from './blocks.js';
import { DslError, formatRung, parseRung } from './dsl.js';
import { formatValue, parseOperand, parseValue } from './literals.js';
import { DATA_TYPES, DataType, LogicNode, Project, Rung, Tag, findTag, newRungId, normalizeRung, walk } from './model.js';
import { formatIssues, identifierProblem, validate } from './validate.js';

export class OpError extends Error {}

export interface TagInput {
  name: string;
  type?: string;
  address?: string | null;
  initial?: unknown;
  comment?: string | null;
  fieldContact?: 'NO' | 'NC' | null;
}

const clone = (project: Project): Project => JSON.parse(JSON.stringify(project));

function rungAt(project: Project, number: number): Rung {
  const rung = project.rungs[number - 1];
  if (!Number.isInteger(number) || !rung) throw new OpError(`There is no rung ${number}; the project has ${project.rungs.length} rung(s)`);
  return rung;
}

function parse(text: string): ReturnType<typeof parseRung> {
  try {
    return parseRung(text);
  } catch (e) {
    if (e instanceof DslError) throw new OpError(`Cannot parse rung "${text}": ${e.message}`);
    throw e;
  }
}

/** Create or update tags. Fields left undefined keep their current value; null clears them. */
export function upsertTags(project: Project, inputs: TagInput[]): Project {
  const next = clone(project);
  for (const input of inputs) {
    const name = String(input.name ?? '').trim();
    const problem = identifierProblem(name);
    if (problem) throw new OpError(`Tag name "${name}" ${problem}`);
    const existing = findTag(next, name);
    const type = (input.type?.toUpperCase() ?? existing?.type ?? 'BOOL') as DataType;
    if (!DATA_TYPES.includes(type)) throw new OpError(`Tag "${name}": unsupported type "${input.type}" (use ${DATA_TYPES.join(', ')})`);
    const tag: Tag = existing ?? { name, type };
    tag.type = type;
    if (input.address !== undefined) {
      const address = input.address?.trim().toUpperCase();
      if (address) tag.address = address;
      else delete tag.address;
    }
    if (input.comment !== undefined) {
      if (input.comment) tag.comment = input.comment;
      else delete tag.comment;
    }
    if (input.fieldContact !== undefined) {
      if (input.fieldContact) tag.fieldContact = input.fieldContact;
      else delete tag.fieldContact;
    }
    if (input.initial !== undefined) {
      if (input.initial === null || input.initial === '') delete tag.initial;
      else {
        const value = parseValue(type, input.initial);
        if (value === undefined) throw new OpError(`Tag "${name}": "${String(input.initial)}" is not a valid ${type} initial value`);
        tag.initial = value;
      }
    } else if (tag.initial !== undefined && existing && input.type) {
      const value = parseValue(type, tag.initial);
      if (value === undefined) delete tag.initial;
      else tag.initial = value;
    }
    if (!existing) next.tags.push(tag);
  }
  return next;
}

/** Lower-cased names of every tag referenced by the program. */
export function usedTags(project: Project): Map<string, number[]> {
  const used = new Map<string, number[]>();
  const add = (name: string, rung: number) => {
    const key = name.toLowerCase();
    const list = used.get(key) ?? [];
    if (!list.includes(rung)) list.push(rung);
    used.set(key, list);
  };
  project.rungs.forEach((rung, i) => {
    walk(rung.logic, (node) => {
      if (node.kind === 'contact') add(node.tag, i + 1);
      else if (node.kind === 'block') {
        for (const text of [...Object.values(node.inputs), ...Object.values(node.outputs)]) {
          const operand = parseOperand(text, project);
          if (operand.kind === 'tag') add(operand.name, i + 1);
        }
      }
    });
    rung.coils.forEach((c) => add(c.tag, i + 1));
  });
  return used;
}

export function removeTag(project: Project, name: string): Project {
  const tag = findTag(project, name);
  if (!tag) throw new OpError(`There is no tag "${name}"`);
  const rungs = usedTags(project).get(tag.name.toLowerCase());
  if (rungs) throw new OpError(`Tag "${tag.name}" is still used in rung(s) ${rungs.join(', ')}; change those rungs first`);
  const next = clone(project);
  next.tags = next.tags.filter((t) => t.name !== tag.name);
  return next;
}

/** Rename a tag and every reference to it. */
export function renameTag(project: Project, from: string, to: string): Project {
  const tag = findTag(project, from);
  if (!tag) throw new OpError(`There is no tag "${from}"`);
  const problem = identifierProblem(to);
  if (problem) throw new OpError(`Tag name "${to}" ${problem}`);
  const clash = findTag(project, to);
  if (clash && clash !== tag) throw new OpError(`A tag named "${clash.name}" already exists`);
  const next = clone(project);
  const key = tag.name.toLowerCase();
  const swap = (text: string) => (text.toLowerCase() === key ? to : text);
  const mapValues = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).map(([k, v]) => [k, swap(v)]));
  const rename = (node: LogicNode) => {
    if (node.kind === 'contact') node.tag = swap(node.tag);
    else if (node.kind === 'block') {
      node.inputs = mapValues(node.inputs);
      node.outputs = mapValues(node.outputs);
    }
  };
  for (const rung of next.rungs) {
    walk(rung.logic, rename);
    rung.coils.forEach((c) => (c.tag = swap(c.tag)));
  }
  findTag(next, from)!.name = to;
  return next;
}

/** Insert a rung. `position` is the 1-based rung number it should take; omit to append. */
export function addRung(project: Project, text: string, comment?: string, position?: number): Project {
  const next = clone(project);
  const parsed = parse(text);
  const rung = normalizeRung({ id: newRungId(next), ...parsed, ...(comment ? { comment } : {}) });
  const index = position === undefined ? next.rungs.length : position - 1;
  if (!Number.isInteger(index) || index < 0 || index > next.rungs.length) throw new OpError(`Position ${position} is out of range (1 to ${next.rungs.length + 1})`);
  next.rungs.splice(index, 0, rung);
  return next;
}

export function updateRung(project: Project, number: number, change: { text?: string; comment?: string | null }): Project {
  const next = clone(project);
  const rung = rungAt(next, number);
  let updated: Rung = rung;
  if (change.text !== undefined) updated = normalizeRung({ ...rung, ...parse(change.text) });
  if (change.comment !== undefined) {
    updated = { ...updated };
    if (change.comment) updated.comment = change.comment;
    else delete updated.comment;
  }
  next.rungs[number - 1] = updated;
  return next;
}

export function removeRung(project: Project, number: number): Project {
  const next = clone(project);
  rungAt(next, number);
  next.rungs.splice(number - 1, 1);
  return next;
}

export function moveRung(project: Project, from: number, to: number): Project {
  const next = clone(project);
  rungAt(next, from);
  if (!Number.isInteger(to) || to < 1 || to > next.rungs.length) throw new OpError(`Target position ${to} is out of range (1 to ${next.rungs.length})`);
  const [rung] = next.rungs.splice(from - 1, 1);
  next.rungs.splice(to - 1, 0, rung);
  return next;
}

export function setProjectInfo(project: Project, info: { name?: string; description?: string | null; scanMs?: number }): Project {
  const next = clone(project);
  if (info.name !== undefined) {
    if (!info.name.trim()) throw new OpError('Project name must not be empty');
    next.name = info.name.trim();
  }
  if (info.description !== undefined) {
    if (info.description) next.description = info.description;
    else delete next.description;
  }
  if (info.scanMs !== undefined) {
    if (!(info.scanMs >= 1 && info.scanMs <= 10_000)) throw new OpError('Scan time must be between 1 and 10000 ms');
    next.scanMs = Math.round(info.scanMs);
  }
  return next;
}

/** Apply an editor operation by name. Arguments come from the browser, so they are checked here. */
export function applyOp(project: Project, op: string, args: Record<string, unknown>): Project {
  const str = (key: string): string => {
    if (typeof args[key] !== 'string') throw new OpError(`"${key}" must be text`);
    return args[key] as string;
  };
  const num = (key: string): number => {
    if (typeof args[key] !== 'number') throw new OpError(`"${key}" must be a number`);
    return args[key] as number;
  };
  const optStr = (key: string) => (args[key] === undefined || args[key] === null ? undefined : str(key));
  switch (op) {
    case 'upsert_tags':
      if (!Array.isArray(args.tags)) throw new OpError('"tags" must be a list');
      return upsertTags(project, args.tags);
    case 'remove_tag':
      return removeTag(project, str('name'));
    case 'rename_tag':
      return renameTag(project, str('name'), str('newName'));
    case 'add_rung':
      return addRung(project, str('text'), optStr('comment'), args.position === undefined ? undefined : num('position'));
    case 'update_rung':
      return updateRung(project, num('rung'), {
        text: optStr('text'),
        comment: args.comment === null ? null : optStr('comment'),
      });
    case 'remove_rung':
      return removeRung(project, num('rung'));
    case 'move_rung':
      return moveRung(project, num('rung'), num('to'));
    case 'set_info':
      return setProjectInfo(project, {
        name: optStr('name'),
        description: args.description === null ? null : optStr('description'),
        scanMs: args.scanMs === undefined ? undefined : num('scanMs'),
      });
    default:
      throw new OpError(`Unknown operation "${op}"`);
  }
}

/**
 * Check that parsed JSON is a project file and return it with rungs normalized.
 * `what` names the source in the error message.
 */
export function checkProject(data: unknown, what = 'This file'): Project {
  const fail = () => new OpError(`${what} is not a ladder-plc project file`);
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(data) || data.format !== 'ladder-plc/1' || !Array.isArray(data.tags) || !Array.isArray(data.rungs)) throw fail();
  for (const tag of data.tags) {
    if (!isObject(tag) || typeof tag.name !== 'string' || !DATA_TYPES.includes(tag.type as DataType)) throw fail();
  }
  for (const rung of data.rungs) {
    if (!isObject(rung) || !isObject(rung.logic) || !Array.isArray(rung.coils)) throw fail();
  }
  const project = data as unknown as Project;
  if (typeof project.name !== 'string' || !project.name.trim()) project.name = 'Untitled';
  if (!(project.scanMs >= 1 && project.scanMs <= 10_000)) project.scanMs = 20;
  try {
    project.rungs = project.rungs.map(normalizeRung);
    // Formatting and validating touch every element, so a damaged file fails here and not in the editor.
    project.rungs.forEach(formatRung);
    validate(project);
  } catch {
    throw fail();
  }
  return project;
}

function tagTable(project: Project): string {
  if (project.tags.length === 0) return '(no tags)';
  const used = usedTags(project);
  const rows = project.tags.map((t) => [
    t.name,
    t.type,
    t.address ?? '-',
    t.initial === undefined ? '-' : formatValue(t.type, t.initial),
    [t.fieldContact ? `${t.fieldContact}-wired device` : '', used.has(t.name.toLowerCase()) ? '' : 'unused', t.comment ?? ''].filter(Boolean).join('; '),
  ]);
  const header = ['Name', 'Type', 'Address', 'Initial', 'Notes'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [header, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

function instanceList(project: Project): string {
  const lines: string[] = [];
  project.rungs.forEach((rung, i) => {
    walk(rung.logic, (node) => {
      if (node.kind === 'block' && node.instance && blockDef(node.type)?.kind === 'fb') lines.push(`${node.instance}: ${node.type} (rung ${i + 1})`);
    });
  });
  return lines.join('\n');
}

/** Full text description of the project: tags, rung text, ladder diagram and validation result. */
export function describeProject(project: Project): string {
  const rungText = project.rungs.map((r, i) => `${i + 1}. ${formatRung(r)}${r.comment ? `    // ${r.comment}` : ''}`).join('\n') || '(no rungs)';
  const instances = instanceList(project);
  return [
    `Project: ${project.name}   (scan time ${project.scanMs} ms)`,
    ...(project.description ? [project.description] : []),
    '',
    'TAGS',
    tagTable(project),
    ...(instances ? ['', 'BLOCK INSTANCES', instances] : []),
    '',
    'RUNGS (text form)',
    rungText,
    '',
    'LADDER',
    renderLadder(project),
    '',
    'VALIDATION',
    formatIssues(validate(project)),
  ].join('\n');
}
