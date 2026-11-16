// Compact text notation for a rung, used by the MCP tools and the editor.
//
//   (start | motor) & stop_ok & !overload -> motor, run_lamp
//
//   &  series (AND)        |  parallel branch (OR)      ( )  grouping
//   tag      normally open contact       !tag     normally closed contact
//   P(tag)   rising-edge contact         N(tag)   falling-edge contact
//   TON(T1, T#5s)  inline block: instance first for function blocks, then
//                  inputs by position or NAME=value, outputs as NAME=tag
//   -> tag   coil      -> !tag  negated coil    -> S(tag) set    -> R(tag) reset

import { BlockDef, blockDef } from './blocks.js';
import { Block, Coil, CoilMode, Contact, LogicNode, Rung } from './model.js';

export class DslError extends Error {}

type TokenType = 'ident' | 'literal' | 'sym' | 'end';
interface Token {
  type: TokenType;
  text: string;
  pos: number;
}

const KEYWORD_SYMBOLS: Record<string, string> = { AND: '&', OR: '|', NOT: '!' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const patterns: [TokenType, RegExp][] = [
    ['sym', /->|[()&|!,=]/y],
    ['literal', /(?:TIME|T)#[A-Za-z0-9_.]+/iy],
    ['literal', /-?\d+(?:\.\d+)?/y],
    ['ident', /[A-Za-z_][A-Za-z0-9_]*/y],
  ];
  let pos = 0;
  outer: while (pos < src.length) {
    if (/\s/.test(src[pos])) {
      pos++;
      continue;
    }
    for (const [type, re] of patterns) {
      re.lastIndex = pos;
      const m = re.exec(src);
      if (!m) continue;
      let token: Token = { type, text: m[0], pos };
      if (type === 'ident') {
        if (KEYWORD_SYMBOLS[m[0]]) token = { type: 'sym', text: KEYWORD_SYMBOLS[m[0]], pos };
        else if (/^(true|false)$/i.test(m[0])) token = { type: 'literal', text: m[0].toUpperCase(), pos };
      }
      tokens.push(token);
      pos = re.lastIndex;
      continue outer;
    }
    throw new DslError(`Unexpected character "${src[pos]}" at position ${pos + 1}`);
  }
  tokens.push({ type: 'end', text: '', pos: src.length });
  return tokens;
}

export interface ParsedRung {
  logic: LogicNode;
  coils: Coil[];
}

/** Parse rung text. Ids are left blank; call normalizeRung() to assign them. */
export function parseRung(src: string): ParsedRung {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const isSym = (text: string) => peek().type === 'sym' && peek().text === text;
  const fail = (message: string, token = peek()): never => {
    const found = token.type === 'end' ? 'end of rung' : `"${token.text}"`;
    throw new DslError(`${message} (found ${found} at position ${token.pos + 1})`);
  };
  const expectSym = (text: string) => {
    if (!isSym(text)) fail(`Expected "${text}"`);
    next();
  };
  const expectIdent = (what: string): string => {
    if (peek().type !== 'ident') fail(`Expected ${what}`);
    return next().text;
  };

  const parseExpr = (): LogicNode => {
    const branches = [parseTerm()];
    while (isSym('|')) {
      next();
      branches.push(parseTerm());
    }
    return branches.length === 1 ? branches[0] : { kind: 'parallel', id: '', branches };
  };

  const parseTerm = (): LogicNode => {
    const items = [parseFactor()];
    while (isSym('&')) {
      next();
      items.push(parseFactor());
    }
    return items.length === 1 ? items[0] : { kind: 'series', id: '', items };
  };

  const contact = (tag: string, mode: Contact['mode']): Contact => ({ kind: 'contact', id: '', tag, mode });

  const parseFactor = (): LogicNode => {
    if (isSym('(')) {
      next();
      const inner = parseExpr();
      expectSym(')');
      return inner;
    }
    if (isSym('!')) {
      next();
      return contact(expectIdent('a tag name after "!"'), 'NC');
    }
    const token = peek();
    if (token.type === 'literal' && token.text === 'TRUE') {
      next();
      return { kind: 'series', id: '', items: [] };
    }
    if (token.type !== 'ident') fail('Expected a contact, a block or "("');
    next();
    if (!isSym('(')) return contact(token.text, 'NO');
    next();
    const upper = token.text.toUpperCase();
    if (upper === 'P' || upper === 'N') {
      const tag = expectIdent(`a tag name inside ${upper}( )`);
      expectSym(')');
      return contact(tag, upper);
    }
    const def = blockDef(upper);
    if (!def) throw new DslError(`Unknown block "${token.text}" at position ${token.pos + 1}`);
    return parseBlock(def);
  };

  const parseOperandToken = (): string => {
    const t = peek();
    if (t.type !== 'ident' && t.type !== 'literal') fail('Expected a tag name or a literal value');
    return next().text;
  };

  const parseBlock = (def: BlockDef): Block => {
    const block: Block = { kind: 'block', id: '', type: def.type, inputs: {}, outputs: {} };
    let positional = 0;
    let first = true;
    while (!isSym(')')) {
      if (!first) expectSym(',');
      const named = peek().type === 'ident' && tokens[i + 1].type === 'sym' && tokens[i + 1].text === '=';
      if (named) {
        const pinToken = next();
        const pin = pinToken.text.toUpperCase();
        next();
        const value = parseOperandToken();
        if (def.inputs.some((p) => p.name === pin)) block.inputs[pin] = value;
        else if (def.outputs.some((p) => p.name === pin)) block.outputs[pin] = value;
        else {
          const pins = [...def.inputs, ...def.outputs].map((p) => p.name).join(', ') || 'none';
          throw new DslError(`${def.type} has no pin "${pinToken.text}" (pins: ${pins})`);
        }
      } else if (first && def.kind === 'fb') {
        block.instance = expectIdent(`an instance name as the first argument of ${def.type}`);
      } else {
        const pin = def.inputs[positional++];
        if (!pin) fail(`Too many arguments for ${def.type}`);
        block.inputs[pin.name] = parseOperandToken();
      }
      first = false;
    }
    next();
    if (def.kind === 'fb' && !block.instance) {
      throw new DslError(`${def.type} needs an instance name as its first argument, e.g. ${def.type}(${def.type[0]}1, ...)`);
    }
    return block;
  };

  const parseCoil = (): Coil => {
    const coil = (tag: string, mode: CoilMode): Coil => ({ kind: 'coil', id: '', tag, mode });
    if (isSym('!')) {
      next();
      return coil(expectIdent('a tag name after "!"'), 'negated');
    }
    const name = expectIdent('a coil tag');
    if (!isSym('(')) return coil(name, 'normal');
    const upper = name.toUpperCase();
    if (upper !== 'S' && upper !== 'R') fail(`Only S(tag) and R(tag) are allowed as coil functions, not ${name}( )`);
    next();
    const tag = expectIdent(`a tag name inside ${upper}( )`);
    expectSym(')');
    return coil(tag, upper === 'S' ? 'set' : 'reset');
  };

  let logic: LogicNode = { kind: 'series', id: '', items: [] };
  const coils: Coil[] = [];
  if (!isSym('->') && peek().type !== 'end') logic = parseExpr();
  if (isSym('->')) {
    next();
    if (peek().type !== 'end') {
      coils.push(parseCoil());
      while (isSym(',')) {
        next();
        coils.push(parseCoil());
      }
    }
  }
  if (peek().type !== 'end') fail('Unexpected input; use "&" for series, "|" for parallel and "->" before coils');
  return { logic, coils };
}

function formatBlock(block: Block): string {
  const def = blockDef(block.type);
  const args: string[] = [];
  if (block.instance) args.push(block.instance);
  const inputNames = def ? def.inputs.map((p) => p.name) : Object.keys(block.inputs);
  // Functions and single-input blocks read well positionally: GT(level, 80), TON(T1, T#5s).
  let positional = !def || def.kind === 'fn' || def.inputs.length === 1;
  for (const name of inputNames) {
    const value = block.inputs[name];
    if (value === undefined) {
      positional = false;
      continue;
    }
    args.push(positional ? value : `${name}=${value}`);
  }
  for (const [name, value] of Object.entries(block.outputs)) args.push(`${name}=${value}`);
  return `${block.type}(${args.join(', ')})`;
}

export function formatLogic(node: LogicNode): string {
  switch (node.kind) {
    case 'contact':
      if (node.mode === 'NO') return node.tag;
      if (node.mode === 'NC') return `!${node.tag}`;
      return `${node.mode}(${node.tag})`;
    case 'block':
      return formatBlock(node);
    case 'series':
      if (node.items.length === 0) return 'TRUE';
      return node.items.map((n) => (n.kind === 'parallel' ? `(${formatLogic(n)})` : formatLogic(n))).join(' & ');
    case 'parallel':
      return node.branches.map((n) => formatLogic(n)).join(' | ');
  }
}

export function formatCoil(coil: Coil): string {
  switch (coil.mode) {
    case 'normal':
      return coil.tag;
    case 'negated':
      return `!${coil.tag}`;
    case 'set':
      return `S(${coil.tag})`;
    case 'reset':
      return `R(${coil.tag})`;
  }
}

export function formatRung(rung: Pick<Rung, 'logic' | 'coils'>): string {
  const logic = formatLogic(rung.logic);
  if (rung.coils.length === 0) return logic;
  return `${logic} -> ${rung.coils.map(formatCoil).join(', ')}`;
}

export const DSL_REFERENCE = `Rung text syntax:
  (start | motor) & stop_ok & !overload -> motor, run_lamp
  &  series (AND)      |  parallel branch (OR)      ( )  grouping
  tag      normally open contact (passes power when the bit is 1)
  !tag     normally closed contact (passes power when the bit is 0)
  P(tag)   rising-edge contact      N(tag)  falling-edge contact
  -> tag   coil    -> !tag  negated coil    -> S(tag)  set (latch)    -> R(tag)  reset (unlatch)
  Several coils: -> a, b.   An unconditional rung: TRUE -> tag.
Inline blocks take the rung's power as their first input and pass their main output on:
  start & TON(T1, T#5s) -> lamp                 timer in series with a coil
  P(sensor) & CTU(C1, R=reset_pb, PV=10, CV=count) -> batch_done
  GT(level, 80) -> high_alarm                   comparison acts like a contact
  run & ADD(total, 1, OUT=total)                math/MOVE rungs need no coil
Function blocks take an instance name first; inputs follow by position or NAME=value; outputs are NAME=tag.
Literals: 10, 2.5, TRUE, FALSE, T#500ms, T#1m30s.`;
