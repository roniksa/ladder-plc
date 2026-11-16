import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { renderLadder } from '../core/ascii.js';
import { formatRung, parseRung } from '../core/dsl.js';
import { formatTime, parseTime } from '../core/literals.js';
import { Project, emptyProject } from '../core/model.js';
import { OpError, addRung, applyOp, checkProject, removeTag, renameTag, upsertTags } from '../core/ops.js';
import { exportPlcopen } from '../core/plcopen.js';
import { runScenario } from '../core/scenario.js';
import { createSim, scan } from '../core/sim.js';
import { validate } from '../core/validate.js';

function motorProject(): Project {
  let p = emptyProject('Motor');
  p = upsertTags(p, [
    { name: 'start_pb', address: '%IX0.0', fieldContact: 'NO' },
    { name: 'stop_pb', address: '%IX0.1', fieldContact: 'NC' },
    { name: 'overload_ok', address: '%IX0.2', fieldContact: 'NC' },
    { name: 'motor', address: '%QX0.0' },
    { name: 'run_lamp', address: '%QX0.1' },
    { name: 'count', type: 'INT' },
    { name: 'batch_done' },
    { name: 'reset_pb', address: '%IX0.3' },
  ]);
  p = addRung(p, '(start_pb | motor) & stop_pb & overload_ok -> motor', 'Motor start/stop with seal-in');
  p = addRung(p, 'motor & TON(T1, T#2s, ET=elapsed_unused) -> run_lamp');
  return p;
}

test('time literals round-trip', () => {
  assert.equal(parseTime('T#5s'), 5000);
  assert.equal(parseTime('t#1m30s'), 90_000);
  assert.equal(parseTime('TIME#250ms'), 250);
  assert.equal(parseTime('T#1.5s'), 1500);
  assert.equal(parseTime('T#abc'), undefined);
  assert.equal(formatTime(90_500), 'T#1m30s500ms');
  assert.equal(formatTime(0), 'T#0ms');
});

test('rung text parses and formats back', () => {
  const cases = [
    '(start | motor) & !stop -> motor',
    'a & (b | c & d) & P(e) -> S(x), R(y), !z',
    'run & TON(T1, T#5s, ET=et) -> lamp',
    'P(sensor) & CTU(C1, R=rst, PV=10, CV=n) -> done',
    'GT(level, 80) -> alarm',
    'run & ADD(total, 1, OUT=total)',
    'TRUE -> always_on',
    'a | b | c -> q',
  ];
  for (const text of cases) assert.equal(formatRung(parseRung(text)), text);
  assert.equal(formatRung(parseRung('a AND NOT b OR c -> q')), 'a & !b | c -> q');
});

test('rung text reports useful errors', () => {
  assert.throws(() => parseRung('a b -> c'), /Unexpected input/);
  assert.throws(() => parseRung('FOO(a) -> c'), /Unknown block "FOO"/);
  assert.throws(() => parseRung('TON(T#5s) -> c'), /instance name/);
  assert.throws(() => parseRung('TON(T1, XX=1) -> c'), /no pin "XX"/);
  assert.throws(() => parseRung('(a | b -> c'), /Expected "\)"/);
});

test('validation finds undeclared tags and missing inputs', () => {
  const p = motorProject();
  const messages = validate(p).map((i) => i.message);
  assert.ok(messages.some((m) => m.includes('elapsed_unused')), messages.join('\n'));
  let q = addRung(p, 'nope -> motor');
  q = addRung(q, 'motor & TON(T2) -> run_lamp');
  const all = validate(q).map((i) => `${i.severity}: ${i.message}`).join('\n');
  assert.match(all, /error: Contact uses undeclared tag "nope"/);
  assert.match(all, /error: TON T2: input PT is required/);
  assert.match(all, /warning: "motor" is driven by ordinary coils in rungs 1, 3/);
  assert.match(all, /warning: "run_lamp" is driven by ordinary coils/);
});

test('validation rejects coils on physical inputs', () => {
  const p = addRung(motorProject(), 'motor -> start_pb');
  assert.ok(validate(p).some((i) => i.severity === 'error' && /physical input "start_pb"/.test(i.message)));
});

