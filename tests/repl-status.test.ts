/**
 * REPL status tracker — tokens, per-frame split, and context usage.
 */
import { describe, expect, it } from 'vitest';

import {
  ReplStatusTracker,
  formatContextSegment,
  formatModelSegment,
  formatStatusLine,
  formatTokens,
  formatUsageSegment,
  promptTokens,
} from '../src/repl/status.js';
import type { DMLEvent } from '../src/types.js';

function usage(inputTokens: number, outputTokens: number, cacheRead = 0): DMLEvent {
  return {
    type: 'usage',
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens: cacheRead || undefined },
  };
}

function tracker(contextWindow = 100_000) {
  return new ReplStatusTracker({
    model: { id: 'gpt-4o', provider: 'openai', reasoning: true, thinkingLevel: 'medium' },
    contextWindow,
  });
}

describe('ReplStatusTracker', () => {
  it('accumulates totals and splits agent vs child frames', () => {
    const status = tracker();
    status.observe({ ...usage(100, 20) });
    status.observe({ ...usage(200, 40), frameKind: 'object' });
    status.observe({ ...usage(300, 60), frameKind: 'nested' });

    const snapshot = status.snapshot();
    expect(snapshot.totals.inputTokens).toBe(600);
    expect(snapshot.totals.outputTokens).toBe(120);
    expect(snapshot.byGroup.agent.inputTokens).toBe(100);
    expect(snapshot.byGroup.child.inputTokens).toBe(500);
  });

  it('tracks the active frame and depth from model_call/usage', () => {
    const status = tracker();
    status.observe({ type: 'model_call', modelCallState: 'started', depth: 0 });
    status.observe({ ...usage(100, 10), depth: 0 });
    expect(status.snapshot().activeGroup).toBe('agent');
    expect(status.snapshot().activeSlot).toBe('agent');

    status.observe({ type: 'model_call', modelCallState: 'started', frameKind: 'object', depth: 1 });
    status.observe({ ...usage(50, 5), frameKind: 'object', depth: 1 });
    expect(status.snapshot().activeGroup).toBe('child');
    expect(status.snapshot().activeDepth).toBe(1);
    expect(status.snapshot().activeSlot).toBe('harness');
  });

  it('uses last prompt tokens as context and falls back to estimates', () => {
    const status = tracker(10_000);
    status.setEstimatedTokens('agent', 2_000);
    expect(status.snapshot().context.agent.tokens).toBe(2_000);
    expect(status.snapshot().context.agent.percent).toBeCloseTo(20);

    status.observe({ ...usage(3_000, 100, 500) });
    expect(status.snapshot().context.agent.tokens).toBe(3_500);
    expect(status.snapshot().context.agent.percent).toBeCloseTo(35);
  });

  it('computes the cache hit rate from prompt tokens', () => {
    const status = tracker();
    status.observe({ ...usage(1_000, 100, 1_000), frameKind: 'object' });
    expect(status.snapshot().latestCacheHitRate).toBeCloseTo(50);
  });

  it('counts judge usage in totals but not in the context slot', () => {
    const status = tracker();
    status.observe({ ...usage(500, 50), usageSource: 'judge', frameKind: 'object' });
    const snapshot = status.snapshot();
    expect(snapshot.totals.inputTokens).toBe(500);
    expect(snapshot.byGroup.judge.inputTokens).toBe(500);
    expect(snapshot.byGroup.child.inputTokens).toBe(0);
    expect(snapshot.context.harness.tokens).toBeNull();
  });

  it('clears the observed context after a compaction', () => {
    const status = tracker();
    status.observe({ ...usage(4_000, 100) });
    expect(status.snapshot().context.agent.tokens).toBe(4_000);
    status.observe({
      type: 'memory_compaction',
      compactionScope: 'session',
      compactionTrigger: 'before_user_message',
      compactionAction: 'applied',
      beforeTokens: 4_100,
      afterTokens: 900,
    });
    const snapshot = status.snapshot();
    expect(snapshot.context.agent.tokens).toBeNull();
    expect(snapshot.compaction).toMatchObject({ beforeTokens: 4_100, afterTokens: 900, action: 'applied' });
  });
});

describe('status formatting', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_500)).toBe('1.5k');
    expect(formatTokens(15_000)).toBe('15k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  it('computes prompt tokens', () => {
    expect(promptTokens({ inputTokens: 1, outputTokens: 9, totalTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3 })).toBe(6);
  });

  it('renders usage, context, and model segments', () => {
    const status = tracker(10_000);
    status.observe({ ...usage(1_000, 100, 1_000) });
    const snapshot = status.snapshot();
    expect(formatUsageSegment(snapshot)).toContain('↑1.0k');
    expect(formatUsageSegment(snapshot)).toContain('CH50%');
    expect(formatContextSegment(snapshot)).toBe('agent 2.0k/10k 20%');
    expect(formatModelSegment(snapshot)).toBe('gpt-4o · medium');
    expect(formatStatusLine(snapshot)).toContain('gpt-4o · medium');
  });

  it('formats an unknown context window', () => {
    const status = new ReplStatusTracker({ model: { id: 'x', provider: 'env' } });
    expect(formatContextSegment(status.snapshot())).toBe('run ?');
    expect(formatModelSegment(status.snapshot())).toBe('x');
  });
});
