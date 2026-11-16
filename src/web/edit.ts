// Structural edits on a rung's logic tree, used by the element popover.
// Each returns the new rung text, which is then saved through the API.

import { formatRung } from '../core/dsl.js';
import { Coil, LogicNode, Rung } from '../core/model.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Replace the node with the given id; `change` may return null to delete it. */
function mapNode(node: LogicNode, id: string, change: (node: LogicNode) => LogicNode | null): LogicNode | null {
  if (node.id === id) return change(node);
  if (node.kind === 'series') {
    const items = node.items.map((n) => mapNode(n, id, change)).filter((n): n is LogicNode => n !== null);
    // A series emptied by a deletion disappears instead of becoming a bare wire.
    return items.length === 0 && node.items.length > 0 ? null : { ...node, items };
  }
  if (node.kind === 'parallel') {
    const branches = node.branches.map((n) => mapNode(n, id, change)).filter((n): n is LogicNode => n !== null);
    return branches.length === 0 ? null : { ...node, branches };
  }
  return node;
}

function withLogic(rung: Rung, id: string, change: (node: LogicNode) => LogicNode | null): string {
  const logic = mapNode(clone(rung.logic), id, change) ?? { kind: 'series', id: '', items: [] };
  return formatRung({ logic, coils: rung.coils });
}

export function changeNode(rung: Rung, id: string, patch: Partial<LogicNode>): string {
  return withLogic(rung, id, (node) => ({ ...node, ...patch }) as LogicNode);
}

export function deleteNode(rung: Rung, id: string): string {
  return withLogic(rung, id, () => null);
}

export function insertSeries(rung: Rung, id: string, tag: string): string {
  return withLogic(rung, id, (node) => ({ kind: 'series', id: '', items: [node, { kind: 'contact', id: '', tag, mode: 'NO' }] }));
}

export function insertParallel(rung: Rung, id: string, tag: string): string {
  return withLogic(rung, id, (node) => ({ kind: 'parallel', id: '', branches: [node, { kind: 'contact', id: '', tag, mode: 'NO' }] }));
}

export function changeCoil(rung: Rung, id: string, patch: Partial<Coil>): string {
  return formatRung({ logic: rung.logic, coils: rung.coils.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
}

export function deleteCoil(rung: Rung, id: string): string {
  return formatRung({ logic: rung.logic, coils: rung.coils.filter((c) => c.id !== id) });
}

export function addCoil(rung: Rung, tag: string): string {
  return formatRung({ logic: rung.logic, coils: [...rung.coils, { kind: 'coil', id: '', tag, mode: 'normal' }] });
}

/** Find a logic node or coil by id. */
export function findElement(rung: Rung, id: string): LogicNode | Coil | undefined {
  const coil = rung.coils.find((c) => c.id === id);
  if (coil) return coil;
  let found: LogicNode | undefined;
  const visit = (node: LogicNode) => {
    if (node.id === id) found = node;
    else if (node.kind === 'series') node.items.forEach(visit);
    else if (node.kind === 'parallel') node.branches.forEach(visit);
  };
  visit(rung.logic);
  return found;
}