test('motor seal-in circuit behaves', () => {
  let p = motorProject();
  p = upsertTags(p, [{ name: 'elapsed_unused', type: 'TIME' }]);
  assert.deepEqual(validate(p).filter((i) => i.severity === 'error'), []);
  const result = runScenario(p, [
    { label: 'idle', expect: { motor: false, stop_pb: true } },
    { label: 'press start', set: { start_pb: true }, expect: { motor: true, run_lamp: false } },
    { label: 'release start', set: { start_pb: false }, run_ms: 1000, expect: { motor: true, run_lamp: false, 'T1.ET': 'T#1s' } },
    { label: 'lamp after 2 s', run_ms: 1100, expect: { run_lamp: true, 'T1.Q': true, elapsed_unused: 'T#2s' } },
    { label: 'press stop (NC opens)', set: { stop_pb: false }, expect: { motor: false, run_lamp: false } },
    { label: 'release stop', set: { stop_pb: true }, run_ms: 100, expect: { motor: false } },
    { label: 'overload trips', set: { start_pb: true, overload_ok: false }, expect: { motor: false } },
  ]);
  assert.ok(result.passed, JSON.stringify(result.steps.filter((s) => s.failures.length), null, 2));
});

test('counter counts rising edges and resets', () => {
  let p = motorProject();
  p = addRung(p, 'start_pb & CTU(C1, R=reset_pb, PV=3, CV=count) -> batch_done');
  const steps = [];
  for (let i = 1; i <= 3; i++) {
    steps.push({ set: { start_pb: true }, run_ms: 100, expect: { count: i } });
    steps.push({ set: { start_pb: false }, expect: { batch_done: i === 3 } });
  }
  steps.push({ set: { reset_pb: true }, expect: { count: 0, batch_done: false } });
  const result = runScenario(p, steps);
  assert.ok(result.passed, JSON.stringify(result.steps.filter((s) => s.failures.length), null, 2));
});

test('timers, edges, latches, compare and math', () => {
  let p = emptyProject('Blocks');
  p = upsertTags(p, [
    { name: 'x' }, { name: 'tof_q' }, { name: 'tp_q' }, { name: 'pulse' }, { name: 'latched' }, { name: 'unlatch' },
    { name: 'level', type: 'INT' }, { name: 'high' }, { name: 'total', type: 'INT' }, { name: 'copy', type: 'INT' }, { name: 'edges', type: 'INT' },
  ]);
  p = addRung(p, 'x & TOF(T1, T#100ms) -> tof_q');
  p = addRung(p, 'x & TP(T2, T#60ms) -> tp_q');
  p = addRung(p, 'P(x) -> pulse');
  p = addRung(p, 'pulse & ADD(edges, 1, OUT=edges)');
  p = addRung(p, 'x -> S(latched)');
  p = addRung(p, 'unlatch -> R(latched)');
  p = addRung(p, 'GE(level, 80) -> high');
  p = addRung(p, 'high & ADD(total, 5, OUT=total)');
  p = addRung(p, 'MOVE(total, OUT=copy)');
  assert.deepEqual(validate(p).filter((i) => i.severity === 'error'), []);
  const result = runScenario(p, [
    { set: { x: true }, expect: { tof_q: true, tp_q: true, pulse: true, edges: 1, latched: true } },
    { run_ms: 40, expect: { pulse: false, edges: 1, tp_q: true } },
    { run_ms: 40, expect: { tp_q: false } },
    { set: { x: false }, run_ms: 60, expect: { tof_q: true, latched: true } },
    { run_ms: 60, expect: { tof_q: false } },
    { set: { unlatch: true }, expect: { latched: false } },
    { set: { level: 79 }, expect: { high: false, total: 0 } },
    { set: { level: 80 }, run_ms: 40, expect: { high: true, total: 10, copy: 10 } },
  ]);
  assert.ok(result.passed, JSON.stringify(result.steps.filter((s) => s.failures.length), null, 2));
});

