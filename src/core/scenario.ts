// Headless test scenarios: set inputs, let time pass, check expectations.

import { formatValue, parseValue } from './literals.js';
import { Project } from './model.js';
import { createSim, readRef, runFor, setVar } from './sim.js';

export interface ScenarioStep {
  label?: string;
  /** Tag values to apply before running, e.g. { start_pb: true }. */
  set?: Record<string, unknown>;
  /** Simulated time to run after applying `set`. Omit to run a single scan. */
  run_ms?: number;
  /** Values that must hold afterwards. Keys are tags or block pins such as "T1.Q". */
  expect?: Record<string, unknown>;
}

export interface StepResult {
  step: number;
  label?: string;
  timeMs: number;
  values: Record<string, string>;
  failures: string[];
}

export interface ScenarioResult {
  passed: boolean;
  steps: StepResult[];
}

export function runScenario(project: Project, steps: ScenarioStep[], watch?: string[]): ScenarioResult {
  const state = createSim(project);
  const watched = new Set<string>(watch ?? []);
  if (!watch) {
    for (const tag of project.tags) if (/^%Q/.test(tag.address ?? '')) watched.add(tag.name);
    for (const step of steps) {
      Object.keys(step.set ?? {}).forEach((k) => watched.add(k));
      Object.keys(step.expect ?? {}).forEach((k) => watched.add(k));
    }
  }

  const results: StepResult[] = [];
  steps.forEach((step, index) => {
    const failures: string[] = [];
    for (const [name, value] of Object.entries(step.set ?? {})) {
      const problem = setVar(project, state, name, value);
      if (problem) failures.push(`set: ${problem}`);
    }
    runFor(project, state, step.run_ms ?? 0);
    for (const [ref, expected] of Object.entries(step.expect ?? {})) {
      const actual = readRef(project, state, ref);
      if (!actual) {
        failures.push(`expect: unknown tag or pin "${ref}"`);
        continue;
      }
      const want = parseValue(actual.type, expected);
      if (want === undefined) {
        failures.push(`expect: "${String(expected)}" is not a valid ${actual.type} value for ${ref}`);
        continue;
      }
      const equal = actual.type === 'REAL' ? Math.abs(Number(actual.value) - Number(want)) <= 1e-6 * Math.max(1, Math.abs(Number(want))) : actual.value === want;
      if (!equal) failures.push(`${ref} is ${formatValue(actual.type, actual.value)}, expected ${formatValue(actual.type, want)}`);
    }
    const values: Record<string, string> = {};
    for (const ref of watched) {
      const r = readRef(project, state, ref);
      if (r) values[ref] = formatValue(r.type, r.value);
    }
    results.push({ step: index + 1, label: step.label, timeMs: state.timeMs, values, failures });
  });

  return { passed: results.every((r) => r.failures.length === 0), steps: results };
}

export function formatScenarioResult(result: ScenarioResult): string {
  const lines = result.steps.map((s) => {
    const head = `${s.failures.length ? 'FAIL' : 'ok  '} step ${s.step}${s.label ? ` (${s.label})` : ''} @ ${s.timeMs} ms`;
    const values = Object.entries(s.values).map(([k, v]) => `${k}=${v}`).join('  ');
    return [head, `     ${values}`, ...s.failures.map((f) => `     ! ${f}`)].join('\n');
  });
  return `${result.passed ? 'PASSED' : 'FAILED'}\n${lines.join('\n')}`;
}
