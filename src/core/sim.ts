// Scan-cycle simulator. Each scan solves the rungs top to bottom, left to
// right, updating memory immediately, exactly as an IEC 61131-3 PLC does.

import { blockDef } from './blocks.js';
import { coerce, defaultValue, parseOperand, parseValue } from './literals.js';
import { Block, Coil, DataType, LogicNode, Project, Tag, Value } from './model.js';

export interface Flow {
  /** Power arriving at the element's left side. */
  in: boolean;
  /** Power leaving the element's right side (for a coil: the resulting bit). */
  out: boolean;
  /** For contacts: whether the contact itself is closed, regardless of power. */
  closed?: boolean;
}

export interface FbState {
  Q: boolean;
  ET: number;
  CV: number;
  /** Previous value of the power input, for edge detection. */
  prev: boolean;
  running: boolean;
  M: boolean;
}

export interface SimState {
  timeMs: number;
  scans: number;
  /** Current value of every tag, keyed by tag name. */
  vars: Record<string, Value>;
  /** Function block instance memory, keyed by instance name. */
  fb: Record<string, FbState>;
  /** Previous tag value seen by each edge contact, keyed by element id. */
  edges: Record<string, boolean>;
  /** Power flow of the last scan, keyed by element id. */
  flow: Record<string, Flow>;
}

export function initialValue(tag: Tag): Value {
  if (tag.initial !== undefined) return coerce(tag.type, tag.initial);
  if (tag.type === 'BOOL' && tag.fieldContact === 'NC') return true;
  return defaultValue(tag.type);
}

/**
 * Create a simulation in its power-on state. Pass `keep` to carry tag values
 * and block memory over from a previous state after the program was edited.
 */
export function createSim(project: Project, keep?: SimState): SimState {
  const vars: Record<string, Value> = {};
  for (const tag of project.tags) {
    const old = keep?.vars[tag.name];
    const sameType = old !== undefined && (typeof old === 'boolean') === (tag.type === 'BOOL');
    vars[tag.name] = sameType ? coerce(tag.type, old) : initialValue(tag);
  }
  return {
    timeMs: keep?.timeMs ?? 0,
    scans: keep?.scans ?? 0,
    vars,
    fb: keep ? { ...keep.fb } : {},
    edges: keep ? { ...keep.edges } : {},
    flow: {},
  };
}

export function setVar(project: Project, state: SimState, name: string, input: unknown): string | undefined {
  const tag = project.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!tag) return `Unknown tag "${name}"`;
  const value = parseValue(tag.type, input);
  if (value === undefined) return `"${String(input)}" is not a valid ${tag.type} value for "${tag.name}"`;
  state.vars[tag.name] = value;
  return undefined;
}

export interface Ref {
  type: DataType;
  value: Value;
}

/** Read a tag ("motor") or a block pin ("T1.Q", "T1.ET", "C1.CV"). */
export function readRef(project: Project, state: SimState, ref: string): Ref | undefined {
  const [name, pin] = ref.split('.');
  if (pin === undefined) {
    const tag = project.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    return tag ? { type: tag.type, value: state.vars[tag.name] } : undefined;
  }
  const key = Object.keys(state.fb).find((k) => k.toLowerCase() === name.toLowerCase());
  const fb = key ? state.fb[key] : { Q: false, ET: 0, CV: 0 };
  switch (pin.toUpperCase()) {
    case 'Q':
    case 'Q1':
      return { type: 'BOOL', value: fb.Q };
    case 'ET':
      return { type: 'TIME', value: fb.ET };
    case 'CV':
      return { type: 'INT', value: fb.CV };
  }
  return undefined;
}

const COMPARE: Record<string, (a: number, b: number) => boolean> = {
  EQ: (a, b) => a === b,
  NE: (a, b) => a !== b,
  GT: (a, b) => a > b,
  GE: (a, b) => a >= b,
  LT: (a, b) => a < b,
  LE: (a, b) => a <= b,
};

const MATH: Record<string, (a: number, b: number) => number> = {
  ADD: (a, b) => a + b,
  SUB: (a, b) => a - b,
  MUL: (a, b) => a * b,
  DIV: (a, b) => a / b,
};