test('scan records power flow for every element', () => {
  const p = motorProject();
  const state = createSim(p);
  state.vars.start_pb = true;
  scan(p, state);
  const rung = p.rungs[0];
  assert.equal(state.flow[rung.logic.id].out, true);
  assert.equal(state.flow[rung.coils[0].id].out, true);
  assert.equal(Object.values(state.flow).every((f) => typeof f.in === 'boolean' && typeof f.out === 'boolean'), true);
});

test('tags can be renamed but not removed while in use', () => {
  const p = motorProject();
  assert.throws(() => removeTag(p, 'motor'), OpError);
  const q = renameTag(p, 'motor', 'pump');
  assert.equal(formatRung(q.rungs[0]), '(start_pb | pump) & stop_pb & overload_ok -> pump');
  assert.ok(q.tags.some((t) => t.name === 'pump'));
  assert.equal(removeTag(q, 'batch_done').tags.some((t) => t.name === 'batch_done'), false);
});

test('ladder renders as text', () => {
  const p = emptyProject();
  const q = addRung(upsertTags(p, [{ name: 'a' }, { name: 'b' }, { name: 'q' }]), '(a | q) & !b -> q');
  const lines = renderLadder(q).split('\n');
  assert.equal(lines[0], 'Rung 1');
  assert.match(lines[1], /^\|     a       b +q    \|$/);
  assert.match(lines[2], /^\|-\+--\| \|--\+--\|\/\|-+\( \)---\|$/);
  assert.match(lines[3], /^\| \|   q   \| +\|$/);
  assert.match(lines[4], /^\| \+--\| \|--\+ +\|$/);
  assert.equal(new Set(lines.slice(1).map((l) => l.length)).size, 1, 'all diagram lines have equal width');
});

