/**
 * M5 — backend resolution and the pi LLMBackend adapter.
 */
import { describe, expect, it } from 'vitest';

import {
  createPiAdapter,
  createPiBackend,
  isPiPackageAvailable,
  resolvePiPaths,
  selectPiModel,
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
