/**
 * M1 — REPL CLI: input classifier and goal dispatch.
 */
import { describe, expect, it } from 'vitest';

import { classifyReplInput, runGoalWithRenderer } from '../src/cli/repl.js';
import { ReplRenderer } from '../src/repl/render.js';
import type { DMLEvent } from '../src/types.js';
import type { HarnessRepl } from '../src/repl/index.js';

function fakeRepl(events: DMLEvent[]): HarnessRepl {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *query() {
      for (const event of events) {
        yield event;
      }
    },
    prompt: (async function* () {}) as HarnessRepl['prompt'],
    load: async () => ({}),
    list: async () => '',
    freeze: async () => undefined,
    unfreeze: async () => undefined,
    export: async () => ({ path: '', clauses: 0, tools: 0, scripts: 0 }),
    isFrozen: () => false,
    reset: async () => undefined,
    dispose: async () => undefined,
    session: {} as HarnessRepl['session'],
  };
}

describe('classifyReplInput', () => {
  it('classifies goal: as goal mode and never as a prompt', () => {
    expect(classifyReplInput('goal: member(X, [a,b,c]).')).toEqual({
      kind: 'goal',
      goal: 'member(X, [a,b,c]).',
    });
    expect(classifyReplInput('goal: member(X, [a,b').kind).toBe('goal');
  });

  it('classifies anything else as an English prompt', () => {
    expect(classifyReplInput('add a rule that computes factorial')).toEqual({
      kind: 'prompt',
      prompt: 'add a rule that computes factorial',
    });
    expect(classifyReplInput('how many rows are in the CSV?').kind).toBe('prompt');
  });

  it('matches out-of-band commands before the classifier', () => {
    expect(classifyReplInput('halt.')).toEqual({ kind: 'halt' });
    expect(classifyReplInput('help.')).toEqual({ kind: 'help' });
    expect(classifyReplInput('reset.')).toEqual({ kind: 'reset' });
    expect(classifyReplInput('rollback.')).toEqual({ kind: 'rollback' });
    expect(classifyReplInput('freeze.')).toEqual({ kind: 'freeze' });
    expect(classifyReplInput('unfreeze.')).toEqual({ kind: 'unfreeze' });
    expect(classifyReplInput('trace.')).toEqual({ kind: 'trace' });
    expect(classifyReplInput('notrace.')).toEqual({ kind: 'notrace' });
    expect(classifyReplInput('params.')).toEqual({ kind: 'params' });
    expect(classifyReplInput('listing.')).toEqual({ kind: 'listing' });
    expect(classifyReplInput('listing(fact/2).')).toEqual({ kind: 'listing', filter: 'fact/2' });
    expect(classifyReplInput('export harness.dml.')).toEqual({ kind: 'export', path: 'harness.dml' });
  });

  it('ignores blank lines and comments', () => {
    expect(classifyReplInput('   ').kind).toBe('empty');
    expect(classifyReplInput('% a comment').kind).toBe('comment');
  });
});

describe('runGoalWithRenderer', () => {
  it('renders every solution by default', async () => {
    const lines: string[] = [];
    const renderer = new ReplRenderer({ mode: 'plain', sink: (text) => lines.push(text) });
    const events: DMLEvent[] = [
      { type: 'solution', solution: { bindings: [{ name: 'X', value: 'a' }], deterministic: false } },
      { type: 'solution', solution: { bindings: [{ name: 'X', value: 'b' }], deterministic: false } },
      { type: 'finished' },
    ];
    const code = await runGoalWithRenderer(fakeRepl(events), 'member(X,[a,b])', { renderer });
    expect(code).toBe(0);
    expect(lines.join('')).toContain('X = a');
    expect(lines.join('')).toContain('X = b');
  });

  it('prints only the first solution with --first', async () => {
    const lines: string[] = [];
    const renderer = new ReplRenderer({ mode: 'plain', sink: (text) => lines.push(text) });
    const events: DMLEvent[] = [
      { type: 'solution', solution: { bindings: [{ name: 'X', value: 'a' }], deterministic: false } },
      { type: 'solution', solution: { bindings: [{ name: 'X', value: 'b' }], deterministic: false } },
    ];
    await runGoalWithRenderer(fakeRepl(events), 'member(X,[a,b])', { renderer, first: true });
    expect(lines.join('')).toContain('X = a');
    expect(lines.join('')).not.toContain('X = b');
  });

  it('returns a non-zero exit code on error', async () => {
    const lines: string[] = [];
    const renderer = new ReplRenderer({ mode: 'plain', sink: (text) => lines.push(text) });
    const code = await runGoalWithRenderer(fakeRepl([{ type: 'error', content: 'boom' }]), 'bad', { renderer });
    expect(code).toBe(1);
  });
});
