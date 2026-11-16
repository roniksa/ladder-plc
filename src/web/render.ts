// SVG drawing of a rung. The markup is static; live state is applied
// afterwards by toggling classes on elements tagged with data-sig / data-el.

import { blockDef } from '../core/blocks.js';
import { BLOCK_COLS, Cell, PIN_PITCH, layoutRung } from '../core/layout.js';
import { Block, Coil, Contact, Project, Rung, findTag } from '../core/model.js';

const CW = 112;
const RH = 72;
const WIRE = 40;
const RAIL = 14;
const X0 = 34;
const BODY_W = 96;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const cellX = (col: number) => X0 + col * CW;
const wireY = (row: number) => WIRE + row * RH;

function wire(x1: number, y1: number, x2: number, y2: number, id: string, side: 'in' | 'out'): string {
  return `<line class="wire" data-sig="${id}:${side}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
}

function label(text: string, x: number, y: number, cls: string, max: number, anchor = 'middle'): string {
  return `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(clip(text, max))}<title>${esc(text)}</title></text>`;
}

function hit(cell: Cell): string {
  return `<rect class="hit" x="${cellX(cell.col) + 3}" y="${wireY(cell.row) - WIRE + 3}" width="${cell.w * CW - 6}" height="${RH - 6}" rx="6"/>`;
}

function contactSvg(node: Contact, cell: Cell, project: Project): string {
  const x = cellX(cell.col);
  const y = wireY(cell.row);
  const cx = x + CW / 2;
  const tag = findTag(project, node.tag);
  const mark =
    node.mode === 'NC'
      ? `<line class="sym" x1="${cx - 6}" y1="${y + 9}" x2="${cx + 6}" y2="${y - 9}"/>`
      : node.mode === 'NO'
        ? ''
        : `<text class="mark" x="${cx}" y="${y + 4}" text-anchor="middle">${node.mode}</text>`;
  return `<g class="el contact${tag ? '' : ' missing'}" data-el="${node.id}">
${hit(cell)}
${wire(x, y, cx - 8, y, node.id, 'in')}
<rect class="gap" x="${cx - 8}" y="${y - 11}" width="16" height="22"/>
<line class="sym" x1="${cx - 8}" y1="${y - 11}" x2="${cx - 8}" y2="${y + 11}"/>
<line class="sym" x1="${cx + 8}" y1="${y - 11}" x2="${cx + 8}" y2="${y + 11}"/>
${mark}
${wire(cx + 8, y, x + CW, y, node.id, 'out')}
${label(node.tag, cx, y - 19, 'name', 15)}
${tag?.address ? label(tag.address, cx, y + 25, 'addr', 12) : ''}
</g>`;
}

function coilSvg(node: Coil, cell: Cell, project: Project): string {
  const x = cellX(cell.col);
  const y = wireY(cell.row);
  const cx = x + CW / 2;
  const tag = findTag(project, node.tag);
  const letter = node.mode === 'set' ? 'S' : node.mode === 'reset' ? 'R' : node.mode === 'negated' ? '/' : '';
  return `<g class="el coil${tag ? '' : ' missing'}" data-el="${node.id}">
