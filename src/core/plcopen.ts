// PLCopen TC6 XML (version 2.01) export. The output is a complete project:
// one program POU with an LD body, plus a configuration, resource and cyclic
// task, so it can be opened directly in editors such as OpenPLC Editor,
// Beremiz or CODESYS (Project > Import PLCopenXML).

import { blockDef } from './blocks.js';
import { BLOCK_COLS, PIN_PITCH, blockPins, commonLogicCols, layoutRung } from './layout.js';
import { formatTime, formatValue, parseOperand } from './literals.js';
import { Block, LogicNode, Project, Rung, Tag, walk } from './model.js';

export interface ExportOptions {
  /** Timestamp written to the file header (defaults to now). */
  now?: Date;
  pouName?: string;
}

// Drawing geometry, in editor pixels.
const RAIL_X = 20;
const RAIL_W = 10;
const X0 = 50;
const CW = 140;
const RH = 70;
const WIRE_Y = 30;
const EL_W = 21;
const EL_H = 15;
const BODY_W = 100;
const VAR_W = 80;
const VAR_H = 24;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

interface Point {
  x: number;
  y: number;
}

/** An output connection point that later elements can wire to. */
interface Source extends Point {
  localId: number;
  pin?: string;
}

function variableXml(tag: Tag): string {
  const attrs = `name="${esc(tag.name)}"${tag.address ? ` address="${esc(tag.address)}"` : ''}`;
  const parts = [`<type><${tag.type}/></type>`];
  if (tag.initial !== undefined) parts.push(`<initialValue><simpleValue value="${esc(formatValue(tag.type, tag.initial))}"/></initialValue>`);
  if (tag.comment) parts.push(`<documentation><xhtml:p>${cdata(tag.comment)}</xhtml:p></documentation>`);
  return `<variable ${attrs}>${parts.join('')}</variable>`;
}

function instanceVariables(project: Project): string[] {
  const seen = new Map<string, string>();
  for (const rung of project.rungs) {
    walk(rung.logic, (node) => {
      if (node.kind !== 'block' || !node.instance) return;
      const def = blockDef(node.type);
      if (def?.kind === 'fb' && !seen.has(node.instance.toLowerCase())) seen.set(node.instance.toLowerCase(), `<variable name="${esc(node.instance)}"><type><derived name="${def.type}"/></type></variable>`);
    });
  }
  return [...seen.values()];
}

