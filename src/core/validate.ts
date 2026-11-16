import { BLOCKS, PinType, blockDef } from './blocks.js';
import { parseOperand } from './literals.js';
import { DATA_TYPES, DataType, LogicNode, Project, Tag, findTag, walk } from './model.js';

export interface Issue {
  severity: 'error' | 'warning';
  /** 1-based rung number, when the issue belongs to a rung. */
  rung?: number;
  message: string;
}

const RESERVED = new Set(
  [
    'AND OR XOR NOT MOD TRUE FALSE IF THEN ELSE ELSIF END_IF CASE OF END_CASE FOR TO BY DO END_FOR WHILE END_WHILE',
    'REPEAT UNTIL END_REPEAT EXIT RETURN VAR VAR_INPUT VAR_OUTPUT VAR_IN_OUT VAR_GLOBAL VAR_EXTERNAL VAR_TEMP END_VAR',
    'CONSTANT RETAIN AT PROGRAM END_PROGRAM FUNCTION END_FUNCTION FUNCTION_BLOCK END_FUNCTION_BLOCK CONFIGURATION',
    'END_CONFIGURATION RESOURCE END_RESOURCE TASK WITH ON TYPE END_TYPE STRUCT END_STRUCT ARRAY EN ENO',
    'BOOL SINT INT DINT LINT USINT UINT UDINT ULINT REAL LREAL TIME DATE TOD DT STRING WSTRING BYTE WORD DWORD LWORD',
  ]
    .join(' ')
    .split(' '),
);

/** Returns a problem description, or undefined when the name is a legal IEC identifier. */
export function identifierProblem(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'must start with a letter or underscore and contain only letters, digits and underscores';
  if (name.includes('__')) return 'must not contain a double underscore';
  if (name.endsWith('_')) return 'must not end with an underscore';
  const upper = name.toUpperCase();
  if (RESERVED.has(upper)) return 'is a reserved IEC 61131-3 keyword';
  if (BLOCKS[upper]) return `is the name of the standard block ${upper}`;
  return undefined;
}

const ADDRESS = /^%([IQM])([XBWDL]?)(\d+(?:\.\d+)*)$/;

function addressProblem(tag: Tag): string | undefined {
  const m = ADDRESS.exec(tag.address ?? '');
  if (!m) return `address "${tag.address}" is not a valid IEC direct address (examples: %IX0.0, %QX0.1, %MW3)`;
  const size = m[2];
  const isBit = size === 'X' || (size === '' && m[3].includes('.'));
  if (isBit !== (tag.type === 'BOOL')) {
    return isBit ? `bit address ${tag.address} needs type BOOL, not ${tag.type}` : `BOOL needs a bit address such as %${m[1]}X0.0, not ${tag.address}`;
  }
  if (size === 'W' && tag.type !== 'INT') return `word address ${tag.address} holds 16 bits; use type INT, or a %${m[1]}D address for ${tag.type}`;
  if (size === 'D' && tag.type === 'INT') return `double-word address ${tag.address} holds 32 bits; use a %${m[1]}W address for INT`;
  return undefined;
}

type TypeClass = 'bool' | 'time' | 'num';
const classOf = (t: DataType): TypeClass => (t === 'BOOL' ? 'bool' : t === 'TIME' ? 'time' : 'num');

function pinAccepts(pin: PinType, type: DataType): boolean {
  switch (pin) {
    case 'BOOL':
      return type === 'BOOL';
    case 'TIME':
      return type === 'TIME';
    case 'INT':
      return type === 'INT' || type === 'DINT';
    case 'NUM':
      return classOf(type) === 'num';
    case 'ANY':
      return true;
  }
}

