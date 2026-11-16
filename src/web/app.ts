// Simulator front end: draws the ladder, runs the scan cycle in the browser
// with live power flow, and edits the project through a backend: the local
// server's HTTP API, or this browser's storage on a static host.

import { BlockDef, blockDef, blockReference } from '../core/blocks.js';
import { DSL_REFERENCE, formatRung } from '../core/dsl.js';
import { commonLogicCols } from '../core/layout.js';
import { formatTime, formatValue, parseOperand } from '../core/literals.js';
import { Block, Coil, Contact, DATA_TYPES, Project, Rung, Tag, emptyProject, walk } from '../core/model.js';
import { exportPlcopen } from '../core/plcopen.js';
import { SimState, createSim, initialValue, readRef, scan, setVar } from '../core/sim.js';
import type { Issue } from '../core/validate.js';
import { Snapshot, createBackend, isLocal } from './backend.js';
import { addCoil, changeCoil, changeNode, deleteCoil, deleteNode, findElement, insertParallel, insertSeries } from './edit.js';
import { rungSvg } from './render.js';

type Child = Node | string | null | undefined | false;

/** Small DOM builder: h('button', { class: 'x', onclick: fn }, 'Label'). */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'class') el.className = String(value);
    else if (key === 'value') (el as unknown as HTMLInputElement).value = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
// Kept as a reference because it leaves the document while it is being renamed.
const projectName = $('#project-name');

let project: Project = emptyProject();
let issues: Issue[] = [];
let sim: SimState = createSim(project);
let running = true;
let lastJson = '';
const backend = createBackend();

let liveWires: { el: Element; id: string; side: 'in' | 'out' }[] = [];
let liveEls: { el: Element; id: string }[] = [];
let liveTexts: { el: Element; ref: string }[] = [];
let instances: { name: string; node: Block; def: BlockDef }[] = [];

// ---------------------------------------------------------------- project

function toast(message: string): void {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  window.clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(window.setTimeout(() => (el.hidden = true), 6000));
}

