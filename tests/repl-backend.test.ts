/**
 * M5 — backend resolution and the pi LLMBackend adapter.
 */
import { describe, expect, it } from 'vitest';

import {
  createPiAdapter,
  createPiBackend,
  isPiPackageAvailable,
  resolvePiPaths,
  resolveThinkingLevel,
  selectPiModel,
  supportedThinkingLevels,
  type PiModelLike,
  type PiRegistryLike,
} from '../src/repl/backend.js';

const MODEL: PiModelLike = { provider: 'anthropic', id: 'claude-test', api: 'anthropic' };

interface Recorded {
  model: PiModelLike;
  systemPrompt?: string;
  messages: unknown[];
  tools?: unknown[];
  options: unknown;
}

function stubRegistry(overrides: Partial<PiRegistryLike> = {}, calls: Recorded[] = []): PiRegistryLike {
  return {
    getAvailable: () => [MODEL],
    find: (provider, modelId) => (provider === MODEL.provider && modelId === MODEL.id ? MODEL : undefined),
    hasConfiguredAuth: () => true,
    complete: async (model, context, options) => {
      calls.push({
        model,
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        tools: context.tools,
        options,
      });
      return {
        content: [
          { type: 'text', text: 'hello from pi' },
          { type: 'toolCall', id: 'call-1', name: 'finish', arguments: { success: true } },
        ],
        usage: { input: 7, output: 3, totalTokens: 10, cacheRead: 1, reasoning: 2 },
        stopReason: 'toolUse',
      };
    },
    ...overrides,
  };
}

describe('resolvePiPaths', () => {
  it('uses explicit paths over the agent-dir defaults', () => {
    const explicit = resolvePiPaths(
      { agentDir: '/custom/agent', modelsPath: '/m.json', authPath: '/a.json', model: 'x/y' },
      { agentDir: '/default/agent' },
    );
    expect(explicit).toEqual({
      agentDir: '/custom/agent',
      modelsPath: '/m.json',
      authPath: '/a.json',
      model: 'x/y',
    });

    const defaults = resolvePiPaths({}, { agentDir: '/default/agent' });
    expect(defaults.modelsPath).toBe('/default/agent/models.json');
    expect(defaults.authPath).toBe('/default/agent/auth.json');
  });
});

describe('selectPiModel', () => {
  it('honors an explicit provider/model request and falls back to the first available', () => {
    const registry = stubRegistry();
    expect(selectPiModel(registry, 'anthropic/claude-test')).toBe(MODEL);
    expect(selectPiModel(registry)).toBe(MODEL);
    expect(() => selectPiModel(registry, 'openai/gpt-nope')).toThrow(/not found/);
  });
});

describe('createPiAdapter', () => {
  it('maps an LLMBackend request/response through a pi registry', async () => {
    const calls: Recorded[] = [];
    const registry = stubRegistry({}, calls);
    const { backend, modelId, provider } = createPiAdapter(registry, MODEL, 4096);

    const response = await backend.complete({
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'question' },
      ],
      tools: [{ name: 'finish', description: 'finish', parameters: { type: 'object', properties: {} } }],
      maxTokens: 128,
    });

    expect(modelId).toBe('anthropic/claude-test');
    expect(provider).toBe('anthropic');
    expect(response.text).toBe('hello from pi');
    expect(response.toolCalls).toEqual([{ id: 'call-1', name: 'finish', arguments: { success: true } }]);
    expect(response.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      cacheReadTokens: 1,
      reasoningTokens: 2,
    });
    expect(response.finishReason).toBe('tool_use');

    expect(calls[0].systemPrompt).toBe('system prompt');
    expect(calls[0].messages).toHaveLength(1);
    expect((calls[0].options as { maxTokens: number }).maxTokens).toBe(128);
  });

  it('streams text and thinking deltas when the registry exposes streamSimple', async () => {
    const registry = stubRegistry({
      streamSimple: () => {
        const events = [
          { type: 'text_delta', delta: 'hel' },
          { type: 'text_delta', delta: 'lo' },
          { type: 'thinking_delta', delta: 'think' },
          { type: 'done' },
        ];
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
          },
          result: async () => ({
            content: [{ type: 'text' as const, text: 'hello' }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: 'stop' as const,
          }),
        };
      },
    });
    const { backend } = createPiAdapter(registry, MODEL);

    const text: string[] = [];
    const reasoning: string[] = [];
    const response = await backend.complete({
      messages: [{ role: 'user', content: 'hi' }],
      onText: (chunk) => text.push(chunk),
      onReasoning: (chunk) => reasoning.push(chunk),
    });

    expect(text).toEqual(['hel', 'lo']);
    expect(reasoning).toEqual(['think']);
    expect(response.text).toBe('hello');
  });

  it('throws when pi has no configured auth for the model', () => {
    const registry = stubRegistry({ hasConfiguredAuth: () => false });
    expect(() => createPiAdapter(registry, MODEL)).toThrow(/configured authentication/);
  });

  it('reports a model error response as a backend error', async () => {
    const registry = stubRegistry({
      complete: async () => ({
        content: [],
        usage: { input: 0, output: 0, totalTokens: 0 },
        stopReason: 'error',
        errorMessage: 'boom',
      }),
    });
    const { backend } = createPiAdapter(registry, MODEL);
    await expect(backend.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow('boom');
  });
});

