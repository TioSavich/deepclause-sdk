import { afterEach, describe, expect, it, vi } from 'vitest';

const agentMocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(async ({
    taskDescription,
    memory,
    onBeforeModelCall,
  }: {
    taskDescription: string;
    memory: Array<{ role: string; content: string }>;
    onBeforeModelCall?: (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>>;
  }) => {
    const compactedMemory = onBeforeModelCall
      ? await onBeforeModelCall(memory as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>)
      : memory;

    return {
    success: true,
    outputs: [],
    variables: {},
    messages: [
      ...compactedMemory.filter((message) => message.role === 'user' || message.role === 'assistant'),
      { role: 'user' as const, content: `Subtask: ${taskDescription}` },
      { role: 'assistant' as const, content: `Completed ${taskDescription}` },
    ],
    };
  }),
}));

vi.mock('../src/agent.js', async () => {
  const actual = await vi.importActual<typeof import('../src/agent.js')>('../src/agent.js');
  return {
    ...actual,
    runAgentLoop: agentMocks.runAgentLoop,
  };
});

import { applyCompactorRewrite, executeCompactor, parseCompactorAnswer, resolveBinding } from '../src/compaction.js';
import { createDeepClause } from '../src/sdk.js';

describe('runner compaction', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips compactor execution when there are no messages to compact', async () => {
    const execute = vi.fn(async () => ({ answer: '{"apply":false}' }));

    const result = await executeCompactor({
      binding: resolveBinding({
        name: 'empty-session',
        scope: 'session',
        trigger: 'before_user_message',
        compactor: {
          sourceType: 'inline',
          source: 'agent_main :- answer("noop").',
        },
      }),
      messages: [],
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(result.messages).toEqual([]);
    expect(result.event.compactionAction).toBe('skipped');
    expect(result.event.beforeTokens).toBe(0);
    expect(result.event.afterTokens).toBe(0);
  });

  it('emits a running event before the final compaction result', async () => {
    const emitEvent = vi.fn();
    const binding = resolveBinding({
      name: 'loop-start',
      scope: 'loop',
      trigger: 'before_model_call',
      compactor: {
        sourceType: 'inline',
        source: 'agent_main :- answer("noop").',
      },
    });

    const result = await executeCompactor({
      binding,
      messages: [{ role: 'assistant', content: 'Existing context to compact.' }],
      emitEvent,
      execute: vi.fn(async () => ({ answer: '{"apply":false}' })),
    });

    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'memory_compaction',
      compactionBindingName: 'loop-start',
      compactionAction: 'running',
      content: expect.stringContaining('compact loop.before_model_call running loop-start'),
      beforeTokens: expect.any(Number),
      afterTokens: undefined,
    }));
    expect(result.event.compactionAction).toBe('skipped');
  });

  it('parses quoted JSON compactor answers', () => {
    expect(parseCompactorAnswer('"{\\"apply\\":false}"')).toEqual({ apply: false });
  });

  it('parses fenced JSON compactor answers', () => {
    expect(parseCompactorAnswer('```json\n{"apply":false}\n```')).toEqual({ apply: false });
  });

  it('parses line-based rewrite specs', () => {
    expect(parseCompactorAnswer([
      'DC_COMPACTOR_REWRITE_V1',
      'apply=true',
      'keep_last_messages=2',
      'summary:',
      'Objective: keep the benchmark reproducible.',
    ].join('\n'))).toEqual({
      apply: true,
      rewrite: {
        keepLastMessages: 2,
        summary: 'Objective: keep the benchmark reproducible.',
      },
    });
  });

  it('builds deterministic compacted messages from rewrite specs', () => {
    const binding = resolveBinding({
      name: 'session-rewrite',
      scope: 'session',
      trigger: 'before_user_message',
      compactor: {
        sourceType: 'inline',
        source: 'agent_main :- answer("noop").',
      },
    });

    expect(applyCompactorRewrite(binding, [
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Turn 2' },
      { role: 'user', content: 'Turn 3' },
    ], {
      keepLastMessages: 1,
      summary: 'Durable context: keep the benchmark runnable offline.',
    })).toEqual([
      { role: 'assistant', content: 'Durable context: keep the benchmark runnable offline.' },
      { role: 'user', content: 'Turn 3' },
    ]);
  });

  it('runs bound loop compactors before agent model calls and preserves the flat memory API', async () => {
    const sdk = await createDeepClause({
      model: 'gpt-4o-mini',
      compaction: {
        enabled: true,
        bindings: [{
          name: 'test-loop',
          scope: 'loop',
          trigger: 'before_model_call',
          compactor: {
            sourceType: 'inline',
            source: `agent_main :- answer("{\\"apply\\":true,\\"messages\\":[{\\"role\\":\\"assistant\\",\\"content\\":\\"Loop compacted history\\"}]}").`,
          },
        }],
      },
    });

    const events = [] as Array<{ type: string; content?: string; compactionBindingName?: string; compactionAction?: string }>;
    const dml = `
      agent_main :-
        task("Research the problem"),
        task("Draft the outline"),
        task("Write the answer"),
        answer("done").
    `;

    for await (const event of sdk.runDML(dml)) {
      events.push(event);
    }

    const compactionEvents = events.filter((event) => event.type === 'memory_compaction');
    expect(compactionEvents.length).toBeGreaterThan(0);
    expect(compactionEvents.some((event) => event.compactionBindingName === 'test-loop' && event.compactionAction === 'applied')).toBe(true);

    const memory = sdk.getMemory();
    expect(memory.some((message) => message.role === 'assistant' && message.content.includes('Loop compacted history'))).toBe(true);
    expect(memory.some((message) => message.role === 'user' && message.content === 'Subtask: Write the answer')).toBe(true);

    await sdk.dispose();
  });
});