function apply(snapshot: Snapshot): void {
  const json = JSON.stringify(snapshot);
  if (json === lastJson) return;
  lastJson = json;
  $('#toast').hidden = true;
  project = snapshot.project;
  issues = snapshot.issues;
  sim = createSim(project, sim);
  $('#file-path').textContent = snapshot.path;
  $('#file-path').title = snapshot.path;
  closePopover();
  rebuild();
  refreshFileTools();
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function load(): Promise<void> {
  try {
    apply(await backend.load());
  } catch (e) {
    toast(`Could not load the project: ${message(e)}`);
  }
}

/** Apply an edit to the project. Resolves to true when it was accepted. */
async function op(name: string, args: Record<string, unknown>): Promise<boolean> {
  try {
    apply(await backend.op(name, args));
    return true;
  } catch (e) {
    toast(message(e));
    return false;
  }
}

// ---------------------------------------------------------------- simulation

function setBit(tag: Tag, value: boolean): void {
  sim.vars[tag.name] = value;
  paint();
}

function paint(): void {
  for (const w of liveWires) w.el.classList.toggle('on', Boolean(sim.flow[w.id]?.[w.side]));
  for (const e of liveEls) {
    const flow = sim.flow[e.id];
    e.el.classList.toggle('on', Boolean(flow?.out));
    e.el.classList.toggle('closed', Boolean(flow?.closed));
  }
  for (const t of liveTexts) {
    const ref = readRef(project, sim, t.ref);
    const text = ref ? `${t.ref.split('.')[1]} ${formatValue(ref.type, ref.value)}` : '';
    if (t.el.textContent !== text) t.el.textContent = text;
  }

  for (const row of document.querySelectorAll<HTMLElement>('.tag')) {
    const tag = project.tags.find((t) => t.name === row.dataset.tag);
    if (!tag) continue;
    const value = sim.vars[tag.name];
    const lamp = row.querySelector('.lamp');
    if (lamp) {
      lamp.classList.toggle('on', value === true);
      lamp.textContent = value ? '1' : '0';
      lamp.setAttribute('aria-pressed', String(value === true));
    }
    const hold = row.querySelector('.hold');
    if (hold) hold.classList.toggle('pressed', value !== initialValue({ ...tag, initial: undefined }));
    const num = row.querySelector<HTMLInputElement>('.num');
    if (num && document.activeElement !== num) {
      const text = formatValue(tag.type, value);
      if (num.value !== text) num.value = text;
    }
  }

  for (const row of document.querySelectorAll<HTMLElement>('.inst')) {
    const inst = instances.find((i) => i.name === row.dataset.inst);
    if (!inst) continue;
    const fb = sim.fb[inst.name] ?? { Q: false, ET: 0, CV: 0 };
    row.querySelector('.lamp')!.classList.toggle('on', fb.Q);
    const limitText = inst.node.inputs.PT ?? inst.node.inputs.PV;
    let ratio = 0;
    let text = fb.Q ? 'on' : 'off';
    if (limitText !== undefined) {
      const operand = parseOperand(limitText, project);
      const limit = Number(operand.kind === 'literal' ? operand.value : operand.kind === 'tag' ? sim.vars[operand.name] : 0);
      const isTimer = inst.node.inputs.PT !== undefined;
      const current = isTimer ? fb.ET : fb.CV;
      ratio = limit > 0 ? Math.max(0, Math.min(1, current / limit)) : 0;
      text = isTimer ? `${(current / 1000).toFixed(1)} / ${(limit / 1000).toFixed(1)} s` : `${current} / ${limit}`;
    }
    (row.querySelector('.bar-track i') as HTMLElement).style.width = `${ratio * 100}%`;
    row.querySelector('.val')!.textContent = text;
  }

  $('#clock').textContent = `t = ${(sim.timeMs / 1000).toFixed(2)} s · scan ${sim.scans}`;
}

function setRunning(value: boolean): void {
  running = value;
  $('#btn-run').textContent = running ? 'Pause' : 'Run';
  const mode = $('#mode');
  mode.textContent = running ? 'RUN' : 'STOP';
  mode.classList.toggle('stopped', !running);
}

let lastTick = performance.now();
let pending = 0;
window.setInterval(() => {
  const now = performance.now();
  const elapsed = Math.min(now - lastTick, 500);
  lastTick = now;
  if (!running) return;
  pending += elapsed;
  let scans = 0;
  while (pending >= project.scanMs && scans < 200) {
    scan(project, sim);
    pending -= project.scanMs;
    scans++;
  }
  if (scans > 0) paint();
}, 16);

// ---------------------------------------------------------------- popover

let selected: Element | null = null;

function closePopover(): void {
  $('#popover').hidden = true;
  selected?.classList.remove('selected');
  selected = null;
}

function openPopover(anchor: DOMRect, ...content: Child[]): void {
  const pop = $('#popover');
  pop.replaceChildren(...content.filter((c): c is Node | string => Boolean(c)));
  pop.hidden = false;
  const box = pop.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8));
  const below = anchor.bottom + 8;
  const top = below + box.height > window.innerHeight - 8 ? Math.max(8, anchor.top - box.height - 8) : below;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function field(labelText: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', {}, labelText), control);
}

