// Neutral project model for IEC 61131-3 ladder diagrams.
// This module (and everything under core/) must stay free of Node and DOM
// imports: it is loaded by the MCP server and by the browser front end.

export type DataType = 'BOOL' | 'INT' | 'DINT' | 'REAL' | 'TIME';
export const DATA_TYPES: DataType[] = ['BOOL', 'INT', 'DINT', 'REAL', 'TIME'];

/** BOOL → boolean; INT/DINT/REAL → number; TIME → milliseconds. */
export type Value = boolean | number;

export interface Tag {
  name: string;
  type: DataType;
  /** IEC direct address, e.g. %IX0.0 (input bit), %QX0.0 (output bit), %MW2. */
  address?: string;
  initial?: Value;
  comment?: string;
  /**
   * How the field device on a physical input is wired. An NC-wired device
   * (e.g. a stop button or overload contact) holds its input bit at 1 until
   * it is actuated, so the simulator starts it at TRUE.
   */
  fieldContact?: 'NO' | 'NC';
}

/** NO = normally open, NC = normally closed, P/N = rising/falling edge. */
export type ContactMode = 'NO' | 'NC' | 'P' | 'N';
export type CoilMode = 'normal' | 'negated' | 'set' | 'reset';

export interface Contact {
  kind: 'contact';
  id: string;
  tag: string;
  mode: ContactMode;
}

/** A function block (TON, CTU, ...) or function (GT, ADD, ...) placed inline in a rung. */
export interface Block {
  kind: 'block';
  id: string;
  type: string;
  /** Instance name; required for function blocks, absent for functions. */
  instance?: string;
  /** Non-power input pins → operand text (tag name or literal). */
  inputs: Record<string, string>;
  /** Non-power output pins → tag name. */
  outputs: Record<string, string>;
}

export interface Series {
  kind: 'series';
  id: string;
  items: LogicNode[];
}

export interface Parallel {
  kind: 'parallel';
  id: string;
  branches: LogicNode[];
}

export type LogicNode = Contact | Block | Series | Parallel;

export interface Coil {
  kind: 'coil';
  id: string;
  tag: string;
  mode: CoilMode;
}

export interface Rung {
  id: string;
  comment?: string;
  logic: LogicNode;
  /** Coils at the right-hand end of the rung, all driven by the logic result. */
  coils: Coil[];
}

export interface Project {
  format: 'ladder-plc/1';
  name: string;
  description?: string;
  /** Scan (task) interval in milliseconds. */
  scanMs: number;
  tags: Tag[];
  rungs: Rung[];
}

export function emptyProject(name = 'Untitled'): Project {
  return { format: 'ladder-plc/1', name, scanMs: 20, tags: [], rungs: [] };
}

export function findTag(project: Project, name: string): Tag | undefined {
  const key = name.toLowerCase();
  return project.tags.find((t) => t.name.toLowerCase() === key);
}

/** Visit every node of a rung's logic tree in pre-order. */
export function walk(node: LogicNode, visit: (n: LogicNode) => void): void {
  visit(node);
  if (node.kind === 'series') node.items.forEach((n) => walk(n, visit));
  else if (node.kind === 'parallel') node.branches.forEach((n) => walk(n, visit));
}

/**
 * Flatten nested series/parallel nodes and assign stable pre-order ids
 * (`<rungId>:<n>`), so that the same structure always yields the same ids.
 */
export function normalizeRung(rung: Rung): Rung {
  let n = 0;
  const nextId = () => `${rung.id}:${n++}`;

  const norm = (node: LogicNode): LogicNode => {
    if (node.kind === 'series') {
      const items: LogicNode[] = [];
      for (const child of node.items.map(norm)) {
        if (child.kind === 'series') items.push(...child.items);
        else items.push(child);
      }
      return items.length === 1 ? items[0] : { ...node, items };
    }
    if (node.kind === 'parallel') {
      const branches: LogicNode[] = [];
      for (const child of node.branches.map(norm)) {
        if (child.kind === 'parallel') branches.push(...child.branches);
        else branches.push(child);
      }
      return branches.length === 1 ? branches[0] : { ...node, branches };
    }
    return node;
  };

  const number = (node: LogicNode): LogicNode => {
    const id = nextId();
    if (node.kind === 'series') return { ...node, id, items: node.items.map(number) };
    if (node.kind === 'parallel') return { ...node, id, branches: node.branches.map(number) };
    return { ...node, id };
  };

  const logic = number(norm(rung.logic));
  const coils = rung.coils.map((c) => ({ ...c, id: nextId() }));
  return { ...rung, logic, coils };
}

export function newRungId(project: Project): string {
  const used = new Set(project.rungs.map((r) => r.id));
  let i = project.rungs.length + 1;
  while (used.has(`r${i}`)) i++;
  return `r${i}`;
}
