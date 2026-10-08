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