function select(options: [string, string][], value: string, onchange?: (value: string) => void): HTMLSelectElement {
  const el = h('select', {}, ...options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
  el.value = value;
  if (onchange) el.addEventListener('change', () => onchange(el.value));
  return el;
}

function boolTagOptions(current: string): [string, string][] {
  const names = project.tags.filter((t) => t.type === 'BOOL').map((t) => t.name);
  if (!names.some((n) => n.toLowerCase() === current.toLowerCase())) names.unshift(current);
  return names.map((n) => [n, n]);
}

function firstBoolTag(): string | undefined {
  const tag = project.tags.find((t) => t.type === 'BOOL');
  if (!tag) toast('Add a BOOL tag first.');
  return tag?.name;
}

function elementPopover(rungNumber: number, id: string, anchor: DOMRect): void {
  const rung = project.rungs[rungNumber - 1];
  const node = rung && findElement(rung, id);
  if (!node) return;
  const save = (text: string) => op('update_rung', { rung: rungNumber, text });

  if (node.kind === 'contact') {
    const contact = node as Contact;
    const tag = project.tags.find((t) => t.name.toLowerCase() === contact.tag.toLowerCase());
    openPopover(
      anchor,
      h('h3', {}, 'Contact'),
      h('p', {}, tag?.address ? `${tag.address}${tag.fieldContact ? ` · ${tag.fieldContact}-wired device` : ''}${tag.comment ? ` · ${tag.comment}` : ''}` : tag?.comment || 'Passes power depending on the state of a bit.'),
      field('Tag', select(boolTagOptions(contact.tag), contact.tag, (v) => save(changeNode(rung, id, { tag: v } as Partial<Contact>)))),
      field(
        'Type',
        select(
          [
            ['NO', 'Normally open  -| |-'],
            ['NC', 'Normally closed  -|/|-'],
            ['P', 'Rising edge  -|P|-'],
            ['N', 'Falling edge  -|N|-'],
          ],
          contact.mode,
          (v) => save(changeNode(rung, id, { mode: v } as Partial<Contact>)),
        ),
      ),
      h(
        'div',
        { class: 'buttons' },
        tag && h('button', { type: 'button', onclick: () => setBit(tag, !sim.vars[tag.name]) }, 'Toggle bit'),
        h('button', { type: 'button', onclick: () => { const t = firstBoolTag(); if (t) save(insertSeries(rung, id, t)); } }, '+ Series'),
        h('button', { type: 'button', onclick: () => { const t = firstBoolTag(); if (t) save(insertParallel(rung, id, t)); } }, '+ Parallel'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'danger', onclick: () => save(deleteNode(rung, id)) }, 'Delete'),
      ),
    );
    return;
  }

  if (node.kind === 'coil') {
    const coil = node as Coil;
    openPopover(
      anchor,
      h('h3', {}, 'Coil'),
      h('p', {}, 'Writes the rung result to a bit.'),
      field('Tag', select(boolTagOptions(coil.tag), coil.tag, (v) => save(changeCoil(rung, id, { tag: v })))),
      field(
        'Type',
        select(
          [
            ['normal', 'Coil  -( )-'],
            ['negated', 'Negated  -(/)-'],
            ['set', 'Set / latch  -(S)-'],
            ['reset', 'Reset / unlatch  -(R)-'],
          ],
          coil.mode,
          (v) => save(changeCoil(rung, id, { mode: v as Coil['mode'] })),
        ),
      ),
      h(
        'div',
        { class: 'buttons' },
        h('button', { type: 'button', onclick: () => { const t = firstBoolTag(); if (t) save(addCoil(rung, t)); } }, '+ Coil'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'danger', onclick: () => save(deleteCoil(rung, id)) }, 'Delete'),
      ),
    );
    return;
  }

  if (node.kind === 'block') {
    const block = node as Block;
    const def = blockDef(block.type);
    const instance = h('input', { value: block.instance ?? '' });
    const inputs = (def?.inputs ?? []).map((p) => ({ pin: p.name, el: h('input', { value: block.inputs[p.name] ?? '', placeholder: p.required ? 'required' : 'optional' }) }));
    const outputs = (def?.outputs ?? []).map((p) => ({ pin: p.name, el: h('input', { value: block.outputs[p.name] ?? '', placeholder: p.required ? 'tag (required)' : 'tag (optional)' }) }));
    const collect = (list: { pin: string; el: HTMLInputElement }[]) => Object.fromEntries(list.filter((x) => x.el.value.trim()).map((x) => [x.pin, x.el.value.trim()]));
    const submit = (event: Event) => {
      event.preventDefault();
      const patch: Partial<Block> = { inputs: collect(inputs), outputs: collect(outputs) };
      if (def?.kind === 'fb') patch.instance = instance.value.trim();
      save(changeNode(rung, id, patch));
    };
    openPopover(
      anchor,
      h(
        'form',
        { onsubmit: submit },
        h('h3', {}, block.type),
        h('p', {}, def?.doc ?? 'Unknown block type.'),
        def?.kind === 'fb' && field('Instance', instance),
        ...inputs.map((x) => field(x.pin, x.el)),
        ...outputs.map((x) => field(`${x.pin} →`, x.el)),
        h(
          'div',
          { class: 'buttons' },
          h('button', { type: 'submit', class: 'primary' }, 'Save'),
          h('button', { type: 'button', onclick: () => { const t = firstBoolTag(); if (t) save(insertSeries(rung, id, t)); } }, '+ Series'),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'danger', onclick: () => save(deleteNode(rung, id)) }, 'Delete'),
        ),
      ),
    );
  }
}

