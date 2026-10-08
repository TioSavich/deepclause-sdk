/**
 * Host-backed meta tools (M3).
 *
 * A `meta` frame's agent tool set is *replaced* with exactly these tools; the
 * harness's own DML tools are hidden from the code-writing model. The tools act
 * on the live scratch module (snapshot/restored by the prompt transaction).
 *
 * M3 ships listing/assert/retract/execute; M6 adds ask_user.
 */

import type { DMLEvent, ToolDefinition } from '../types.js';
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
  executeGoal: (goal: string, limit?: number, signal?: AbortSignal) => Promise<ExecuteResult>;
  /** Human-in-the-loop channel (M6). */
  askUser?: (prompt: string, options?: string[]) => Promise<{ answer: string } | { cancelled: true }>;
  /** Catalog of capability host tools, returned by listing(tools). */
  hostToolsCatalog?: string;
  /** Emit meta-tool lifecycle events so results appear in sequence. */
  onEvent?: (event: DMLEvent) => void;
  /** Workspace-scoped file tools for the author (writes land on disk immediately). */
  fileTools?: {
    read: (path: string) => Promise<string | null>;
    write: (path: string, content: string) => Promise<void>;
    list: (path?: string) => Promise<string[]>;
    remove: (path: string) => Promise<void>;
  };
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

  // The AI SDK may issue several tool calls from one assistant message and run
  // them concurrently. Meta tools mutate the shared session and create child
  // frames, so serialize them: a child frame must run to completion before the
  // meta frame resumes (proposal §10.3).
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const notify = (
    toolName: string,
    toolArgs: Record<string, unknown>,
    state: 'completed' | 'failed',
    toolSummary: string,
  ): void => {
    ctx.onEvent?.({ type: 'tool_call', toolName, toolArgs, toolState: state, toolSummary });
  };

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
    execute: (args) => serialized(async () => {
      const filter = String(args.filter ?? 'all').trim() || 'all';
      if (filter === 'tools' && ctx.hostToolsCatalog) {
        return textResult(ctx.hostToolsCatalog);
      }
      const result = ctx.prologQuery(
        `deepclause_mi:repl_listing('${ctx.sessionId}', ${listingFilterTerm(filter)}, Text)`
      );
      const text = plainValue(result?.Text);
      const output = typeof text === 'string' ? text : '';
      notify('listing', { filter }, 'completed', `${output.trim() ? output.trim().split('\n').length : 0} line(s)`);
      return textResult(output);
    }),
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
    execute: (args) => serialized(async () => {
      if (ctx.isFrozen()) {
        return { ok: false, error: 'harness is frozen; assert is disabled' };
      }
      const clause = String(args.clause ?? '');
      const result = ctx.prologQuery(
        `deepclause_mi:repl_assert('${ctx.sessionId}', ${quoteString(clause)}, Result)`
      );
      const outcome = plainValue(result?.Result);
      if (outcome === 'ok') {
        notify('assert', { clause }, 'completed', 'ok');
        return { ok: true };
      }
      notify('assert', { clause }, 'failed', String(outcome));
      return { ok: false, error: String(outcome) };
    }),
  });

  tools.set('assert_many', {
    description: 'Parse a block of clauses and assert them in the order written. Use this to define a whole predicate so clause order (base case before recursive rule) is preserved.',
    parameters: {
      type: 'object',
      properties: {
        clauses: { type: 'string', description: 'The DML clauses/facts, in order, each ending with a period.' },
      },
      required: ['clauses'],
    },
    execute: (args) => serialized(async () => {
      if (ctx.isFrozen()) {
        return { ok: false, error: 'harness is frozen; assert is disabled' };
      }
      const clauses = String(args.clauses ?? '');
      const result = ctx.prologQuery(
        `deepclause_mi:repl_assert_many('${ctx.sessionId}', ${quoteString(clauses)}, Result)`
      );
      const outcome = plainValue(result?.Result);
      if (outcome === 'ok') {
        notify('assert_many', { clauses }, 'completed', 'ok');
        return { ok: true };
      }
      notify('assert_many', { clauses }, 'failed', String(outcome));
      return { ok: false, error: String(outcome) };
    }),
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
    execute: (args) => serialized(async () => {
      if (ctx.isFrozen()) {
        return { ok: false, error: 'harness is frozen; retract is disabled' };
      }
      const clause = String(args.clause ?? '');
      const result = ctx.prologQuery(
        `deepclause_mi:repl_retract('${ctx.sessionId}', ${quoteString(clause)}, Result)`
      );
      const outcome = plainValue(result?.Result);
      if (outcome === 'ok') {
        notify('retract', { clause }, 'completed', 'ok');
        return { ok: true };
      }
      notify('retract', { clause }, 'failed', String(outcome));
      return { ok: false, error: String(outcome) };
    }),
  });

  tools.set('define', {
    description: 'Replace the predicate(s) defined by a clause block: remove every predicate the block defines (plus the head pattern), then assert the block in order. A block may define several predicates. Prefer this over assert when changing existing predicates.',
    parameters: {
      type: 'object',
      properties: {
        head: { type: 'string', description: 'A head pattern for the predicate, e.g. "describe_image(Path, Text)" or "doc(describe_image/2, _)".' },
        clauses: { type: 'string', description: 'The complete clause block for the predicate, in order, each ending with a period.' },
      },
      required: ['head', 'clauses'],
    },
    execute: (args) => serialized(async () => {
      if (ctx.isFrozen()) {
        return { ok: false, error: 'harness is frozen; define is disabled' };
      }
      const head = String(args.head ?? '');
      const clauses = String(args.clauses ?? '');
      const result = ctx.prologQuery(
        `deepclause_mi:repl_define('${ctx.sessionId}', ${quoteString(head)}, ${quoteString(clauses)}, Result)`
      );
      const outcome = plainValue(result?.Result);
      if (outcome === 'ok') {
        notify('define', { head }, 'completed', 'ok');
        return { ok: true };
      }
      notify('define', { head }, 'failed', String(outcome));
      return { ok: false, error: String(outcome) };
    }),
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
    execute: (args, context) => serialized(async () => {
      const goal = String(args.goal ?? '');
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const result = await ctx.executeGoal(goal, limit, context?.signal);
      notify(
        'execute',
        { goal },
        result.error ? 'failed' : 'completed',
        result.error ?? `${result.solutions.length} solution(s)`,
      );
      return result;
    }),
  });

  if (ctx.fileTools) {
    const fileTools = ctx.fileTools;
    tools.set('read_file', {
      description: 'Read a workspace file. Paths are workspace-relative. Use this to inspect generated scripts.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
        required: ['path'],
      },
      execute: (args) => serialized(async () => {
        const filePath = String(args.path ?? '');
        try {
          const content = await fileTools.read(filePath);
          if (content === null) {
            notify('read_file', { path: filePath }, 'failed', 'not found');
            return { error: `not found: ${filePath}` };
          }
          notify('read_file', { path: filePath }, 'completed', `${content.length} chars`);
          return { path: filePath, content };
        } catch (error) {
          notify('read_file', { path: filePath }, 'failed', String(error));
          return { error: String(error) };
        }
      }),
    });

    tools.set('write_file', {
      description: 'Write a workspace file. Paths are workspace-relative; the write lands on disk immediately, so bash can run it in the same turn. Use this to author script files; link them with a script_file/2 fact and run them with exec(bash(...)).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          content: { type: 'string', description: 'The full file content.' },
        },
        required: ['path', 'content'],
      },
      execute: (args) => serialized(async () => {
        const filePath = String(args.path ?? '');
        const content = String(args.content ?? '');
        try {
          await fileTools.write(filePath, content);
          notify('write_file', { path: filePath }, 'completed', `${content.length} chars`);
          return { ok: true, path: filePath };
        } catch (error) {
          notify('write_file', { path: filePath }, 'failed', String(error));
          return { ok: false, error: String(error) };
        }
      }),
    });

    tools.set('list_files', {
      description: 'List a workspace directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative directory (default ".").' } },
        required: [],
      },
      execute: (args) => serialized(async () => {
        const dir = args.path ? String(args.path) : '.';
        try {
          const entries = await fileTools.list(dir);
          notify('list_files', { path: dir }, 'completed', `${entries.length} entries`);
          return { path: dir, entries };
        } catch (error) {
          notify('list_files', { path: dir }, 'failed', String(error));
          return { error: String(error) };
        }
      }),
    });

    tools.set('delete_file', {
      description: 'Delete a workspace file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
        required: ['path'],
      },
      execute: (args) => serialized(async () => {
        const filePath = String(args.path ?? '');
        try {
          await fileTools.remove(filePath);
          notify('delete_file', { path: filePath }, 'completed', 'deleted');
          return { ok: true };
        } catch (error) {
          notify('delete_file', { path: filePath }, 'failed', String(error));
          return { ok: false, error: String(error) };
        }
      }),
    });
  }

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
      execute: (args) => serialized(async () => {
        const prompt = String(args.prompt ?? '');
        const options = Array.isArray(args.options) ? args.options.map(String) : undefined;
        const result = await ctx.askUser!(prompt, options);
        notify(
          'ask_user',
          { prompt },
          'completed',
          'cancelled' in result ? 'cancelled' : result.answer,
        );
        return result;
      }),
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
    '- assert(clause) / assert_many(clauses) — write DML clauses into the scratch harness.',
    '- define(head, clauses) — replace a predicate (clear Name/Arity, then assert the clauses).',
    '- retract(clause) — remove a predicate from the scratch harness.',
    '- execute(goal, limit?) — run a DML goal against the scratch harness; returns bindings/output.',
    '- read_file / write_file / list_files / delete_file — workspace-scoped file I/O (writes land immediately).',
    '- ask_user(prompt, options?) — ask the human a clarifying question.',
    '- bash — the capability host tool, available to probe the environment and run commands.',
  ].join('\n');
}