test('PLCopen export contains the expected structure', () => {
  let p = upsertTags(motorProject(), [{ name: 'elapsed_unused', type: 'TIME' }, { name: 'level', type: 'INT', address: '%IW0' }, { name: 'high' }]);
  p = addRung(p, 'GT(level, 80) -> high');
  const xml = exportPlcopen(p, { now: new Date('2026-01-02T03:04:05Z') });
  assert.match(xml, /xmlns="http:\/\/www\.plcopen\.org\/xml\/tc6_0201"/);
  assert.match(xml, /<variable name="stop_pb" address="%IX0\.1"><type><BOOL\/><\/type><\/variable>/);
  assert.match(xml, /<variable name="T1"><type><derived name="TON"\/><\/type><\/variable>/);
  assert.match(xml, /<block localId="\d+" typeName="TON" instanceName="T1"/);
  assert.match(xml, /<expression>T#2s<\/expression>/);
  assert.match(xml, /<connection refLocalId="\d+" formalParameter="Q">/);
  assert.match(xml, /<connection refLocalId="\d+" formalParameter="OUT">/);
  assert.equal((xml.match(/<leftPowerRail /g) ?? []).length, 3);
  assert.equal((xml.match(/<contact /g) ?? []).length, 5);
  assert.equal((xml.match(/<coil /g) ?? []).length, 3);
  // Every connection must point at an element that exists.
  const ids = new Set([...xml.matchAll(/ localId="(\d+)"/g)].map((m) => m[1]));
  for (const m of xml.matchAll(/refLocalId="(\d+)"/g)) assert.ok(ids.has(m[1]), `dangling refLocalId ${m[1]}`);
  assert.equal(ids.size, [...xml.matchAll(/ localId="(\d+)"/g)].length, 'localIds must be unique');
});

/** A project that uses every element kind the exporter can produce. */
function everythingProject(): Project {
  let p = emptyProject('Everything');
  p.description = 'All element kinds <&> for schema validation';
  p = upsertTags(p, [
    { name: 'a', address: '%IX0.0', comment: 'in & out <x>' }, { name: 'b', address: '%IX0.1', fieldContact: 'NC' }, { name: 'c' }, { name: 'q', address: '%QX0.0' },
    { name: 'latch', initial: true }, { name: 'level', type: 'INT', address: '%IW0' }, { name: 'total', type: 'INT', initial: 5 }, { name: 'n', type: 'INT' },
    { name: 'big', type: 'DINT', initial: 100000 }, { name: 'ratio', type: 'REAL', initial: 1.5 }, { name: 'delay', type: 'TIME', initial: 'T#2s' }, { name: 'et', type: 'TIME' }, { name: 'rst' },
  ]);
  const rungs: [string, string?][] = [
    ['(a | q) & b & !rst -> q', 'seal-in'], ['a & (b | c & P(a)) & N(c) -> S(latch), !c', 'edges, nested, multi-coil'], ['rst -> R(latch)'],
    ['a & TON(T1, delay, ET=et) -> q'], ['a & TOF(T2, T#1s) & TP(T3, T#500ms) -> c'], ['P(a) & CTU(C1, R=rst, PV=10, CV=n) -> c'], ['a & CTD(C2, LD=rst, PV=3)'],
    ['a & R_TRIG(E1) & F_TRIG(E2) -> c'], ['a & SR(L1, R=rst) -> c'], ['a & RS(L2, R1=rst) -> c'],
    ['GT(level, 80) & LE(level, 100) -> c'], ['EQ(n, 3) | NE(n, 4) | GE(n, 5) | LT(n, 6) -> c'],
    ['a & ADD(total, 1, OUT=total) & SUB(total, 2, OUT=total)'], ['MUL(n, 2, OUT=n)'], ['a & DIV(total, 2, OUT=total)'], ['a & MOVE(level, OUT=total)'], ['TRUE -> c'],
  ];
  for (const [text, comment] of rungs) p = addRung(p, text, comment);
  return p;
}

test('every element kind validates and exports with consistent wiring', () => {
  const p = everythingProject();
  assert.deepEqual(validate(p).filter((i) => i.severity === 'error'), []);
  const xml = exportPlcopen(p);
  const ids = [...xml.matchAll(/ localId="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const m of xml.matchAll(/refLocalId="(\d+)"/g)) assert.ok(ids.includes(m[1]));
});

// Set LADDER_XSD to a copy of the PLCopen TC6 v2.01 schema (tc6_xml_v201.xsd)
// to check the export against it. Needs xmllint on the PATH.
const xsd = process.env.LADDER_XSD;
test('PLCopen export validates against the TC6 schema', { skip: xsd ? false : 'LADDER_XSD is not set' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-xsd-'));
  try {
    for (const [name, project] of [['everything', everythingProject()], ['motor', motorProject()]] as const) {
      const file = path.join(dir, `${name}.xml`);
      fs.writeFileSync(file, exportPlcopen(project));
      const result = spawnSync('xmllint', ['--noout', '--schema', xsd!, file], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || String(result.error));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('editor operations and project file checks work without a server', () => {
  let p = applyOp(emptyProject(), 'set_info', { name: 'Pump' });
  p = applyOp(p, 'upsert_tags', { tags: [{ name: 'float_sw', address: '%IX0.0' }, { name: 'pump', address: '%QX0.0' }] });
  p = applyOp(p, 'add_rung', { text: 'float_sw -> pump' });
  assert.equal(p.name, 'Pump');
  assert.equal(formatRung(p.rungs[0]), 'float_sw -> pump');
  assert.throws(() => applyOp(p, 'add_rung', { text: 5 }), OpError);
  assert.throws(() => applyOp(p, 'no_such_op', {}), OpError);

  // A saved project file reads back unchanged.
  assert.deepEqual(checkProject(JSON.parse(JSON.stringify(p))), p);
  for (const bad of ['text', null, [], { format: 'other', tags: [], rungs: [] }, { format: 'ladder-plc/1', tags: [{ name: 'x', type: 'WORD' }], rungs: [] }, { format: 'ladder-plc/1', tags: [], rungs: [{ id: 'r1', logic: { kind: 'series', items: [{ kind: 'bogus' }] }, coils: [{}] }] }]) {
    assert.throws(() => checkProject(bad), OpError);
  }
});