function tagPopover(tag: Tag, anchor: DOMRect): void {
  const name = h('input', { value: tag.name });
  const type = select(DATA_TYPES.map((t) => [t, t]), tag.type);
  const address = h('input', { value: tag.address ?? '', placeholder: 'e.g. %IX0.0 (blank = internal)' });
  const wiring = select([['', 'Not a field device'], ['NO', 'NO: bit is 1 when actuated'], ['NC', 'NC: bit is 0 when actuated']], tag.fieldContact ?? '');
  const initial = h('input', { value: tag.initial === undefined ? '' : formatValue(tag.type, tag.initial), placeholder: 'power-on value' });
  const comment = h('input', { value: tag.comment ?? '' });
  const submit = async (event: Event) => {
    event.preventDefault();
    const newName = name.value.trim();
    if (newName !== tag.name && !(await op('rename_tag', { name: tag.name, newName }))) return;
    await op('upsert_tags', {
      tags: [{ name: newName, type: type.value, address: address.value.trim() || null, fieldContact: wiring.value || null, initial: initial.value.trim() || null, comment: comment.value.trim() || null }],
    });
  };
  openPopover(
    anchor,
    h(
      'form',
      { onsubmit: submit },
      h('h3', {}, 'Tag'),
      h('p', {}, 'Renaming updates every rung that uses the tag.'),
      field('Name', name),
      field('Type', type),
      field('Address', address),
      field('Wiring', wiring),
      field('Initial', initial),
      field('Comment', comment),
      h(
        'div',
        { class: 'buttons' },
        h('button', { type: 'submit', class: 'primary' }, 'Save'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'danger', onclick: () => op('remove_tag', { name: tag.name }) }, 'Delete'),
      ),
    ),
  );
}

// ---------------------------------------------------------------- ladder view

/** Swap an element for a text input; Enter saves, Escape or blur cancels. */
function inlineEdit(target: HTMLElement, value: string, cls: string, save: (value: string) => Promise<boolean>): void {
  const input = h('input', { class: `inline-edit ${cls}`, value, spellcheck: 'false' });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    input.replaceWith(target);
  };
  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape') finish();
    if (event.key === 'Enter') {
      event.preventDefault();
      if (input.value === value) return finish();
      if (await save(input.value)) finish();
      else input.focus();
    }
  });
  input.addEventListener('blur', () => window.setTimeout(finish, 150));
  target.replaceWith(input);
  input.focus();
  input.select();
}