${hit(cell)}
${wire(x, y, cx - 10, y, node.id, 'in')}
<path class="gap" d="M${cx - 6},${y - 11} Q${cx - 15},${y} ${cx - 6},${y + 11} L${cx + 6},${y + 11} Q${cx + 15},${y} ${cx + 6},${y - 11} Z"/>
<path class="sym" d="M${cx - 6},${y - 11} Q${cx - 15},${y} ${cx - 6},${y + 11}"/>
<path class="sym" d="M${cx + 6},${y - 11} Q${cx + 15},${y} ${cx + 6},${y + 11}"/>
${letter ? `<text class="mark" x="${cx}" y="${y + 4}" text-anchor="middle">${letter}</text>` : ''}
${wire(cx + 10, y, x + CW, y, node.id, 'in')}
${label(node.tag, cx, y - 19, 'name', 15)}
${tag?.address ? label(tag.address, cx, y + 25, 'addr', 12) : ''}
</g>`;
}

function blockSvg(node: Block, cell: Cell): string {
  const def = blockDef(node.type);
  const x = cellX(cell.col);
  const y = wireY(cell.row);
  const bodyX = x + (BLOCK_COLS * CW - BODY_W) / 2;
  const left = def ? [def.powerIn, ...def.inputs.map((p) => p.name)] : ['IN'];
  const right = def ? [def.powerOut, ...def.outputs.map((p) => p.name)] : ['OUT'];
  const rows = Math.max(left.length, right.length);
  const live = def?.kind === 'fb' && node.instance ? (def.outputs.some((p) => p.name === 'ET') ? 'ET' : def.outputs.some((p) => p.name === 'CV') ? 'CV' : '') : '';
  const height = 38 + (rows - 1) * PIN_PITCH + (live ? 14 : 0);
  const top = y - 24;
  const pinY = (i: number) => y + i * PIN_PITCH;

  const parts: string[] = [];
  left.forEach((name, i) => {
    parts.push(`<text class="pin" x="${bodyX + 5}" y="${pinY(i) + 3.5}">${name}</text>`);
    const operand = node.inputs[name];
    if (i > 0 && operand !== undefined) {
      parts.push(`<line class="stub" x1="${bodyX - 5}" y1="${pinY(i)}" x2="${bodyX}" y2="${pinY(i)}"/>`);
      parts.push(label(operand, bodyX - 8, pinY(i) + 3.5, 'operand', 9, 'end'));
    }
  });
  right.forEach((name, i) => {
    parts.push(`<text class="pin" x="${bodyX + BODY_W - 5}" y="${pinY(i) + 3.5}" text-anchor="end">${name}</text>`);
    const operand = node.outputs[name];
    if (i > 0 && operand !== undefined) {
      parts.push(`<line class="stub" x1="${bodyX + BODY_W}" y1="${pinY(i)}" x2="${bodyX + BODY_W + 5}" y2="${pinY(i)}"/>`);
      parts.push(label(operand, bodyX + BODY_W + 8, pinY(i) + 3.5, 'operand', 9, 'start'));
    }
  });

  return `<g class="el block" data-el="${node.id}">
<rect class="hit" x="${x + 3}" y="${y - WIRE + 3}" width="${cell.w * CW - 6}" height="${cell.h * RH - 6}" rx="6"/>
${wire(x, y, bodyX, y, node.id, 'in')}
<rect class="body" x="${bodyX}" y="${top}" width="${BODY_W}" height="${height}" rx="4"/>
<text class="btitle" x="${bodyX + BODY_W / 2}" y="${top + 12}" text-anchor="middle">${esc(node.type)}</text>
${node.instance ? label(node.instance, bodyX + BODY_W / 2, top - 5, 'name', 15) : ''}
${parts.join('\n')}
${live ? `<text class="live" data-live="${esc(node.instance!)}.${live}" x="${bodyX + BODY_W / 2}" y="${top + height - 6}" text-anchor="middle"></text>` : ''}
${wire(bodyX + BODY_W, y, x + cell.w * CW, y, node.id, 'out')}
</g>`;
}

/** Draw one rung. `logicCols` aligns the coil column across all rungs. */
export function rungSvg(rung: Rung, project: Project, logicCols: number): string {
  const layout = layoutRung(rung, logicCols);
  const railR = cellX(layout.logicCols + 1);
  const width = railR + RAIL;
  const height = layout.rows * RH + 6;
  const parts: string[] = [];

  parts.push(wire(RAIL, wireY(0), X0, wireY(0), rung.logic.id, 'in'));
  for (const seg of layout.segs) {
    parts.push(wire(cellX(seg.x1), wireY(seg.y1), cellX(seg.x2), wireY(seg.y2), seg.id, seg.side));
  }
  for (const cell of layout.cells) {
    if (cell.node.kind === 'contact') parts.push(contactSvg(cell.node, cell, project));
    else if (cell.node.kind === 'coil') parts.push(coilSvg(cell.node, cell, project));
    else parts.push(blockSvg(cell.node, cell));
  }
  parts.push(`<line class="rail" x1="${RAIL}" y1="0" x2="${RAIL}" y2="${height}"/>`);
  parts.push(`<line class="rail" x1="${railR}" y1="0" x2="${railR}" y2="${height}"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">${parts.join('\n')}</svg>`;
}
