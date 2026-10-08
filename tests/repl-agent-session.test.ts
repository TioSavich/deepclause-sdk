/**
 * Authoring-agent session integration (`authoring: 'agent'`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createHarnessRepl, type HarnessRepl } from '../src/repl/index.js';
import type { DMLEvent, LLMBackend, LLMBackendRequest, LLMBackendResponse } from '../src/types.js';

class ScriptedBackend implements LLMBackend {
  readonly calls: LLMBackendRequest[] = [];
  constructor(private readonly responses: LLMBackendResponse[]) {}
  async complete(request: LLMBackendRequest): Promise<LLMBackendResponse> {
    this.calls.push(request);
    return this.responses.shift() ?? { text: 'done', finishReason: 'stop' };
  }
}

async function collect(gen: AsyncGenerator<DMLEvent>): Promise<DMLEvent[]> {
  const events: DMLEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

let workspace: string;
let repl: HarnessRepl | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-agent-'));
});

afterEach(async () => {
  await repl?.dispose();
  repl = undefined;
  await fs.rm(workspace, { recursive: true, force: true });
});

async function openAgent(responses: LLMBackendResponse[]): Promise<ScriptedBackend> {
  const backend = new ScriptedBackend(responses);
  repl = await createHarnessRepl({
    workspacePath: workspace,
    model: 'test-model',
    provider: 'openai',
    streaming: true,
    llmBackend: backend,
    authoring: 'agent',
  });
  return backend;
}

describe('REPL authoring agent', () => {
  it('commits edits made through tools', async () => {
    const backend = await openAgent([
      {
        text: 'adding greet/1',
        toolCalls: [
          { id: '1', name: 'define', arguments: { head: 'greet(Name)', clauses: 'greet(world).' } },
          { id: '2', name: 'finish', arguments: { success: true } },
        ],
        finishReason: 'tool_use',
      },
    ]);
    await collect(repl!.prompt('add a greet/1 fact'));

    expect(backend.calls.length).toBe(1);
    const listing = await repl!.list('greet/1');
    expect(listing).toContain('greet/1');

    const events = await collect(repl!.query('greet(X)'));
    expect(events.some((event) => event.type === 'solution')).toBe(true);
  });

  it('shows a host transaction bracket when the agent edits without begin_turn', async () => {
    await openAgent([
      {
        text: 'adding greet/1',
        toolCalls: [
          { id: '1', name: 'define', arguments: { head: 'greet(Name)', clauses: 'greet(world).' } },
          { id: '2', name: 'finish', arguments: { success: true } },
        ],
        finishReason: 'tool_use',
      },
    ]);
    const events = await collect(repl!.prompt('add a greet/1 fact'));

    const hostBegin = events.find((e) => (
      e.type === 'tool_call' && e.toolName === 'begin_turn' && (e.toolSummary ?? '').includes('(host)')
    ));
    const hostEnd = events.find((e) => (
      e.type === 'tool_call' && e.toolName === 'end_turn' && (e.toolSummary ?? '').includes('(host)')
    ));
    expect(hostBegin).toBeTruthy();
    expect(hostEnd).toBeTruthy();

    // The implicit begin is shown before the first edit.
    const beginIndex = events.findIndex((e) => (
      e.type === 'tool_call' && e.toolName === 'begin_turn' && (e.toolSummary ?? '').includes('(host)')
    ));
    const editIndex = events.findIndex((e) => (
      e.type === 'tool_call' && e.toolName === 'define' && e.toolState === 'starting'
    ));
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeLessThan(editIndex);
  });

  it('does not add a host marker when the agent brackets explicitly', async () => {
    await openAgent([
      {
        text: 'explicit',
        toolCalls: [
          { id: '1', name: 'begin_turn', arguments: {} },
          { id: '2', name: 'define', arguments: { head: 'greet(Name)', clauses: 'greet(world).' } },
          { id: '3', name: 'end_turn', arguments: {} },
          { id: '4', name: 'finish', arguments: { success: true } },
        ],
        finishReason: 'tool_use',
      },
    ]);
    const events = await collect(repl!.prompt('add greet/1 explicitly'));
    const hostMarkers = events.filter((e) => (
      e.type === 'tool_call'
      && (e.toolName === 'begin_turn' || e.toolName === 'end_turn')
      && (e.toolSummary ?? '').includes('(host)')
    ));
    expect(hostMarkers).toHaveLength(0);
  });

  it('rolls back edits made before a rollback tool call', async () => {
    await openAgent([
      {
        text: 'adding then rolling back',
        toolCalls: [
          { id: '1', name: 'define', arguments: { head: 'temp(1)', clauses: 'temp(1).' } },
          { id: '2', name: 'rollback', arguments: {} },
          { id: '3', name: 'finish', arguments: { success: true } },
        ],
        finishReason: 'tool_use',
      },
    ]);
    await collect(repl!.prompt('do not keep temp/1'));

    const listing = await repl!.list('all');
    expect(listing).not.toContain('temp/1');
  });

  it('can run a goal with the execute tool before finishing', async () => {
    const backend = await openAgent([
      {
        text: '',
        toolCalls: [
          { id: '1', name: 'define', arguments: { head: 'fact(N, F)', clauses: 'fact(0, 1).\nfact(N, F) :- N > 0, N1 is N - 1, fact(N1, F1), F is N * F1.' } },
          { id: '2', name: 'execute', arguments: { goal: 'fact(5, F)' } },
          { id: '3', name: 'finish', arguments: { success: true } },
        ],
        finishReason: 'tool_use',
      },
    ]);
    await collect(repl!.prompt('add factorial'));

    // The execute tool result is fed back to the model on a second call.
    expect(backend.calls.length).toBe(1);
    const listing = await repl!.list('fact/2');
    expect(listing).toContain('fact/2');

    const events = await collect(repl!.query('fact(5, F)'));
    const solution = events.find((event) => event.type === 'solution');
    expect(solution?.solution?.bindings).toEqual([{ name: 'F', value: '120' }]);
  });

  it('leaves the harness unchanged when the backend fails', async () => {
    const failing: LLMBackend = { complete: async () => { throw new Error('backend down'); } };
    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      streaming: true,
      llmBackend: failing,
      authoring: 'agent',
    });
    await collect(repl.prompt('add a fact'));
    const listing = await repl.list('all');
    expect(listing.trim()).toBe('');
  });
});

describe('harness edit transactions', () => {
  async function openSession(history = false): Promise<HarnessRepl> {
    const backend: LLMBackend = { complete: async () => ({ text: '', finishReason: 'stop' }) };
    return createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      streaming: true,
      llmBackend: backend,
      authoring: 'agent',
      ...(history ? { history: { enabled: true, dir: '.deepclause/repl' } } : {}),
    });
  }

  it('define replaces every predicate in a multi-predicate block', async () => {
    repl = await openSession();
    await repl.session.define('a(1)', 'a(1).\nb(2).\nc(3).');
    await repl.session.define('a(9)', 'a(9).\nb(8).\nc(7).');

    const listing = await repl.list('all');
    for (const predicate of ['a/1', 'b/1', 'c/1']) {
      expect(listing.split(predicate).length - 1).toBe(1);
    }
    const events = await collect(repl.query('a(X)'));
    const values = events
      .filter((event) => event.type === 'solution')
      .map((event) => event.solution?.bindings[0]?.value);
    expect(values).toEqual(['9']);
  });

  it('delete abolishes a predicate instead of leaving a phantom', async () => {
    repl = await openSession();
    await repl.session.define('temp(1)', 'temp(1).');
    const result = await repl.session.deletePredicate('temp/1');
    expect(result.ok).toBe(true);
    expect(await repl.list('all')).not.toContain('temp/1');
  });

  it('define rejects a non-callable head and does not touch system functors', async () => {
    repl = await openSession();
    const result = await repl.session.define('fetch_page.sh', 'x(1).');
    expect(result.ok).toBe(false);
    const listing = await repl.list('all');
    expect(listing).not.toContain('./2');
  });

  it('forwards execute child events for display', async () => {
    repl = await openSession();
    await repl.session.define('note(X)', 'note(a).\nnote(b).');
    const child: DMLEvent[] = [];
    const result = await repl.session.execute('note(X), output(X)', 5, undefined, (event) => child.push(event));
    expect(result.solutions.length).toBe(2);
    expect(child.some((event) => event.type === 'output')).toBe(true);
    expect(child.some((event) => event.frameKind === 'nested')).toBe(true);
  });

  it('records each changed predicate once in history', async () => {
    repl = await openSession(true);
    await repl.session.beginTurn();
    await repl.session.define('a(1)', 'a(1).\nb(2).');
    await repl.session.endTurn();

    const changesPath = path.join(workspace, '.deepclause', 'repl', 'harness', 'changes.jsonl');
    const lines = (await fs.readFile(changesPath, 'utf8')).trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]) as { changed: Array<{ predicate: string }> };
    const predicates = last.changed.map((change) => change.predicate);
    expect(new Set(predicates).size).toBe(predicates.length);
    expect(predicates).toEqual(expect.arrayContaining(['a/1', 'b/1']));
  });
});
