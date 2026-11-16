// Text rendering of ladder rungs, for chat output.

import { Block, Coil, LogicNode, Project, Rung } from './model.js';

/** Lines of equal width. Line 1 is the wire line; line 0 holds labels. */
interface Box {
  lines: string[];
  width: number;
}

const CONTACT: Record<string, string> = { NO: '-| |-', NC: '-|/|-', P: '-|P|-', N: '-|N|-' };
const COIL: Record<string, string> = { normal: '-( )-', negated: '-(/)-', set: '-(S)-', reset: '-(R)-' };

function center(text: string, width: number, fill: string): string {
  const total = width - text.length;
  const left = Math.floor(total / 2);
  return fill.repeat(left) + text + fill.repeat(total - left);
}

function leaf(label: string, symbol: string): Box {
  const width = Math.max(label.length, symbol.length) + 2;
  return { lines: [center(label, width, ' '), center(symbol, width, '-')], width };
}

function blockSymbol(block: Block): string {
  const args = [...Object.entries(block.inputs), ...Object.entries(block.outputs)].map(([k, v]) => `${k}=${v}`);
  return `[${[block.type, ...args].join(' ')}]`;
}

function stack(boxes: Box[]): Box {
  const width = Math.max(...boxes.map((b) => b.width));
  const lines: string[] = [];
  const wireLines: number[] = [];
  for (const box of boxes) {
    wireLines.push(lines.length + 1);
    box.lines.forEach((line, i) => lines.push(line + (i === 1 ? '-' : ' ').repeat(width - box.width)));
  }
  if (boxes.length === 1) return { lines, width };
  const first = wireLines[0];
  const last = wireLines[wireLines.length - 1];
  const edge = (i: number) => (wireLines.includes(i) ? '+' : i > first && i < last ? '|' : ' ');
  return { lines: lines.map((line, i) => edge(i) + line + edge(i)), width: width + 2 };
}

function render(node: LogicNode): Box {
  switch (node.kind) {
    case 'contact':
      return leaf(node.tag, CONTACT[node.mode]);
    case 'block':
      return leaf(node.instance ?? '', blockSymbol(node));
    case 'series': {
      if (node.items.length === 0) return { lines: ['   ', '---'], width: 3 };
      const boxes = node.items.map(render);
      const height = Math.max(...boxes.map((b) => b.lines.length));
      const lines: string[] = [];
      for (let i = 0; i < height; i++) lines.push(boxes.map((b) => b.lines[i] ?? ' '.repeat(b.width)).join(''));
      return { lines, width: lines[0].length };
    }
    case 'parallel':
      return stack(node.branches.map(render));
  }
}

function renderCoils(coils: Coil[]): Box {
  if (coils.length === 0) return { lines: ['', ''], width: 0 };
  return stack(coils.map((c) => leaf(c.tag, COIL[c.mode])));
}

function rungBoxes(rung: Rung): { logic: Box; coils: Box } {
  return { logic: render(rung.logic), coils: renderCoils(rung.coils) };
}

export function renderRung(rung: Rung, number?: number, width?: number): string {
  const { logic, coils } = rungBoxes(rung);
  const gap = Math.max(2, (width ?? 0) - logic.width - coils.width);
  const height = Math.max(logic.lines.length, coils.lines.length);
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    const fill = i === 1 ? '-' : ' ';
    const left = logic.lines[i] ?? ' '.repeat(logic.width);
    const right = coils.lines[i] ?? ' '.repeat(coils.width);
    lines.push(`|${fill}${left}${fill.repeat(gap)}${right}${fill}|`.replace(/\s+$/, ''));
  }
  const title = number === undefined ? '' : `Rung ${number}${rung.comment ? `: ${rung.comment}` : ''}\n`;
  return title + lines.join('\n');
}

export function renderLadder(project: Project): string {
  if (project.rungs.length === 0) return '(no rungs)';
  const width = Math.max(...project.rungs.map((r) => {
    const b = rungBoxes(r);
    return b.logic.width + b.coils.width + 2;
  }));
  return project.rungs.map((r, i) => renderRung(r, i + 1, width)).join('\n\n');
}