function rungView(rung: Rung, index: number, logicCols: number): HTMLElement {
  const n = index + 1;
  const text = formatRung(rung);
  const comment = h('span', { class: `comment${rung.comment ? '' : ' empty'}`, title: 'Click to edit the comment' }, rung.comment || 'Add a comment');
  comment.addEventListener('click', () => inlineEdit(comment, rung.comment ?? '', 'comment-edit', (v) => op('update_rung', { rung: n, comment: v.trim() || null })));
  const code = h('code', { title: 'Click to edit the rung as text' }, text);
  const editText = () => inlineEdit(code, text, '', (v) => op('update_rung', { rung: n, text: v }));
  code.addEventListener('click', editText);

  const diagram = h('div', { class: 'diagram' });
  diagram.innerHTML = rungSvg(rung, project, logicCols);
  diagram.addEventListener('click', (event) => {
    const el = (event.target as Element).closest('[data-el]');
    if (!el) return;
    event.stopPropagation();
    closePopover();
    selected = el;
    el.classList.add('selected');
    elementPopover(n, el.getAttribute('data-el')!, el.querySelector('.hit')!.getBoundingClientRect());
  });

  const rungIssues = issues.filter((i) => i.rung === n);
  return h(
    'article',
    { class: 'rung' },
    h(
      'header',
      {},
      h('span', { class: 'rung-no' }, String(n)),
      comment,
      h(
        'span',
        { class: 'tools' },
        h('button', { type: 'button', class: 'ghost', title: 'Edit as text', onclick: editText }, 'Edit'),
        n > 1 && h('button', { type: 'button', class: 'ghost', title: 'Move up', 'aria-label': 'Move rung up', onclick: () => op('move_rung', { rung: n, to: n - 1 }) }, '↑'),
        n < project.rungs.length && h('button', { type: 'button', class: 'ghost', title: 'Move down', 'aria-label': 'Move rung down', onclick: () => op('move_rung', { rung: n, to: n + 1 }) }, '↓'),
        h('button', { type: 'button', class: 'ghost danger', title: 'Delete rung', 'aria-label': 'Delete rung', onclick: () => { if (window.confirm(`Delete rung ${n}?\n\n${text}`)) op('remove_rung', { rung: n }); } }, '✕'),
      ),
    ),
    diagram,
    h('div', { class: 'text' }, code),
    rungIssues.length > 0 && h('ul', { class: 'rung-issues' }, ...rungIssues.map((i) => h('li', { class: `issue ${i.severity}` }, `${i.severity === 'error' ? 'Error' : 'Warning'}: ${i.message}`))),
  );
}

const addRungForm = (() => {
  const text = h('input', { name: 'text', placeholder: '(start_pb | motor) & stop_pb -> motor', spellcheck: 'false', 'aria-label': 'Rung text' });
  const comment = h('input', { name: 'comment', placeholder: 'Comment (optional)', 'aria-label': 'Rung comment' });
  return h(
    'form',
    {
      class: 'add-rung',
      onsubmit: async (event: Event) => {
        event.preventDefault();
        if (!text.value.trim()) return;
        if (await op('add_rung', { text: text.value, comment: comment.value.trim() || undefined })) {
          text.value = '';
          comment.value = '';
        }
      },
    },
    h('div', { class: 'row' }, text, comment, h('button', { type: 'submit', class: 'primary' }, 'Add rung')),
    h('details', {}, h('summary', {}, 'Rung text syntax and blocks'), h('pre', {}, `${DSL_REFERENCE}\n\nBlocks:\n${blockReference()}`)),
  );
})();

// ---------------------------------------------------------------- side panel

function tagRow(tag: Tag): HTMLElement {
  const isInput = /^%I/.test(tag.address ?? '');
  const rest = initialValue({ ...tag, initial: undefined });
  let control: HTMLElement;
  if (tag.type === 'BOOL') {
    control = h('button', { type: 'button', class: 'lamp', title: 'Toggle this bit', onclick: () => setBit(tag, !sim.vars[tag.name]) }, '0');
  } else {
    const input = h('input', { class: 'num', 'aria-label': `Value of ${tag.name}` });
    input.addEventListener('change', () => {
      const problem = setVar(project, sim, tag.name, input.value);
      if (problem) toast(problem);
      input.blur();
      paint();
    });
    control = input;
  }
  let hold: HTMLElement | false = false;
  if (isInput && tag.type === 'BOOL') {
    // A momentary device: actuated while held. For an NC-wired device that opens the circuit (bit goes to 0).
    hold = h('button', { type: 'button', class: 'hold', title: `Hold to actuate (bit becomes ${rest ? 0 : 1})` }, 'Press');
    hold.addEventListener('pointerdown', (e) => {
      (e.target as Element).setPointerCapture(e.pointerId);
      setBit(tag, !rest);
    });
    for (const type of ['pointerup', 'pointercancel']) hold.addEventListener(type, () => setBit(tag, Boolean(rest)));
    hold.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) setBit(tag, !rest); });
    hold.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') setBit(tag, Boolean(rest)); });
  }
  const more = h('button', { type: 'button', class: 'ghost', title: 'Edit tag', 'aria-label': `Edit tag ${tag.name}` }, '⋯');
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    closePopover();
    tagPopover(tag, more.getBoundingClientRect());
  });
  return h(
    'div',
    { class: 'tag', 'data-tag': tag.name },
    control,
    h(
      'div',
      { class: 'meta' },
      h('div', { class: 'tname' }, tag.name, tag.address && h('span', { class: 'addr' }, tag.address), tag.type !== 'BOOL' && h('span', { class: 'kind' }, tag.type), tag.fieldContact && h('span', { class: 'badge', title: `Field device wired normally ${tag.fieldContact === 'NC' ? 'closed' : 'open'}` }, tag.fieldContact)),
      tag.comment && h('div', { class: 'tcomment' }, tag.comment),
    ),
    hold,
    more,
  );
}

