// Grid layout of a rung: every contact, block and coil gets a cell, and the
// connecting wires are emitted as straight segments in cell coordinates.
// The SVG renderer and the PLCopen exporter both build on this.

import { blockDef } from './blocks.js';
import { Block, Coil, Contact, LogicNode, Rung } from './model.js';

export interface Cell {
  node: Contact | Block | Coil;
  col: number;
  row: number;
  w: number;
  h: number;
}

/** A wire segment. Horizontal when y1 === y2 (a row's wire line), else vertical on a column boundary. */
export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The wire carries the `side` signal of the node with this id. */
  id: string;
  side: 'in' | 'out';
}

export interface RungLayout {
  cells: Cell[];
  segs: Seg[];
  /** Columns taken by the logic; coils sit in column `logicCols`. */
  logicCols: number;
  rows: number;
}

export const BLOCK_COLS = 2;
export const PIN_PITCH = 30;

/** Number of pin rows a block shows (power pins included). */
export function blockPins(block: Block): number {
  const def = blockDef(block.type);
  return def ? Math.max(def.xmlInputs.length, def.xmlOutputs.length) : 1;
}

/** Grid rows a block occupies. */
export function blockRows(block: Block): number {
  return blockPins(block) <= 1 ? 1 : 2;
}

export function measure(node: LogicNode): { w: number; h: number } {
  switch (node.kind) {
    case 'contact':
      return { w: 1, h: 1 };
    case 'block':
      return { w: BLOCK_COLS, h: blockRows(node) };
    case 'series': {
      const sizes = node.items.map(measure);
      return { w: sizes.reduce((sum, s) => sum + s.w, 0), h: Math.max(1, ...sizes.map((s) => s.h)) };
    }
    case 'parallel': {
      const sizes = node.branches.map(measure);
      return { w: Math.max(0, ...sizes.map((s) => s.w)), h: sizes.reduce((sum, s) => sum + s.h, 0) };
    }
  }
}

/** Lay out a rung. Pass `logicCols` to stretch the logic so coils line up across rungs. */
export function layoutRung(rung: Rung, logicCols?: number): RungLayout {
  const cells: Cell[] = [];
  const segs: Seg[] = [];
  const size = measure(rung.logic);
  const cols = Math.max(1, size.w, logicCols ?? 0);

  const place = (node: LogicNode, col: number, row: number, width: number): void => {
    switch (node.kind) {
      case 'contact':
      case 'block': {
        const { w, h } = measure(node);
        cells.push({ node, col, row, w, h });
        if (width > w) segs.push({ x1: col + w, y1: row, x2: col + width, y2: row, id: node.id, side: 'out' });
        break;
      }
      case 'series': {
        let x = col;
        for (const item of node.items) {
          const w = measure(item).w;
          place(item, x, row, w);
          x += w;
        }
        if (col + width > x) segs.push({ x1: x, y1: row, x2: col + width, y2: row, id: node.id, side: 'out' });
        break;
      }
      case 'parallel': {
        let r = row;
        let last = row;
        for (const branch of node.branches) {
          place(branch, col, r, width);
          last = r;
          r += measure(branch).h;
        }
        segs.push({ x1: col, y1: row, x2: col, y2: last, id: node.id, side: 'in' });
        segs.push({ x1: col + width, y1: row, x2: col + width, y2: last, id: node.id, side: 'out' });
        break;
      }
    }
  };

  place(rung.logic, 0, 0, cols);
  rung.coils.forEach((coil, i) => cells.push({ node: coil, col: cols, row: i, w: 1, h: 1 }));
  if (rung.coils.length > 1) segs.push({ x1: cols, y1: 0, x2: cols, y2: rung.coils.length - 1, id: rung.logic.id, side: 'out' });

  return { cells, segs, logicCols: cols, rows: Math.max(size.h, rung.coils.length, 1) };
}

/** Widest logic section across the project, so every rung's coils share a column. */
export function commonLogicCols(rungs: Rung[]): number {
  return Math.max(1, ...rungs.map((r) => measure(r.logic).w));
}
