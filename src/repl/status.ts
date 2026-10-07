/**
 * REPL status accounting for the pi-style status bar.
 *
 * Consumes the same `DMLEvent` stream the renderer sees and maintains:
 *  - cumulative tokens in/out (and cache/reasoning) for the whole session;
 *  - a split between the `meta` (harness authoring) frame and child frames;
 *  - the active frame's context usage (last prompt tokens vs. context window);
 *  - the current model + reasoning level.
 *
 * This module is UI-free so it can be unit-tested and reused by both the TUI
 * status bar and the plain-mode footer.
 */

import type { DMLEvent, FrameKind, LLMUsage } from '../types.js';
import {
  addUsageToTotals,
  createTokenUsageTotals,
  type TokenUsageTotals,
} from '../system/runtime/token-usage.js';

export type StatusFrameGroup = 'meta' | 'child' | 'judge';
export type StatusFrameSlot = 'meta' | 'harness';

export interface StatusModelInfo {
  id: string;
  provider: string;
  reasoning?: boolean;
  thinkingLevel?: string;
}

export interface StatusContextUsage {
  /** Estimated or observed prompt tokens, or null when unknown. */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface StatusCompactionInfo {
  scope: string;
  trigger: string;
  action: string;
  beforeTokens: number;
  afterTokens: number;
}

export interface ReplStatusSnapshot {
  model: StatusModelInfo;
  totals: TokenUsageTotals;
  byGroup: Record<StatusFrameGroup, TokenUsageTotals>;
  activeGroup: StatusFrameGroup | 'idle';
  activeDepth: number;
  activeSlot: StatusFrameSlot;
  context: { meta: StatusContextUsage; harness: StatusContextUsage };
  /** Context for the currently active slot. */
  activeContext: StatusContextUsage;
  latestCacheHitRate?: number;
  compaction?: StatusCompactionInfo;
}

export interface ReplStatusTrackerOptions {
  model: StatusModelInfo;
  contextWindow?: number;
  /** Estimated meta memory tokens before the first model call. */
  metaTokens?: number;
  /** Estimated harness memory tokens before the first child model call. */
  harnessTokens?: number;
}

/** Compact token formatting, mirroring pi's `formatTokens`. */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Prompt-side tokens for one call: input + cache reads/writes. */
export function promptTokens(usage: LLMUsage): number {
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

function emptyContext(contextWindow: number, tokens: number | null): StatusContextUsage {
  const percent = tokens !== null && contextWindow > 0 ? (tokens / contextWindow) * 100 : null;
  return { tokens, contextWindow, percent };
}

function cloneTotals(totals: TokenUsageTotals): TokenUsageTotals {
  return { ...totals };
}

export class ReplStatusTracker {
  private readonly model: StatusModelInfo;
  private contextWindow: number;
  private readonly totals = createTokenUsageTotals();
  private readonly byGroup: Record<StatusFrameGroup, TokenUsageTotals> = {
    meta: createTokenUsageTotals(),
    child: createTokenUsageTotals(),
    judge: createTokenUsageTotals(),
  };
  private activeGroup: StatusFrameGroup | 'idle' = 'idle';
  private activeDepth = 0;
  private lastPromptTokens: Record<StatusFrameGroup, number | null> = {
    meta: null,
    child: null,
    judge: null,
  };
  private estimated: { meta: number | null; harness: number | null };
  private latestCacheHitRate?: number;
  private compaction?: StatusCompactionInfo;

  constructor(options: ReplStatusTrackerOptions) {
    this.model = options.model;
    this.contextWindow = options.contextWindow ?? 0;
    this.estimated = {
      meta: options.metaTokens ?? null,
      harness: options.harnessTokens ?? null,
    };
  }

  /** Update the context window (e.g. after a backend/model switch). */
  setContextWindow(contextWindow: number): void {
    this.contextWindow = contextWindow;
  }

  /** Seed the pre-call context estimate for a slot. */
  setEstimatedTokens(slot: StatusFrameSlot, tokens: number | null): void {
    if (slot === 'meta') {
      this.estimated.meta = tokens;
    } else {
      this.estimated.harness = tokens;
    }
  }

  /** Attribute an event to a frame group. */
  private groupFor(event: DMLEvent): StatusFrameGroup {
    if (event.usageSource === 'judge') {
      return 'judge';
    }
    const kind: FrameKind | undefined = event.frameKind;
    if (kind === 'meta') return 'meta';
    if (kind === 'nested' || kind === 'object' || kind === 'query') return 'child';
    return this.activeGroup === 'meta' ? 'meta' : 'child';
  }

  observe(event: DMLEvent): void {
    switch (event.type) {
      case 'model_call':
        if (event.modelCallState === 'started') {
          this.activeGroup = this.groupFor(event);
          this.activeDepth = event.depth ?? 0;
        }
        break;
      case 'usage': {
        if (!event.usage) break;
        const group = this.groupFor(event);
        if (event.usageSource !== 'judge') {
          this.activeGroup = group;
          this.activeDepth = event.depth ?? 0;
        }
        // Judge usage counts toward the session total but not the context slots.
        addUsageToTotals(this.totals, event.usage);
        addUsageToTotals(this.byGroup[group], event.usage);
        if (event.usageSource !== 'judge') {
          const prompt = promptTokens(event.usage);
          this.lastPromptTokens[group] = prompt;
          this.latestCacheHitRate = prompt > 0
            ? ((event.usage.cacheReadTokens ?? 0) / prompt) * 100
            : undefined;
        }
        break;
      }
      case 'memory_compaction':
        this.compaction = {
          scope: event.compactionScope ?? 'session',
          trigger: event.compactionTrigger ?? 'before_user_message',
          action: event.compactionAction ?? 'applied',
          beforeTokens: event.beforeTokens ?? 0,
          afterTokens: event.afterTokens ?? event.beforeTokens ?? 0,
        };
        // After a compaction the exact size is unknown until the next call.
        this.lastPromptTokens.meta = null;
        this.lastPromptTokens.child = null;
        break;
      case 'task_activity':
        if (event.taskState === 'started' && event.frameKind === 'meta') {
          this.activeGroup = 'meta';
        }
        break;
      default:
        break;
    }
  }

  private slotUsage(slot: StatusFrameSlot): StatusContextUsage {
    const isMeta = slot === 'meta';
    const observed = isMeta ? this.lastPromptTokens.meta : this.lastPromptTokens.child;
    const fallback = isMeta ? this.estimated.meta : this.estimated.harness;
    return emptyContext(this.contextWindow, observed ?? fallback);
  }

  snapshot(): ReplStatusSnapshot {
    const context = { meta: this.slotUsage('meta'), harness: this.slotUsage('harness') };
    const activeSlot: StatusFrameSlot = this.activeGroup === 'meta' ? 'meta' : 'harness';
    const activeContext = activeSlot === 'meta' ? context.meta : context.harness;
    return {
      model: { ...this.model },
      totals: cloneTotals(this.totals),
      byGroup: {
        meta: cloneTotals(this.byGroup.meta),
        child: cloneTotals(this.byGroup.child),
        judge: cloneTotals(this.byGroup.judge),
      },
      activeGroup: this.activeGroup,
      activeDepth: this.activeDepth,
      activeSlot,
      context,
      activeContext,
      latestCacheHitRate: this.latestCacheHitRate,
      compaction: this.compaction,
    };
  }
}

/** The usage segment of the status line: `↑in ↓out Rread Wwrite CH%`. */
export function formatUsageSegment(snapshot: ReplStatusSnapshot): string {
  const parts: string[] = [];
  if (snapshot.totals.inputTokens) parts.push(`↑${formatTokens(snapshot.totals.inputTokens)}`);
  if (snapshot.totals.outputTokens) parts.push(`↓${formatTokens(snapshot.totals.outputTokens)}`);
  if (snapshot.totals.cacheReadTokens) parts.push(`R${formatTokens(snapshot.totals.cacheReadTokens)}`);
  if (snapshot.totals.cacheWriteTokens) parts.push(`W${formatTokens(snapshot.totals.cacheWriteTokens)}`);
  if (
    (snapshot.totals.cacheReadTokens > 0 || snapshot.totals.cacheWriteTokens > 0)
    && snapshot.latestCacheHitRate !== undefined
  ) {
    parts.push(`CH${snapshot.latestCacheHitRate.toFixed(0)}%`);
  }
  return parts.join(' ');
}

/** The context segment: `meta 9.4k/128k 7%` for the active slot. */
export function formatContextSegment(snapshot: ReplStatusSnapshot): string {
  const slot = snapshot.activeSlot === 'meta' ? 'meta' : 'run';
  const { tokens, contextWindow, percent } = snapshot.activeContext;
  if (contextWindow <= 0) {
    return `${slot} ?`;
  }
  const window = formatTokens(contextWindow);
  if (tokens === null || percent === null) {
    return `${slot} ?/${window}`;
  }
  return `${slot} ${formatTokens(tokens)}/${window} ${percent.toFixed(0)}%`;
}

/** The model segment: `gpt-4o · high` (thinking level only for reasoning models). */
export function formatModelSegment(snapshot: ReplStatusSnapshot): string {
  const { model } = snapshot;
  if (model.reasoning && model.thinkingLevel) {
    return model.thinkingLevel === 'off' ? `${model.id} · thinking off` : `${model.id} · ${model.thinkingLevel}`;
  }
  return model.id;
}

/** One-line plain status (used by `--plain` and tests). */
export function formatStatusLine(snapshot: ReplStatusSnapshot): string {
  const usage = formatUsageSegment(snapshot);
  const context = formatContextSegment(snapshot);
  const model = formatModelSegment(snapshot);
  return [usage, context, model].filter(Boolean).join('  ');
}