export function exportPlcopen(project: Project, options: ExportOptions = {}): string {
  const stamp = (options.now ?? new Date()).toISOString().slice(0, 19);
  const pouName = options.pouName ?? 'program0';
  const out: string[] = [];
  let nextId = 1;

  const pos = (p: Point) => `<position x="${p.x}" y="${p.y}"/>`;
  const rel = (x: number, y: number) => `<relPosition x="${x}" y="${y}"/>`;
  const cellX = (col: number) => X0 + col * CW;

  /** Wire from an element's input point back to a source output point. */
  const connection = (dest: Point, src: Source, bendX: number): string => {
    const pts = dest.y === src.y ? [dest, src] : [dest, { x: bendX, y: dest.y }, { x: bendX, y: src.y }, src];
    const pin = src.pin ? ` formalParameter="${src.pin}"` : '';
    return `<connection refLocalId="${src.localId}"${pin}>${pts.map(pos).join('')}</connection>`;
  };
  const pointIn = (relX: number, relY: number, at: Point, sources: Source[], bendX: number) =>
    `<connectionPointIn>${rel(relX, relY)}${sources.map((s) => connection(at, s, bendX)).join('')}</connectionPointIn>`;

  const operandText = (text: string): string => {
    const operand = parseOperand(text, project);
    if (operand.kind === 'tag') return operand.name;
    if (operand.kind === 'literal') return operand.type === 'TIME' ? formatTime(Number(operand.value)) : formatValue(operand.type, operand.value);
    return text;
  };

  const exportRung = (rung: Rung, top: number, logicCols: number): number => {
    if (rung.comment) {
      out.push(`<comment localId="${nextId++}" height="30" width="${CW * 4}">${pos({ x: RAIL_X, y: top })}<content><xhtml:p>${cdata(rung.comment)}</xhtml:p></content></comment>`);
      top += 40;
    }
    const layout = layoutRung(rung, logicCols);
    const cellOf = new Map(layout.cells.map((c) => [c.node.id, c]));
    const wireY = (row: number) => top + WIRE_Y + row * RH;

    const railId = nextId++;
    const rail: Source = { localId: railId, x: RAIL_X + RAIL_W, y: wireY(0) };
    out.push(`<leftPowerRail localId="${railId}" height="40" width="${RAIL_W}">${pos({ x: RAIL_X, y: wireY(0) - 20 })}<connectionPointOut formalParameter="">${rel(RAIL_W, 20)}</connectionPointOut></leftPowerRail>`);

    const exportBlock = (node: Block, sources: Source[]): Source[] => {
      const def = blockDef(node.type);
      const cell = cellOf.get(node.id)!;
      if (!def) return sources;
      const id = nextId++;
      const bodyX = cellX(cell.col) + (BLOCK_COLS * CW - BODY_W) / 2;
      const y0 = wireY(cell.row);
      const pinY = (i: number) => y0 + i * PIN_PITCH;
      const height = 40 + (blockPins(node) - 1) * PIN_PITCH;
      const after: string[] = [];

      const inputs = def.xmlInputs.map((name, i) => {
        const at = { x: bodyX, y: pinY(i) };
        let wired: Source[] = [];
        if (name === def.powerIn) wired = sources;
        else if (node.inputs[name] !== undefined) {
          const varId = nextId++;
          const x = bodyX - VAR_W - 5;
          after.push(`<inVariable localId="${varId}" height="${VAR_H}" width="${VAR_W}" negated="false">${pos({ x, y: at.y - VAR_H / 2 })}<connectionPointOut>${rel(VAR_W, VAR_H / 2)}</connectionPointOut><expression>${esc(operandText(node.inputs[name]))}</expression></inVariable>`);
          wired = [{ localId: varId, x: x + VAR_W, y: at.y }];
        }
        return `<variable formalParameter="${name}">${pointIn(0, 30 + i * PIN_PITCH, at, wired, cellX(cell.col))}</variable>`;
      });

      let powerOut: Source = { localId: id, x: bodyX + BODY_W, y: y0 };
      const outputs = def.xmlOutputs.map((name, i) => {
        const from: Source = { localId: id, pin: name, x: bodyX + BODY_W, y: pinY(i) };
        if (name === def.powerOut) powerOut = from;
        else if (node.outputs[name] !== undefined) {
          const x = bodyX + BODY_W + 5;
          after.push(`<outVariable localId="${nextId++}" height="${VAR_H}" width="${VAR_W}" negated="false">${pos({ x, y: from.y - VAR_H / 2 })}${pointIn(0, VAR_H / 2, { x, y: from.y }, [from], x)}<expression>${esc(operandText(node.outputs[name]))}</expression></outVariable>`);
        }
        return `<variable formalParameter="${name}"><connectionPointOut>${rel(BODY_W, 30 + i * PIN_PITCH)}</connectionPointOut></variable>`;
      });

      const instance = def.kind === 'fb' && node.instance ? ` instanceName="${esc(node.instance)}"` : '';
      out.push(`<block localId="${id}" typeName="${def.type}"${instance} height="${height}" width="${BODY_W}">${pos({ x: bodyX, y: y0 - 30 })}<inputVariables>${inputs.join('')}</inputVariables><inOutVariables/><outputVariables>${outputs.join('')}</outputVariables></block>`);
      out.push(...after);
      return [powerOut];
    };

    /** Emit the elements of a logic subtree fed by `sources`; returns its outputs. */
    const exportNode = (node: LogicNode, sources: Source[]): Source[] => {
      switch (node.kind) {
        case 'contact': {
          const cell = cellOf.get(node.id)!;
          const id = nextId++;
          const x = cellX(cell.col) + Math.round((CW - EL_W) / 2);
          const y = wireY(cell.row);
          const edge = node.mode === 'P' ? ' edge="rising"' : node.mode === 'N' ? ' edge="falling"' : '';
          out.push(`<contact localId="${id}" height="${EL_H}" width="${EL_W}" negated="${node.mode === 'NC'}"${edge}>${pos({ x, y: y - 8 })}${pointIn(0, 8, { x, y }, sources, cellX(cell.col))}<connectionPointOut>${rel(EL_W, 8)}</connectionPointOut><variable>${esc(operandText(node.tag))}</variable></contact>`);
          return [{ localId: id, x: x + EL_W, y }];
        }
        case 'block':
          return exportBlock(node, sources);
        case 'series':
          return node.items.reduce((src, item) => exportNode(item, src), sources);
        case 'parallel':
          return node.branches.flatMap((branch) => exportNode(branch, sources));
      }
    };

    const logicOut = exportNode(rung.logic, [rail]);

    if (rung.coils.length > 0) {
      const coilX = cellX(layout.logicCols) + Math.round((CW - EL_W) / 2);
      const railX = cellX(layout.logicCols + 1);
      const pins: string[] = [];
      rung.coils.forEach((coil, i) => {
        const id = nextId++;
        const y = wireY(i);
        const storage = coil.mode === 'set' ? ' storage="set"' : coil.mode === 'reset' ? ' storage="reset"' : '';
        out.push(`<coil localId="${id}" height="${EL_H}" width="${EL_W}" negated="${coil.mode === 'negated'}"${storage}>${pos({ x: coilX, y: y - 8 })}${pointIn(0, 8, { x: coilX, y }, logicOut, cellX(layout.logicCols))}<connectionPointOut>${rel(EL_W, 8)}</connectionPointOut><variable>${esc(operandText(coil.tag))}</variable></coil>`);
        pins.push(pointIn(0, 20 + i * RH, { x: railX, y }, [{ localId: id, x: coilX + EL_W, y }], railX));
      });
      const height = 40 + (rung.coils.length - 1) * RH;
      out.push(`<rightPowerRail localId="${nextId++}" height="${height}" width="${RAIL_W}">${pos({ x: railX, y: wireY(0) - 20 })}${pins.join('')}</rightPowerRail>`);
    }

    return top + layout.rows * RH + 30;
  };

  let top = 20;
  const logicCols = commonLogicCols(project.rungs);
  for (const rung of project.rungs) top = exportRung(rung, top, logicCols);

  const variables = [...project.tags.map(variableXml), ...instanceVariables(project)];
  const name = esc(project.name || 'Untitled');
  const documentation = project.description ? `<documentation><xhtml:p>${cdata(project.description)}</xhtml:p></documentation>` : '';

  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<project xmlns="http://www.plcopen.org/xml/tc6_0201" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:xsd="http://www.w3.org/2001/XMLSchema">`,
    `<fileHeader companyName="ladder-plc" productName="${name}" productVersion="1" creationDateTime="${stamp}"/>`,
    `<contentHeader name="${name}" modificationDateTime="${stamp}">`,
    `<coordinateInfo><fbd><scaling x="10" y="10"/></fbd><ld><scaling x="10" y="10"/></ld><sfc><scaling x="10" y="10"/></sfc></coordinateInfo>`,
    `</contentHeader>`,
    `<types>`,
    `<dataTypes/>`,
    `<pous>`,
    `<pou name="${esc(pouName)}" pouType="program">`,
    `<interface>${variables.length ? `<localVars>\n${variables.join('\n')}\n</localVars>` : ''}</interface>`,
    `<body><LD>`,
    ...out,
    `</LD></body>`,
    ...(documentation ? [documentation] : []),
    `</pou>`,
    `</pous>`,
    `</types>`,
    `<instances><configurations><configuration name="Config0"><resource name="Res0">`,
    `<task name="task0" priority="0" interval="${formatTime(project.scanMs)}"><pouInstance name="instance0" typeName="${esc(pouName)}"/></task>`,
    `</resource></configuration></configurations></instances>`,
    `</project>`,
    '',
  ].join('\n');
}