/** Run one scan, advancing simulated time by `dtMs` (default: the project's scan time). */
export function scan(project: Project, state: SimState, dtMs: number = project.scanMs): void {
  state.timeMs += dtMs;
  state.scans++;
  state.flow = {};
  const tags = new Map(project.tags.map((t) => [t.name.toLowerCase(), t]));
  const tagOf = (name: string) => tags.get(name.toLowerCase());

  const read = (text: string | undefined): Value | undefined => {
    if (text === undefined) return undefined;
    const operand = parseOperand(text, project);
    if (operand.kind === 'literal') return operand.value;
    if (operand.kind === 'tag') return state.vars[operand.name];
    return undefined;
  };
  const write = (name: string | undefined, value: Value) => {
    const tag = name === undefined ? undefined : tagOf(name);
    if (tag) state.vars[tag.name] = coerce(tag.type, value);
  };

  const evalFunction = (node: Block, en: boolean): boolean => {
    const type = node.type.toUpperCase();
    if (!en) return false;
    if (type === 'MOVE') {
      const value = read(node.inputs.IN);
      if (value === undefined) return false;
      write(node.outputs.OUT, value);
      return true;
    }
    const a = read(node.inputs.IN1);
    const b = read(node.inputs.IN2);
    if (a === undefined || b === undefined) return false;
    if (COMPARE[type]) return COMPARE[type](Number(a), Number(b));
    if (MATH[type]) {
      if (type === 'DIV' && Number(b) === 0) return false;
      write(node.outputs.OUT, MATH[type](Number(a), Number(b)));
      return true;
    }
    return false;
  };

  const evalFb = (node: Block, power: boolean): boolean => {
    const type = node.type.toUpperCase();
    const key = node.instance ?? node.id;
    const s = (state.fb[key] ??= { Q: false, ET: 0, CV: 0, prev: false, running: false, M: false });
    const rising = power && !s.prev;
    const pt = Math.max(0, Number(read(node.inputs.PT) ?? 0));
    const pv = Number(read(node.inputs.PV) ?? 0);
    switch (type) {
      case 'TON':
        s.ET = power ? (rising ? 0 : Math.min(s.ET + dtMs, pt)) : 0;
        s.Q = power && s.ET >= pt;
        break;
      case 'TOF':
        if (power) {
          s.Q = true;
          s.ET = 0;
        } else if (s.Q) {
          s.ET = s.prev ? 0 : Math.min(s.ET + dtMs, pt);
          if (s.ET >= pt) s.Q = false;
        }
        break;
      case 'TP':
        if (s.running) {
          s.ET = Math.min(s.ET + dtMs, pt);
          if (s.ET >= pt) {
            s.running = false;
            s.Q = false;
          }
        } else if (rising && pt > 0) {
          s.running = true;
          s.Q = true;
          s.ET = 0;
        }
        if (!s.running && !power) s.ET = 0;
        break;
      case 'CTU':
        if (read(node.inputs.R) === true) s.CV = 0;
        else if (rising && s.CV < 32767) s.CV++;
        s.Q = s.CV >= pv;
        break;
      case 'CTD':
        if (read(node.inputs.LD) === true) s.CV = coerce('INT', pv) as number;
        else if (rising && s.CV > -32768) s.CV--;
        s.Q = s.CV <= 0;
        break;
      case 'R_TRIG':
        s.Q = power && !s.M;
        s.M = power;
        break;
      case 'F_TRIG':
        // As defined by the standard: M starts FALSE, so a pulse occurs on the
        // first scan if the input is already off.
        s.Q = !power && !s.M;
        s.M = !power;
        break;
      case 'SR':
        s.Q = power || (read(node.inputs.R) !== true && s.Q);
        break;
      case 'RS':
        s.Q = read(node.inputs.R1) !== true && (power || s.Q);
        break;
      default:
        s.Q = false;
    }
    s.prev = power;
    if (node.outputs.ET !== undefined) write(node.outputs.ET, s.ET);
    if (node.outputs.CV !== undefined) write(node.outputs.CV, s.CV);
    return s.Q;
  };

  const evalNode = (node: LogicNode, power: boolean): boolean => {
    let out: boolean;
    let closed: boolean | undefined;
    switch (node.kind) {
      case 'contact': {
        const tag = tagOf(node.tag);
        const value = tag ? Boolean(state.vars[tag.name]) : false;
        // Edge memory starts FALSE, so a bit that is already on at power-up
        // counts as a rising edge; a bit that is off does not count as falling.
        const prev = state.edges[node.id] ?? (node.mode === 'P' ? false : value);
        state.edges[node.id] = value;
        closed = node.mode === 'NO' ? value : node.mode === 'NC' ? !value : node.mode === 'P' ? value && !prev : !value && prev;
        out = power && closed;
        break;
      }
      case 'block': {
        const def = blockDef(node.type);
        out = !def ? false : def.kind === 'fb' ? evalFb(node, power) : evalFunction(node, power);
        break;
      }
      case 'series':
        out = power;
        for (const item of node.items) out = evalNode(item, out);
        break;
      case 'parallel':
        out = false;
        // Every branch is evaluated (no short-circuit) so blocks always run.
        for (const branch of node.branches) out = evalNode(branch, power) || out;
        break;
    }
    state.flow[node.id] = closed === undefined ? { in: power, out } : { in: power, out, closed };
    return out;
  };

  const execCoil = (coil: Coil, power: boolean) => {
    const tag = tagOf(coil.tag);
    if (tag) {
      if (coil.mode === 'normal') state.vars[tag.name] = power;
      else if (coil.mode === 'negated') state.vars[tag.name] = !power;
      else if (coil.mode === 'set' && power) state.vars[tag.name] = true;
      else if (coil.mode === 'reset' && power) state.vars[tag.name] = false;
    }
    state.flow[coil.id] = { in: power, out: tag ? Boolean(state.vars[tag.name]) : false };
  };

  for (const rung of project.rungs) {
    const power = evalNode(rung.logic, true);
    for (const coil of rung.coils) execCoil(coil, power);
  }
}

/** Run scans until `ms` of simulated time has passed (at least one scan). */
export function runFor(project: Project, state: SimState, ms: number): void {
  const scans = Math.max(1, Math.ceil(ms / project.scanMs));
  for (let i = 0; i < scans; i++) scan(project, state);
}