const addTagForm = (() => {
  const name = h('input', { placeholder: 'Tag name', 'aria-label': 'Tag name' });
  const type = select(DATA_TYPES.map((t) => [t, t]), 'BOOL');
  const address = h('input', { placeholder: 'Address, e.g. %IX0.0', 'aria-label': 'Address' });
  const wiring = select([['', 'Wiring'], ['NO', 'NO'], ['NC', 'NC']], '');
  const comment = h('input', { class: 'wide', placeholder: 'Comment (optional)', 'aria-label': 'Comment' });
  return h(
    'form',
    {
      class: 'add-tag',
      onsubmit: async (event: Event) => {
        event.preventDefault();
        if (!name.value.trim()) return;
        const ok = await op('upsert_tags', { tags: [{ name: name.value.trim(), type: type.value, address: address.value.trim() || null, fieldContact: wiring.value || null, comment: comment.value.trim() || null }] });
        if (ok) for (const el of [name, address, comment]) el.value = '';
      },
    },
    name,
    type,
    address,
    wiring,
    comment,
    h('button', { type: 'submit', class: 'wide' }, 'Add tag'),
  );
})();

function buildPanel(): void {
  const general = issues.filter((i) => !i.rung);
  const inputs = project.tags.filter((t) => /^%I/.test(t.address ?? ''));
  const outputs = project.tags.filter((t) => /^%Q/.test(t.address ?? ''));
  const memory = project.tags.filter((t) => !/^%[IQ]/.test(t.address ?? ''));
  const section = (title: string, hint: string, tags: Tag[]) => (tags.length ? [h('h2', {}, title), h('p', { class: 'hint' }, hint), ...tags.map(tagRow)] : []);

  $('#panel').replaceChildren(
    ...(general.length ? [h('h2', {}, 'Issues'), h('ul', { class: 'issues' }, ...general.map((i) => h('li', { class: `issue ${i.severity}` }, i.message)))] : []),
    ...section('Inputs', 'Field devices. Hold Press to actuate one, or click the bit to latch it.', inputs),
    ...section('Outputs', 'Driven by the program each scan.', outputs),
    ...section('Internal', 'Memory bits and values.', memory),
    ...(instances.length
      ? [
          h('h2', {}, 'Timers and counters'),
          ...instances.map((i) =>
            h(
              'div',
              { class: 'inst', 'data-inst': i.name },
              h('span', { class: 'lamp' }),
              h('div', { class: 'meta' }, h('div', { class: 'tname' }, i.name, h('span', { class: 'kind' }, i.def.type)), h('div', { class: 'bar-track' }, h('i', {}))),
              h('span', { class: 'val' }),
            ),
          ),
        ]
      : []),
    h('h2', {}, 'Add tag'),
    addTagForm,
  );
}

