/**
 * Judgment backend wiring for the REPL.
 *
 * The runner resolves every `judge/2` (and one-off `choose`/`rate`/`verify`/
 * `probability`) through a `JudgeSelection`. `createDeepClause` builds one, but
 * the REPL constructs a `DMLRunner` directly and therefore has to supply its
 * own. Without it the documented judgment predicates fail with
 * "Unknown judgment backend: llm".
 *
 * This module mirrors the wiring already used by the pi extension
 * (`deepclause-pi/src/runtime.ts`): an `llm` backend built from the active
 * model/`LLMBackend`, plus an opt-in `jev` (TypeSafe System One) backend when
 * it is enabled and its API key is available.
 */

import { createJevJudgeBackend, createLLMJudgeBackend } from '../judge/index.js';
import type { JudgeBackend, JudgeSelection } from '../judge/types.js';
import type { LLMBackend } from '../types.js';

export interface JevJudgeOptions {
  enabled?: boolean;
  model?: string;
  /** Explicit key; when absent, read from `apiKeyEnv`. */
  apiKey?: string;
  apiKeyEnv?: string;
}

export interface ReplJudgeOptions {
  /** Already-resolved registry. When set, it is returned unchanged. */
  judgeSelection?: JudgeSelection;
  /** Injected LLM used by the `llm` judge (reuses pi's model/credentials). */
  llmBackend?: LLMBackend;
  model?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerOptions?: Record<string, Record<string, any>>;
  /** Default backend name (default: `'llm'`). */
  defaultJudge?: string;
  /** Opt-in Jev (TypeSafe System One) backend. */
  jev?: JevJudgeOptions;
}

export interface ResolvedJudgeSelection {
  selection: JudgeSelection;
  /** Diagnostics for a skipped `jev` backend, etc. */
  warnings: string[];
}

/**
 * Build the judge registry for a REPL runner. Throws when the requested default
 * backend is not registered, so a misconfiguration fails loudly at startup
 * instead of surfacing as a "judgment failed" warning mid-turn.
 */
export function resolveReplJudgeSelection(options: ReplJudgeOptions = {}): ResolvedJudgeSelection {
  if (options.judgeSelection) {
    return { selection: options.judgeSelection, warnings: [] };
  }

  const warnings: string[] = [];
  const backends = new Map<string, JudgeBackend>([
    [
      'llm',
      createLLMJudgeBackend({
        llmBackend: options.llmBackend,
        model: options.model,
        provider: options.provider,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        baseUrl: options.baseUrl,
        providerOptions: options.providerOptions,
      }),
    ],
  ]);

  const jev = options.jev;
  if (jev?.enabled) {
    const apiKeyEnv = jev.apiKeyEnv ?? 'TYPESAFE_API_KEY';
    const apiKey = jev.apiKey ?? process.env[apiKeyEnv];
    if (apiKey) {
      backends.set('jev', createJevJudgeBackend({ apiKey, model: jev.model }));
    } else {
      warnings.push(
        `judgment backend 'jev' is enabled but ${apiKeyEnv} is not set; using 'llm'`,
      );
    }
  }

  const defaultName = options.defaultJudge ?? 'llm';
  if (!backends.has(defaultName)) {
    throw new Error(
      `Judgment backend '${defaultName}' is not available (registered: ${[...backends.keys()].join(', ')}). `
      + 'Enable it in the workspace config or use --judge=llm.',
    );
  }

  return { selection: { backends, defaultName }, warnings };
}