export function validate(project: Project): Issue[] {
  const issues: Issue[] = [];
  const error = (message: string, rung?: number) => issues.push({ severity: 'error', rung, message });
  const warn = (message: string, rung?: number) => issues.push({ severity: 'warning', rung, message });

  if (!(project.scanMs >= 1 && project.scanMs <= 10_000)) error(`Scan time ${project.scanMs} ms is out of range (1 to 10000 ms)`);

  // Tags
  const seenNames = new Map<string, string>();
  const seenAddresses = new Map<string, string>();
  for (const tag of project.tags) {
    const problem = identifierProblem(tag.name);
    if (problem) error(`Tag name "${tag.name}" ${problem}`);
    const key = tag.name.toLowerCase();
    if (seenNames.has(key)) error(`Tag "${tag.name}" is declared twice (IEC names are case-insensitive)`);
    seenNames.set(key, tag.name);
    if (!DATA_TYPES.includes(tag.type)) error(`Tag "${tag.name}" has unsupported type ${tag.type}`);
    if (tag.address) {
      const p = addressProblem(tag);
      if (p) error(`Tag "${tag.name}": ${p}`);
      const other = seenAddresses.get(tag.address);
      if (other) warn(`Tags "${other}" and "${tag.name}" share address ${tag.address}`);
      seenAddresses.set(tag.address, tag.name);
    }
    if (tag.fieldContact && !/^%I/.test(tag.address ?? '')) warn(`Tag "${tag.name}" has field wiring ${tag.fieldContact} but is not a physical input (%I address)`);
  }

  // Rungs
  const coilWriters = new Map<string, { rungs: Set<number>; modes: Set<string> }>();
  const instances = new Map<string, { type: string; rung: number }>();

  project.rungs.forEach((rung, index) => {
    const n = index + 1;
    let blockCount = 0;

    const boolTag = (name: string, what: string): Tag | undefined => {
      const tag = findTag(project, name);
      if (!tag) error(`${what} uses undeclared tag "${name}"`, n);
      else if (tag.type !== 'BOOL') error(`${what} needs a BOOL tag, but "${tag.name}" is ${tag.type}`, n);
      return tag;
    };

    const checkBlock = (node: Extract<LogicNode, { kind: 'block' }>) => {
      blockCount++;
      const def = blockDef(node.type);
      if (!def) {
        error(`Unknown block type "${node.type}"`, n);
        return;
      }
      const label = node.instance ? `${def.type} ${node.instance}` : def.type;
      if (def.kind === 'fb') {
        if (!node.instance) error(`${def.type} needs an instance name`, n);
        else {
          const problem = identifierProblem(node.instance);
          if (problem) error(`Instance name "${node.instance}" ${problem}`, n);
          if (findTag(project, node.instance)) error(`Instance name "${node.instance}" is already used by a tag`, n);
          const key = node.instance.toLowerCase();
          const prior = instances.get(key);
          if (prior && prior.type !== def.type) error(`Instance "${node.instance}" is a ${prior.type} in rung ${prior.rung} but used as ${def.type} here`, n);
          else if (prior) warn(`Instance "${node.instance}" is also called in rung ${prior.rung}; each timer or counter normally needs its own instance`, n);
          else instances.set(key, { type: def.type, rung: n });
        }
      }

      const usedTypes = new Set<DataType>();
      const classes = new Set<TypeClass>();
      for (const pin of def.inputs) {
        const text = node.inputs[pin.name];
        if (text === undefined) {
          if (pin.required) error(`${label}: input ${pin.name} is required`, n);
          continue;
        }
        const operand = parseOperand(text, project);
        if (operand.kind === 'error') {
          error(`${label}: input ${pin.name}: ${operand.message}`, n);
          continue;
        }
        if (!pinAccepts(pin.type, operand.type)) {
          error(`${label}: input ${pin.name} needs ${pin.type === 'NUM' ? 'a number' : pin.type === 'INT' ? 'an integer' : pin.type}, but ${text} is ${operand.type}`, n);
          continue;
        }
        classes.add(classOf(operand.type));
        if (operand.kind === 'tag') {
          usedTypes.add(operand.type);
          if (pin.type === 'INT' && operand.type !== 'INT') warn(`${label}: ${pin.name} is INT in the standard; "${operand.name}" is ${operand.type} and strict compilers will reject it`, n);
        }
      }
      for (const pin of def.outputs) {
        const text = node.outputs[pin.name];
        if (text === undefined) {
          if (pin.required) error(`${label}: output ${pin.name} must be assigned to a tag (${pin.name}=tag)`, n);
          continue;
        }
        const tag = findTag(project, text);
        if (!tag) {
          error(`${label}: output ${pin.name} must be a declared tag, not "${text}"`, n);
          continue;
        }
        if (!pinAccepts(pin.type, tag.type)) {
          error(`${label}: output ${pin.name} cannot be stored in ${tag.type} tag "${tag.name}"`, n);
          continue;
        }
        if (/^%I/.test(tag.address ?? '')) error(`${label}: output ${pin.name} writes to physical input "${tag.name}"`, n);
        classes.add(classOf(tag.type));
        usedTypes.add(tag.type);
        if (pin.type === 'INT' && tag.type !== 'INT') warn(`${label}: ${pin.name} is INT in the standard; "${tag.name}" is ${tag.type} and strict compilers will reject it`, n);
      }
      for (const name of Object.keys(node.inputs)) if (!def.inputs.some((p) => p.name === name)) error(`${label} has no input pin "${name}"`, n);
      for (const name of Object.keys(node.outputs)) if (!def.outputs.some((p) => p.name === name)) error(`${label} has no output pin "${name}"`, n);

      if (def.kind === 'fn') {
        if (classes.size > 1) error(`${label}: operands mix ${[...classes].join(' and ')} values`, n);
        else if (usedTypes.size > 1) warn(`${label}: operands mix ${[...usedTypes].join(' and ')}; strict IEC compilers need all operands to have the same type`, n);
      }
    };

    walk(rung.logic, (node) => {
      if (node.kind === 'contact') boolTag(node.tag, 'Contact');
      else if (node.kind === 'block') checkBlock(node);
      else if (node.kind === 'parallel' && node.branches.some((b) => b.kind === 'series' && b.items.length === 0)) {
        warn('A parallel branch is a plain wire, which bypasses the other branches', n);
      }
    });

    for (const coil of rung.coils) {
      const tag = boolTag(coil.tag, 'Coil');
      if (!tag) continue;
      if (/^%I/.test(tag.address ?? '')) error(`Coil writes to physical input "${tag.name}" (${tag.address})`, n);
      const key = tag.name.toLowerCase();
      const entry = coilWriters.get(key) ?? { rungs: new Set<number>(), modes: new Set<string>() };
      entry.rungs.add(n);
      entry.modes.add(coil.mode === 'set' || coil.mode === 'reset' ? 'latch' : 'direct');
      coilWriters.set(key, entry);
    }

    if (rung.coils.length === 0 && blockCount === 0) error('Rung has no output: add a coil after "->" or a block', n);
  });

  for (const [key, entry] of coilWriters) {
    const name = seenNames.get(key) ?? key;
    const rungs = [...entry.rungs].join(', ');
    if (entry.modes.has('direct') && entry.modes.has('latch')) {
      warn(`"${name}" is driven by both an ordinary coil and set/reset coils (rungs ${rungs}); the ordinary coil overwrites the latch every scan`);
    } else if (entry.modes.has('direct') && entry.rungs.size > 1) {
      warn(`"${name}" is driven by ordinary coils in rungs ${rungs}; only the last one takes effect each scan`);
    }
  }

  return issues;
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export function formatIssues(issues: Issue[]): string {
  if (issues.length === 0) return 'No issues.';
  return issues.map((i) => `${i.severity.toUpperCase()}${i.rung ? ` (rung ${i.rung})` : ''}: ${i.message}`).join('\n');
}
