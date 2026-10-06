/**
 * Host-backed meta tools (M3).
 *
 * A `meta` frame's agent tool set is *replaced* with exactly these tools; the
 * harness's own DML tools are hidden from the code-writing model. The tools act
 * on the live scratch module (snapshot/restored by the prompt transaction).
 *
 * M3 ships listing/assert/retract/execute; M6 adds ask_user.
 */

import type { ToolDefinition } from '../types.js';
import { plainValue } from './frames.js';

export interface ExecuteResult {
  bindings: Array<{ name: string; value: string }>;
  solutions: Array<Array<{ name: string; value: string }>>;
  output: string;
  error?: string;
}

export interface MetaToolContext {
  sessionId: string;
  prologQuery: (goal: string) => Record<string, unknown> | null;
  isFrozen: () => boolean;
  /** Run a goal in an `execute` child frame and collect its result. */
  executeGoal: (goal: string, limit?: number) => Promise<ExecuteResult>;
  /** Human-in-the-loop channel (M6). */
  askUser?: (prompt: string, options?: string[]) => Promise<{ answer: string } | { cancelled: true }>;
}

function quoteString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function listingFilterTerm(filter: string): string {
  if (/^[a-z][a-zA-Z0-9_]*\/\d+$/.test(filter) || /^[a-z][a-zA-Z0-9_]*$/.test(filter)) {
    return filter;
  }
  return `'${filter.replace(/'/g, "''")}'`;
}

function textResult(message: string): Record<string, unknown> {
  return { text: message };
}

export function createMetaTools(ctx: MetaToolContext): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();

  tools.set('listing', {
    description: 'Read-only listing of the living harness: predicates, a Name/Arity, tools, or scripts.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: "One of: all (default), a Name/Arity, tools, scripts, or a name prefix.",
        },
      },
      required: [],
    },
    execute: async (args) => {
      const filter = String(args.filter ?? 'all').trim() || 'all';
      const result = ctx.prologQuery(
        `deepclause_mi:repl_listing('${ctx.sessionId}', ${listingFilterTerm(filter)}, Text)`
      );
      const text = plainValue(result?.Text);
      return textResult(typeof text === 'string' ? text : '');
    },
  });

  tools.set('assert', {
    description: 'Parse and assert a clause, tool/2, or script_body/2 fact into the scratch harness.',
    parameters: {
      type: 'object',
      properties: {
        clause: { type: 'string', description: 'The DML clause/fact text to assert (no trailing period required).' },
      },
      required: ['clause'],
    },
    execute: async (args) => {
      if (ctx.isFrozen()) {
        return { ok: false, error: 'harness is frozen; assert is disabled' };
      }
      const clause = String(args.clause ?? '');
      const result = ctx.prologQuery(
        `deepclause_mi:repl_assert('${ctx.sessionId}', ${quoteString(clause)}, Result)`
      );
      const outcome = plainValue(result?.Result);
      if (outcome === 'ok') {
        return { ok: true };
      }
      return { ok: false, error: String(outcome) };
    },
  });

  tools.set('retract', {
    description: 'Remove matching clauses from the scratch harness (reserved names are protected).',
    parameters: {
      type: 'object',
      properties: {
        clause: { type: 'string', description: 'The clause pattern to retract (no trailing period required).' },
      },
      required: ['clause'],
    },
    execute: async (args) => {
      if (ctx.isFrozen()) {
        return { ok: false, error: 'harness is frozen; retract is disabled' };
      }
      const clause = String(args.clause ?? '');
      const result = ctx.prologQuery(
        `deepclause_mi:repl_retract('${ctx.sessionId}', ${quoteString(clause)}, Result)`
      );
      const outcome = plainValue(result?.Result);
      if (outcome === 'ok') {
        return { ok: true };
      }
      return { ok: false, error: String(outcome) };
    },
  });

  tools.set('execute', {
    description: 'Run a DML goal against the scratch harness and return its bindings/output.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The DML goal to run, e.g. "fact(5, F)".' },
        limit: { type: 'integer', description: 'Maximum solutions to collect (default 5).' },
      },
      required: ['goal'],
    },
    execute: async (args) => {
      const goal = String(args.goal ?? '');
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      return ctx.executeGoal(goal, limit);
    },
  });

  if (ctx.askUser) {
    tools.set('ask_user', {
      description: 'Ask the human a clarifying question before writing the harness.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The question to ask.' },
          options: { type: 'array', description: 'Optional menu of answers.' },
        },
        required: ['prompt'],
      },
      execute: async (args) => {
        const prompt = String(args.prompt ?? '');
        const options = Array.isArray(args.options) ? args.options.map(String) : undefined;
        return ctx.askUser!(prompt, options);
      },
    });
  }

  return tools;
}

/**
 * Compact catalog injected into the meta prompt. The full schemas are always
 * available through the `listing(tools)` / `listing` tool.
 */
export function describeMetaTools(): string {
  return [
    '- listing(filter) — read-only list of predicates (all), Name/Arity, tools, or scripts.',
    '- assert(clause) — parse and assert a clause/tool/script fact into the scratch harness.',
    '- retract(clause) — remove matching clauses from the scratch harness.',
    '- execute(goal, limit?) — run a DML goal against the scratch harness; returns bindings/output.',
    '- ask_user(prompt, options?) — ask the human a clarifying question (non-interactive runs return cancelled).',
  ].join('\n');
}
