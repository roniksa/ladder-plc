import { DataType, Project, Value, findTag } from './model.js';

const TIME_UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

/** Parse an IEC duration literal such as T#5s, T#1m30s or TIME#250ms into milliseconds. */
export function parseTime(text: string): number | undefined {
  const m = /^(?:T|TIME)#(-?)(.+)$/i.exec(text.trim());
  if (!m) return undefined;
  const body = m[2].replace(/_/g, '').toLowerCase();
  const part = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/y;
  let total = 0;
  let pos = 0;
  while (pos < body.length) {
    part.lastIndex = pos;
    const p = part.exec(body);
    if (!p) return undefined;
    total += parseFloat(p[1]) * TIME_UNITS[p[2]];
    pos = part.lastIndex;
  }
  if (pos === 0) return undefined;
  return Math.round(m[1] ? -total : total);
}

export function formatTime(ms: number): string {
  let rest = Math.round(Math.abs(ms));
  if (rest === 0) return 'T#0ms';
  let out = '';
  for (const unit of ['d', 'h', 'm', 's', 'ms']) {
    const size = TIME_UNITS[unit];
    const count = Math.floor(rest / size);
    if (count > 0) {
      out += `${count}${unit}`;
      rest -= count * size;
    }
  }
  return `T#${ms < 0 ? '-' : ''}${out}`;
}

export type Operand =
  | { kind: 'tag'; name: string; type: DataType }
  | { kind: 'literal'; type: DataType; value: Value }
  | { kind: 'error'; message: string };

/** Resolve operand text to a declared tag or a literal. Integer literals are typed DINT. */
export function parseOperand(text: string, project: Project): Operand {
  const t = text.trim();
  if (/^true$/i.test(t)) return { kind: 'literal', type: 'BOOL', value: true };
  if (/^false$/i.test(t)) return { kind: 'literal', type: 'BOOL', value: false };
  if (/^-?\d+$/.test(t)) return { kind: 'literal', type: 'DINT', value: parseInt(t, 10) };
  if (/^-?\d+\.\d+(e[-+]?\d+)?$/i.test(t)) return { kind: 'literal', type: 'REAL', value: parseFloat(t) };
  if (/^(T|TIME)#/i.test(t)) {
    const ms = parseTime(t);
    return ms === undefined ? { kind: 'error', message: `"${t}" is not a valid TIME literal` } : { kind: 'literal', type: 'TIME', value: ms };
  }
  const tag = findTag(project, t);
  if (tag) return { kind: 'tag', name: tag.name, type: tag.type };
  return { kind: 'error', message: `"${t}" is not a declared tag or a literal` };
}

/** Convert a JS value to the storage form of an IEC type (wrapping integers as a PLC does). */
export function coerce(type: DataType, value: Value): Value {
  switch (type) {
    case 'BOOL':
      return Boolean(value);
    case 'INT':
      return (Math.trunc(Number(value)) << 16) >> 16;
    case 'DINT':
      return Math.trunc(Number(value)) | 0;
    case 'REAL':
      return Math.fround(Number(value));
    case 'TIME':
      return Math.trunc(Number(value));
  }
}

export function defaultValue(type: DataType): Value {
  return type === 'BOOL' ? false : 0;
}

/** Accept loose user input (true/"TRUE"/1, 5, "T#5s") for a value of the given type. */
export function parseValue(type: DataType, input: unknown): Value | undefined {
  if (typeof input === 'boolean') return coerce(type, input);
  if (typeof input === 'number' && Number.isFinite(input)) return coerce(type, input);
  if (typeof input !== 'string') return undefined;
  const t = input.trim();
  if (type === 'BOOL') {
    if (/^(true|1|on)$/i.test(t)) return true;
    if (/^(false|0|off)$/i.test(t)) return false;
    return undefined;
  }
  if (type === 'TIME') {
    const ms = parseTime(t);
    if (ms !== undefined) return ms;
  }
  const n = Number(t);
  return t !== '' && Number.isFinite(n) ? coerce(type, n) : undefined;
}

export function formatValue(type: DataType, value: Value): string {
  if (type === 'BOOL') return value ? 'TRUE' : 'FALSE';
  if (type === 'TIME') return formatTime(Number(value));
  if (type === 'REAL') return String(Number(Number(value).toPrecision(7)));
  return String(value);
}
