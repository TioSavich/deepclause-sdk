/**
 * The TS authoring agent: harness tools and the agent loop.
 */
import { describe, expect, it, vi } from 'vitest';

import { HarnessAgent } from '../src/repl/agent.js';
import { createHarnessTools, type HarnessToolController } from '../src/repl/harness-tools.js';
import type { DMLEvent, LLMBackend, LLMBackendRequest, LLMBackendResponse } from '../src/types.js';

function stubController(overrides: Partial<HarnessToolController> = {}): {
  controller: HarnessToolController;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = <T>(method: string, value: T): T => {
    calls.push({ method, args: [] });
    return value;
  };
  const controller: HarnessToolController = {
    isFrozen: () => record('isFrozen', false),
    listing: async (filter) => record('listing', `${filter}: a/1`),
    manifest: async () => record('manifest', 'a/1'),
    beginTurn: async () => { record('beginTurn', undefined); },
    endTurn: async () => record('endTurn', { committed: true, changed: ['+a/1'] }),
    rollbackTurn: async () => { record('rollbackTurn', undefined); },
    define: async (head, clauses) => { record('define', undefined); return { ok: true, head, clauses } as { ok: boolean }; },
    assertClause: async () => record('assertClause', { ok: true }),
    assertMany: async () => record('assertMany', { ok: true }),
    retractClause: async () => record('retractClause', { ok: true }),
    deletePredicate: async (predicate) => { record('deletePredicate', undefined); return { ok: true, predicate } as { ok: boolean }; },
    execute: async () => record('execute', { bindings: [], solutions: [], output: 'ok' }),
    readFile: async () => record('readFile', 'content'),
    writeFile: async () => { record('writeFile', undefined); },
    listFiles: async () => record('listFiles', ['a.dml']),
    deleteFile: async () => { record('deleteFile', undefined); },
    askUser: async () => record('askUser', 'yes'),
    reference: async () => record('reference', 'reference text'),
    ...overrides,
  };
  return { controller, calls };
}

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

describe('createHarnessTools', () => {
  it('exposes the harness editing tools', () => {
    const { controller } = stubController();
    const names = [...createHarnessTools(controller).keys()];
    for (const expected of [
      'listing', 'begin_turn', 'end_turn', 'rollback', 'define', 'assert', 'assert_many',
      'retract', 'delete', 'execute', 'read_file', 'write_file', 'list_files', 'delete_file',
      'ask_user', 'reference',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('routes each tool to the controller', async () => {
    const { controller, calls } = stubController();
    const tools = createHarnessTools(controller);
    await tools.get('define')!.execute({ head: 'a(1)', clauses: 'a(1).' });
    await tools.get('assert')!.execute({ clause: 'b(1).' });
    await tools.get('delete')!.execute({ predicate: 'c/1' });
    await tools.get('execute')!.execute({ goal: 'a(X)' });
    await tools.get('listing')!.execute({ filter: 'all' });
    expect(calls.map((call) => call.method)).toEqual(
      expect.arrayContaining(['define', 'assertClause', 'deletePredicate', 'execute', 'listing']),
    );
  });

  it('refuses edits when the harness is frozen', async () => {
    const { controller } = stubController({ isFrozen: () => true });
    const tools = createHarnessTools(controller);
    expect(await tools.get('define')!.execute({ head: 'a(1)', clauses: 'a(1).' })).toMatchObject({ ok: false });
    expect(await tools.get('assert')!.execute({ clause: 'a(1).' })).toMatchObject({ ok: false });
  });
});

describe('HarnessAgent', () => {
  it('runs a tool, then finishes', async () => {
    const { controller, calls } = stubController();
    const backend = new ScriptedBackend([
      { text: 'editing', toolCalls: [{ id: '1', name: 'define', arguments: { head: 'a(1)', clauses: 'a(1).' } }], finishReason: 'tool_use' },
      { text: 'done', toolCalls: [{ id: '2', name: 'finish', arguments: { success: true } }], finishReason: 'tool_use' },
    ]);
    const agent = new HarnessAgent({
      controller,
      tools: createHarnessTools(controller),
      llmBackend: backend,
      model: 'test-model',
      streaming: true,
    });
    const events = await collect(agent.run('add a fact'));
    expect(calls.map((call) => call.method)).toEqual(expect.arrayContaining(['define', 'manifest']));
    expect(events.some((event) => event.type === 'tool_call' && event.toolName === 'define')).toBe(true);
    expect(backend.calls).toHaveLength(2);
    expect(agent.getMessages().some((message) => message.role === 'user' && message.content === 'add a fact')).toBe(true);
  });

  it('streams text and reasoning deltas', async () => {
    const { controller } = stubController();
    const backend: LLMBackend = {
      complete: async (request) => {
        request.onText?.('hel');
        request.onText?.('lo');
        request.onReasoning?.('think');
        return {
          text: 'hello',
          toolCalls: [{ id: '1', name: 'finish', arguments: { success: true } }],
          finishReason: 'tool_use',
        };
      },
    };
    const agent = new HarnessAgent({ controller, tools: createHarnessTools(controller), llmBackend: backend, model: 'm', streaming: true });
    const events = await collect(agent.run('hi'));
    expect(events.filter((event) => event.type === 'stream').map((event) => event.content)).toEqual(['hel', 'lo']);
    expect(events.some((event) => event.type === 'reasoning' && event.content === 'think')).toBe(true);
  });

  it('reports a backend error', async () => {
    const { controller } = stubController();
    const backend: LLMBackend = { complete: vi.fn(async () => { throw new Error('boom'); }) };
    const agent = new HarnessAgent({ controller, tools: createHarnessTools(controller), llmBackend: backend, model: 'm', streaming: true });
    const events = await collect(agent.run('hi'));
    expect(events.some((event) => event.type === 'error' && (event.content ?? '').includes('boom'))).toBe(true);
  });

  it('surfaces a missing tool', async () => {
    const { controller } = stubController();
    const backend = new ScriptedBackend([
      { text: '', toolCalls: [{ id: '1', name: 'nope', arguments: {} }], finishReason: 'tool_use' },
      { text: 'done', toolCalls: [{ id: '2', name: 'finish', arguments: { success: true } }], finishReason: 'tool_use' },
    ]);
    const agent = new HarnessAgent({ controller, tools: createHarnessTools(controller), llmBackend: backend, model: 'm', streaming: true });
    const events = await collect(agent.run('hi'));
    expect(events.some((event) => event.type === 'tool_call' && event.toolState === 'failed')).toBe(true);
  });
});
