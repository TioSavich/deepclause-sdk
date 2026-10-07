import type { LLMUsage } from '../../types.js';

export interface TokenUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export type TokenUsageByModel = Record<string, TokenUsageTotals>;

export function createTokenUsageTotals(): TokenUsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

export function isTokenUsageEmpty(usageByModel: TokenUsageByModel): boolean {
  return Object.keys(usageByModel).length === 0;
}

export function recordTokenUsage(
  usageByModel: TokenUsageByModel,
  modelId: string | undefined,
  usage: LLMUsage | undefined,
): void {
  if (!modelId || !usage) {
    return;
  }

  const totals = usageByModel[modelId] ?? (usageByModel[modelId] = createTokenUsageTotals());
  addUsageToTotals(totals, usage);
}

/** Accumulate one call's usage into a single totals record. */
export function addUsageToTotals(totals: TokenUsageTotals, usage: LLMUsage | undefined): void {
  if (!usage) {
    return;
  }

  totals.calls += 1;
  totals.inputTokens += usage.inputTokens ?? 0;
  totals.outputTokens += usage.outputTokens ?? 0;
  totals.totalTokens += usage.totalTokens ?? 0;
  totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
  totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  totals.reasoningTokens += usage.reasoningTokens ?? 0;
}

export function mergeTokenUsageMaps(base: TokenUsageByModel, delta: TokenUsageByModel): TokenUsageByModel {
  const merged: TokenUsageByModel = {};

  for (const [modelId, usage] of Object.entries(base)) {
    merged[modelId] = { ...usage };
  }

  for (const [modelId, usage] of Object.entries(delta)) {
    const totals = merged[modelId] ?? (merged[modelId] = createTokenUsageTotals());
    totals.calls += usage.calls;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.totalTokens += usage.totalTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    totals.reasoningTokens += usage.reasoningTokens;
  }

  return merged;
}