describe('pi dependency', () => {
  it('resolves the pi package locally (no global install needed)', () => {
    expect(isPiPackageAvailable()).toBe(true);
  });
});

describe('createPiBackend', () => {
  it('uses an injected registry without importing the pi package', async () => {
    const registry = stubRegistry();
    const { modelId, backend } = await createPiBackend({ modelRegistry: registry });
    expect(modelId).toBe('anthropic/claude-test');
    const response = await backend.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.text).toBe('hello from pi');
  });
});

const REASONING_MODEL: PiModelLike = {
  provider: 'anthropic',
  id: 'claude-think',
  api: 'anthropic',
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 8192,
  thinkingLevelMap: { high: 'high', xhigh: null, max: null },
};

function streamStub(): {
  [Symbol.asyncIterator](): AsyncIterator<{ type: string }>;
  result(): Promise<{ content: Array<{ type: 'text'; text: string }>; usage: { input: number; output: number; totalTokens: number }; stopReason: 'stop' }>;
} {
  return {
    async *[Symbol.asyncIterator]() {
      /* no deltas needed */
    },
    result: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input: 1, output: 1, totalTokens: 2 },
      stopReason: 'stop',
    }),
  };
}

describe('reasoning levels', () => {
  it('lists supported levels, excluding null map entries', () => {
    expect(supportedThinkingLevels(REASONING_MODEL)).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(supportedThinkingLevels(MODEL)).toEqual(['off']);
  });

  it('validates a requested level and warns on an unsupported one', () => {
    expect(resolveThinkingLevel(REASONING_MODEL, 'medium')).toMatchObject({ level: 'medium' });
    const bad = resolveThinkingLevel(REASONING_MODEL, 'xhigh');
    expect(bad.level).toBeUndefined();
    expect(bad.warning).toMatch(/not supported/);
    expect(resolveThinkingLevel(REASONING_MODEL).level).toBeUndefined();
  });

  it('forwards the thinking level to streamSimple and reports capabilities', async () => {
    let seen: Record<string, unknown> | undefined;
    const registry = stubRegistry({
      streamSimple: (_model, _context, options) => {
        seen = options as Record<string, unknown>;
        return streamStub();
      },
    });
    const info = createPiAdapter(registry, REASONING_MODEL, 8192, 'high');
    await info.backend.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(seen?.thinkingLevel).toBe('high');
    expect(info.contextWindow).toBe(200_000);
    expect(info.reasoning).toBe(true);
    expect(info.thinkingLevel).toBe('high');
    expect(info.supportedThinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
  });

  it('omits the thinking level for non-reasoning models and off', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const registry = stubRegistry({
      streamSimple: (_model, _context, options) => {
        calls.push(options as Record<string, unknown>);
        return streamStub();
      },
    });
    await createPiAdapter(registry, REASONING_MODEL, 8192, 'off').backend.complete({ messages: [{ role: 'user', content: 'hi' }] });
    await createPiAdapter(registry, MODEL, 8192, 'high').backend.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0].thinkingLevel).toBeUndefined();
    expect(calls[1].thinkingLevel).toBeUndefined();
  });
});
