/**
 * Harness history: sessions, traces, and harness versions persisted under
 * `.deepclause/repl/` and queryable from DML as `harness_*` facts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createHarnessRepl, type HarnessRepl } from '../src/repl/index.js';
import type { DMLEvent, LLMBackend, LLMBackendRequest, LLMBackendResponse } from '../src/types.js';

interface CannedResponse {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

class CannedBackend implements LLMBackend {
  readonly calls: LLMBackendRequest[] = [];

  constructor(private readonly script: CannedResponse[]) {}

  async complete(request: LLMBackendRequest): Promise<LLMBackendResponse> {
    this.calls.push(request);
    const index = this.calls.length - 1;
    const response = this.script[Math.min(index, this.script.length - 1)] ?? { text: '' };
    return {
      text: response.text ?? '',
      toolCalls: (response.toolCalls ?? []).map((call, callIndex) => ({
        id: `${index}-${callIndex}`,
        name: call.name,
        arguments: call.arguments,
      })),
    };
  }
}

function commitResponse(code: string, entry = ''): CannedResponse {
  return {
    text: '',
    toolCalls: [
      { name: 'set_result', arguments: { variable: 'DMLCode', value: code } },
      { name: 'set_result', arguments: { variable: 'EntryGoal', value: entry } },
      { name: 'set_result', arguments: { variable: 'Answer', value: '' } },
      { name: 'finish', arguments: { success: true } },
    ],
  };
}

async function collect(gen: AsyncGenerator<DMLEvent>): Promise<DMLEvent[]> {
  const events: DMLEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function outputs(events: DMLEvent[]): string[] {
  return events.filter((event) => event.type === 'output').map((event) => event.content);
}

const HISTORY = { dir: '.deepclause/repl', trace: 'summary' as const };

let workspace: string;
let repl: HarnessRepl | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-history-'));
});

afterEach(async () => {
  await repl?.dispose();
  repl = undefined;
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('harness history', () => {
  it('records sessions, turns, traces, and versions on disk', async () => {
    const backend = new CannedBackend([commitResponse('repl_entry(demo).\ndemo :- output(hi).', 'demo')]);
    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      streaming: true,
      llmBackend: backend,
      tools: new Map(),
      history: HISTORY,
    });

    const events = await collect(repl.prompt('make a demo'));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const sessionId = repl.session.getSessionId();
    await repl.dispose();
    repl = undefined;

    const history = await fs.readFile(path.join(workspace, '.deepclause/repl/history.dml'), 'utf8');
    expect(history).toContain('harness_session(');
    expect(history).toContain('harness_session_end(');
    expect(history).toContain('harness_turn(');
    expect(history).toContain('harness_change(1,');
    expect(history).toContain('harness_changed(1,');
    expect(history).toContain('harness_head(1,');

    const sessionDir = path.join(workspace, '.deepclause/repl/sessions', sessionId);
    expect(await fs.readFile(path.join(sessionDir, 'turns.jsonl'), 'utf8')).toContain('"outcome":"committed"');
    expect(await fs.readFile(path.join(sessionDir, 'events.jsonl'), 'utf8')).toContain('"type":"output"');

    const head = JSON.parse(await fs.readFile(path.join(workspace, '.deepclause/repl/harness/HEAD.json'), 'utf8'));
    expect(head.version).toBe(1);
    expect(head.sessionId).toBe(sessionId);
  });

  it('loads prior history into a new session so DML can query it', async () => {
    const first = new CannedBackend([commitResponse('repl_entry(demo).\ndemo :- output(hi).', 'demo')]);
    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      llmBackend: first,
      tools: new Map(),
      history: HISTORY,
    });
    await collect(repl.prompt('make a demo'));
    await repl.dispose();
    repl = undefined;

    // Second session: history facts are consulted into the living module.
    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      llmBackend: new CannedBackend([{ text: '' }]),
      tools: new Map(),
      history: HISTORY,
    });

    const changes = await collect(repl.query('harness_change(V, Ts, K, S, T, E), output(V-K-E)'));
    expect(outputs(changes)).toContain('1-commit-demo');

    const sessions = await collect(repl.query('harness_session(S, Started, Model, Backend, Dir)'));
    expect(sessions.filter((event) => event.type === 'solution')).toHaveLength(2);

    // History facts are system-owned: not listed as harness predicates.
    const listing = await repl.list('all');
    expect(listing).not.toContain('harness_');
  });

  it('rolls back the last harness transaction, step by step', async () => {
    const backend = new CannedBackend([
      commitResponse('repl_entry(demo).\ndemo :- output(one).', 'demo'),
      commitResponse('repl_entry(demo).\ndemo :- output(two).', 'demo'),
    ]);
    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      streaming: true,
      llmBackend: backend,
      tools: new Map(),
      history: HISTORY,
    });

    await collect(repl.prompt('first version'));
    expect(outputs(await collect(repl.prompt('second version')))).toContain('two');

    // Undo the second commit -> back to version 1.
    expect(await repl.rollback()).toEqual({ ok: true, from: 2, to: 1 });
    expect(outputs(await collect(repl.query('demo')))).toContain('one');

    // Undo the first commit -> empty harness.
    expect(await repl.rollback()).toEqual({ ok: true, from: 1, to: 0 });
    expect((await collect(repl.query('demo'))).some((event) => event.type === 'error')).toBe(true);

    // Nothing left to undo.
    const nothing = await repl.rollback();
    expect(nothing.ok).toBe(false);
    expect(nothing.error).toMatch(/no harness changes/);

    const history = await fs.readFile(path.join(workspace, '.deepclause/repl/history.dml'), 'utf8');
    expect(history).toContain('harness_rollback(');
    const head = JSON.parse(
      await fs.readFile(path.join(workspace, '.deepclause/repl/harness/HEAD.json'), 'utf8'),
    );
    expect(head.version).toBe(0);
    expect(head.maxVersion).toBe(2);
  });
});
