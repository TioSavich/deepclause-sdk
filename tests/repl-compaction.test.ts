/**
 * TS compaction (ported from pi) — pure logic + backend-driven summarization.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_COMPACTION_SETTINGS,
  SUMMARY_PREFIX,
  buildSummarizationPrompt,
  buildSummaryMessage,
  calculateContextTokens,
  compactMemory,
  estimateMemoryTokens,
  estimateMessageTokens,
  findCompactionCut,
  findExistingSummary,
  generateMemorySummary,
  serializeMemoryConversation,
  shouldCompact,
} from '../src/repl/compaction.js';
import type { LLMBackend, LLMBackendRequest, LLMBackendResponse, MemoryMessage } from '../src/types.js';

function messages(count: number, chars = 100): MemoryMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${index + 1} ${'x'.repeat(chars)}`,
  }));
}

class StubBackend implements LLMBackend {
  readonly calls: LLMBackendRequest[] = [];
  constructor(private readonly response: LLMBackendResponse) {}
  async complete(request: LLMBackendRequest): Promise<LLMBackendResponse> {
    this.calls.push(request);
    return this.response;
  }
}

describe('token accounting', () => {
  it('estimates chars/4 with per-message overhead', () => {
    expect(estimateMessageTokens({ role: 'user', content: 'abcd' })).toBe(4 + 1);
    expect(estimateMemoryTokens([
      { role: 'user', content: 'abcd' },
      { role: 'assistant', content: 'efgh' },
    ])).toBe(10);
  });

  it('prefers the provider total, then falls back to the components', () => {
    expect(calculateContextTokens({ inputTokens: 10, outputTokens: 5, totalTokens: 99 })).toBe(99);
    expect(calculateContextTokens({ inputTokens: 10, outputTokens: 5, totalTokens: 0, cacheReadTokens: 3 })).toBe(18);
  });

  it('triggers past contextWindow - reserveTokens', () => {
    const settings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 };
    expect(shouldCompact(500, 2000, settings)).toBe(false);
    expect(shouldCompact(1001, 2000, settings)).toBe(true);
    expect(shouldCompact(99999, 0, settings)).toBe(false);
    expect(shouldCompact(99999, 2000, { ...settings, enabled: false })).toBe(false);
  });
});

describe('findCompactionCut', () => {
  it('summarizes nothing when memory is smaller than the budget', () => {
    const cut = findCompactionCut(messages(4, 10), 10_000);
    expect(cut.cutIndex).toBe(0);
    expect(cut.messagesToSummarize).toHaveLength(0);
    expect(cut.keptMessages).toHaveLength(4);
  });

  it('keeps a recent tail and cuts on a user boundary', () => {
    const list = messages(20, 400); // ~101 tokens each
    const cut = findCompactionCut(list, 500);
    expect(cut.messagesToSummarize.length).toBeGreaterThan(0);
    expect(cut.keptMessages[0].role === 'user' || cut.messagesToSummarize.length === 0).toBe(true);
    expect(list[cut.cutIndex].role).toBe('user');
  });

  it('never summarizes system messages', () => {
    const list: MemoryMessage[] = [
      { role: 'system', content: 'runtime contract' },
      ...messages(20, 400),
    ];
    const cut = findCompactionCut(list, 500);
    expect(cut.messagesToSummarize.every((message) => message.role !== 'system')).toBe(true);
    expect(cut.keptMessages[0]).toEqual({ role: 'system', content: 'runtime contract' });
  });
});

describe('summarization prompt', () => {
  it('serializes roles and wraps the conversation', () => {
    const prompt = buildSummarizationPrompt(messages(2, 5));
    expect(prompt).toContain('<conversation>');
    expect(prompt).toContain('[User]:');
    expect(prompt).toContain('[Assistant]:');
    expect(prompt).not.toContain('<previous-summary>');
    expect(prompt).toContain('## Goal');
  });

  it('uses the update prompt with a previous summary', () => {
    const prompt = buildSummarizationPrompt(messages(2, 5), 'old summary');
    expect(prompt).toContain('<previous-summary>');
    expect(prompt).toContain('old summary');
    expect(prompt).toContain('PRESERVE all existing information');
  });

  it('includes custom instructions', () => {
    const prompt = buildSummarizationPrompt(messages(2, 5), undefined, 'focus on files');
    expect(prompt).toContain('Additional focus: focus on files');
  });

  it('serializes a role-prefixed conversation', () => {
    expect(serializeMemoryConversation([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'system', content: 'rules' },
    ])).toBe('[User]: hi\n\n[Assistant]: hello\n\n[System]: rules');
  });
});

describe('summary checkpoint', () => {
  it('detects and rebuilds the checkpoint', () => {
    const message = buildSummaryMessage('checkpoint body');
    expect(message.content.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(findExistingSummary([message])).toBe('checkpoint body');
    expect(findExistingSummary([{ role: 'user', content: 'no summary' }])).toBeUndefined();
  });
});

describe('generateMemorySummary', () => {
  it('posts a system + user prompt through the backend and returns the summary', async () => {
    const backend = new StubBackend({
      text: '## Goal\nDo the thing',
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      finishReason: 'stop',
    });
    const result = await generateMemorySummary({
      messages: messages(2, 5),
      backend,
      model: 'test-model',
    });
    expect(result.summary).toContain('Do the thing');
    expect(result.usage?.totalTokens).toBe(8);
    expect(backend.calls).toHaveLength(1);
    const request = backend.calls[0];
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toContain('summarization assistant');
    expect(request.messages[1].content).toContain('<conversation>');
  });

  it('fails on an empty summary', async () => {
    const backend = new StubBackend({ text: '   ', finishReason: 'stop' });
    await expect(generateMemorySummary({ messages: messages(2, 5), backend, model: 'm' }))
      .rejects.toThrow(/empty summary/);
  });
});

describe('compactMemory', () => {
  it('is a no-op below the threshold without force', async () => {
    const backend = new StubBackend({ text: 'unused', finishReason: 'stop' });
    const list = messages(4, 10);
    const result = await compactMemory({ messages: list, backend, model: 'm', contextWindow: 1_000_000 });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('below-threshold');
    expect(result.messages).toBe(list);
    expect(backend.calls).toHaveLength(0);
  });

  it('compacts on force and reports a reduction', async () => {
    const backend = new StubBackend({
      text: '## Goal\nKeep the harness stable',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    });
    const list = messages(30, 400);
    const result = await compactMemory({
      messages: list,
      backend,
      model: 'm',
      contextWindow: 1_000_000,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 500 },
      force: true,
    });
    expect(result.applied).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.messages.some((message) => message.content.startsWith(SUMMARY_PREFIX))).toBe(true);
    expect(result.summary).toContain('Keep the harness stable');
  });

  it('skips when the rewritten memory is not smaller', async () => {
    const backend = new StubBackend({ text: 'y'.repeat(100_000), finishReason: 'stop' });
    const list = messages(12, 40);
    const result = await compactMemory({ messages: list, backend, model: 'm', force: true });
    expect(result.applied).toBe(false);
    expect(['no-reduction', 'nothing-to-summarize']).toContain(result.reason);
  });

  it('surfaces summarization failures without changing memory', async () => {
    const backend: LLMBackend = {
      complete: vi.fn(async () => {
        throw new Error('summarization aborted');
      }),
    };
    const list = messages(30, 400);
    const result = await compactMemory({
      messages: list,
      backend,
      model: 'm',
      settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 500 },
      force: true,
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('failed');
    expect(result.error).toContain('aborted');
    expect(result.messages).toBe(list);
  });

  it('uses default settings shape', () => {
    expect(DEFAULT_COMPACTION_SETTINGS).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
  });
});
