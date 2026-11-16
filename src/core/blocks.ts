// Catalogue of the IEC 61131-3 standard function blocks and functions that
// can be placed inline in a rung. Shared by the parser, validator, simulator,
// layout and PLCopen exporter.

/** BOOL, TIME, INT (INT/DINT), NUM (INT/DINT/REAL) or ANY (NUM or TIME). */
export type PinType = 'BOOL' | 'TIME' | 'INT' | 'NUM' | 'ANY';

export interface PinDef {
  name: string;
  type: PinType;
  required?: boolean;
}

export interface BlockDef {
  type: string;
  /** fb = function block with an instance and memory; fn = stateless function. */
  kind: 'fb' | 'fn';
  /** Pin that receives the rung's power flow. */
  powerIn: string;
  /** Pin that continues the rung's power flow. */
  powerOut: string;
  /** Remaining input pins, bound to a tag or literal. */
  inputs: PinDef[];
  /** Remaining output pins, optionally bound to a tag. */
  outputs: PinDef[];
  /** Pin order as declared by the standard, used for the PLCopen XML. */
  xmlInputs: string[];
  xmlOutputs: string[];
  doc: string;
}

function fb(type: string, powerIn: string, powerOut: string, inputs: PinDef[], outputs: PinDef[], xmlInputs: string[], doc: string): BlockDef {
  return { type, kind: 'fb', powerIn, powerOut, inputs, outputs, xmlInputs, xmlOutputs: [powerOut, ...outputs.map((p) => p.name)], doc };
}

function compare(type: string, symbol: string): BlockDef {
  return {
    type,
    kind: 'fn',
    powerIn: 'EN',
    powerOut: 'OUT',
    inputs: [
      { name: 'IN1', type: 'ANY', required: true },
      { name: 'IN2', type: 'ANY', required: true },
    ],
    outputs: [],
    xmlInputs: ['EN', 'IN1', 'IN2'],
    xmlOutputs: ['ENO', 'OUT'],
    doc: `Passes power when IN1 ${symbol} IN2.`,
  };
}

function math(type: string, symbol: string): BlockDef {
  return {
    type,
    kind: 'fn',
    powerIn: 'EN',
    powerOut: 'ENO',
    inputs: [
      { name: 'IN1', type: 'NUM', required: true },
      { name: 'IN2', type: 'NUM', required: true },
    ],
    outputs: [{ name: 'OUT', type: 'NUM', required: true }],
    xmlInputs: ['EN', 'IN1', 'IN2'],
    xmlOutputs: ['ENO', 'OUT'],
    doc: `While powered, OUT := IN1 ${symbol} IN2 every scan.`,
  };
}

const PT: PinDef = { name: 'PT', type: 'TIME', required: true };
const PV: PinDef = { name: 'PV', type: 'INT', required: true };
const ET: PinDef = { name: 'ET', type: 'TIME' };
const CV: PinDef = { name: 'CV', type: 'INT' };

const DEFS: BlockDef[] = [
  fb('TON', 'IN', 'Q', [PT], [ET], ['IN', 'PT'], 'On-delay timer: Q turns on after the input has been on for PT.'),
  fb('TOF', 'IN', 'Q', [PT], [ET], ['IN', 'PT'], 'Off-delay timer: Q stays on for PT after the input turns off.'),
  fb('TP', 'IN', 'Q', [PT], [ET], ['IN', 'PT'], 'Pulse timer: a rising input produces a pulse on Q of length PT.'),
  fb('CTU', 'CU', 'Q', [{ name: 'R', type: 'BOOL' }, PV], [CV], ['CU', 'R', 'PV'], 'Up counter: counts rising edges; Q is on when CV >= PV; R resets CV to 0.'),
  fb('CTD', 'CD', 'Q', [{ name: 'LD', type: 'BOOL' }, PV], [CV], ['CD', 'LD', 'PV'], 'Down counter: counts rising edges down; Q is on when CV <= 0; LD loads CV with PV.'),
  fb('R_TRIG', 'CLK', 'Q', [], [], ['CLK'], 'Rising-edge detector: Q is on for one scan when the input turns on.'),
  fb('F_TRIG', 'CLK', 'Q', [], [], ['CLK'], 'Falling-edge detector: Q is on for one scan when the input turns off.'),
  fb('SR', 'S1', 'Q1', [{ name: 'R', type: 'BOOL' }], [], ['S1', 'R'], 'Set-dominant latch: the rung sets Q1; R resets it.'),
  fb('RS', 'S', 'Q1', [{ name: 'R1', type: 'BOOL' }], [], ['S', 'R1'], 'Reset-dominant latch: the rung sets Q1; R1 resets it and wins.'),
  compare('EQ', '='),
  compare('NE', '<>'),
  compare('GT', '>'),
  compare('GE', '>='),
  compare('LT', '<'),
  compare('LE', '<='),
  math('ADD', '+'),
  math('SUB', '-'),
  math('MUL', '*'),
  math('DIV', '/'),
  {
    type: 'MOVE',
    kind: 'fn',
    powerIn: 'EN',
    powerOut: 'ENO',
    inputs: [{ name: 'IN', type: 'ANY', required: true }],
    outputs: [{ name: 'OUT', type: 'ANY', required: true }],
    xmlInputs: ['EN', 'IN'],
    xmlOutputs: ['ENO', 'OUT'],
    doc: 'While powered, copies IN to OUT every scan.',
  },
];

export const BLOCKS: Record<string, BlockDef> = Object.fromEntries(DEFS.map((d) => [d.type, d]));

export function blockDef(type: string): BlockDef | undefined {
  return BLOCKS[type.toUpperCase()];
}

/** One-line signature per block, for tool descriptions and help text. */
export function blockReference(): string {
  return DEFS.map((d) => {
    const args = [
      ...(d.kind === 'fb' ? ['instance'] : []),
      ...d.inputs.map((p) => p.name),
      ...d.outputs.map((p) => `${p.name}=tag`),
    ].join(', ');
    return `${d.type}(${args}) - ${d.doc}`;
  }).join('\n');
}