function rebuild(): void {
  document.title = `${project.name} · Ladder Simulator`;
  projectName.textContent = project.name;

  instances = [];
  for (const rung of project.rungs) {
    walk(rung.logic, (node) => {
      const def = node.kind === 'block' ? blockDef(node.type) : undefined;
      if (node.kind === 'block' && def?.kind === 'fb' && node.instance && !instances.some((i) => i.name === node.instance)) instances.push({ name: node.instance, node, def });
    });
  }

  const logicCols = commonLogicCols(project.rungs);
  const ladder = $('#ladder');
  ladder.replaceChildren(
    ...(project.rungs.length
      ? project.rungs.map((r, i) => rungView(r, i, logicCols))
      : [h('div', { class: 'empty-state' }, backend.local ? 'No rungs yet. Add a rung below, or open a project file from the File menu.' : 'No rungs yet. Ask Claude to build the logic, or add a rung below.')]),
    addRungForm,
  );
  buildPanel();

  liveWires = [...ladder.querySelectorAll('[data-sig]')].map((el) => {
    const [id, side] = el.getAttribute('data-sig')!.split(/:(?=in$|out$)/);
    return { el, id, side: side as 'in' | 'out' };
  });
  liveEls = [...ladder.querySelectorAll('[data-el]')].map((el) => ({ el, id: el.getAttribute('data-el')! }));
  liveTexts = [...ladder.querySelectorAll('[data-live]')].map((el) => ({ el, ref: el.getAttribute('data-live')! }));
  paint();
}

// ---------------------------------------------------------------- wiring up

$('#btn-run').addEventListener('click', () => setRunning(!running));
$('#btn-step').addEventListener('click', () => {
  setRunning(false);
  scan(project, sim);
  paint();
});
$('#btn-reset').addEventListener('click', () => {
  sim = createSim(project);
  paint();
});

document.addEventListener('click', (event) => {
  const pop = $('#popover');
  if (!pop.hidden && !pop.contains(event.target as Node)) closePopover();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePopover();
});

// ---------------------------------------------------------------- files

const fileBase = () => (project.name || 'project').replace(/[^A-Za-z0-9_-]+/g, '_');

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#btn-export').addEventListener('click', () => {
  const errors = issues.filter((i) => i.severity === 'error').length;
  if (errors && !window.confirm(`The project has ${errors} error${errors === 1 ? '' : 's'}, so a PLC editor may reject the file. Export anyway?`)) return;
  download(`${fileBase()}.xml`, exportPlcopen(project), 'application/xml');
});

projectName.title = 'Click to rename the project';
projectName.addEventListener('click', () => inlineEdit(projectName, project.name, 'name-edit', (v) => op('set_info', { name: v })));

function refreshFileTools(): void {
  if (!isLocal(backend)) return;
  ($('#btn-undo') as HTMLButtonElement).disabled = !backend.canUndo();
  ($('#btn-redo') as HTMLButtonElement).disabled = !backend.canRedo();
}

if (isLocal(backend)) {
  const local = backend;
  const menu = $('#file-menu') as HTMLDetailsElement;
  const picker = $('#file-picker') as HTMLInputElement;
  $('#local-tools').hidden = false;

  const hasWork = () => project.rungs.length > 0 || project.tags.length > 0;
  const mayReplace = () => !hasWork() || window.confirm(`Replace the current project "${project.name}"?\n\nSave it to a file first if you want to keep it.`);
  const item = (id: string, action: () => void | Promise<void>) =>
    $(id).addEventListener('click', async () => {
      menu.open = false;
      try {
        await action();
      } catch (e) {
        toast(message(e));
      }
    });

  item('#file-new', () => {
    if (mayReplace()) apply(local.replace(emptyProject()));
  });
  item('#file-open', () => picker.click());
  item('#file-save', () => download(`${fileBase()}.ladder.json`, JSON.stringify(project, null, 2) + '\n', 'application/json'));
  item('#file-demo', async () => {
    if (mayReplace()) apply(await local.loadDemo());
  });

  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file || !mayReplace()) return;
    try {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} is not valid JSON`);
      }
      apply(local.replace(data));
    } catch (e) {
      toast(message(e));
    }
  });

  const undo = () => {
    const snapshot = local.undo();
    if (snapshot) apply(snapshot);
  };
  const redo = () => {
    const snapshot = local.redo();
    if (snapshot) apply(snapshot);
  };
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);

  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') menu.open = false;
    // Leave the browser's own undo alone while typing in a field.
    if ((event.target as Element).closest('input, select, textarea')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
  });
}

backend.onChange(() => void load());
setRunning(true);
void load();
