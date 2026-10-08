/**
 * Harness tools for the REPL authoring agent.
 *
 * Unlike the old meta tools (which ran inside the Prolog meta frame), these are
 * plain host tools the TypeScript `HarnessAgent` calls directly. They operate on
 * the live harness through a `HarnessToolController` implemented by `DMLSession`.
 */

import type { DMLEvent, ToolDefinition } from '../types.js';

export interface HarnessExecuteResult {
  bindings: Array<{ name: string; value: string }>;
  solutions: Array<Array<{ name: string; value: string }>>;
  output: string;
  error?: string;
}

export interface HarnessCommitResult {
  committed: boolean;
  /** Predicates added/replaced/removed by the commit. */
  changed?: string[];
  error?: string;
}

/** The harness operations the authoring agent needs. Implemented by `DMLSession`. */
export interface HarnessToolController {
  isFrozen(): boolean;
  /** Read the harness: `all`, `Name/Arity`, `tools`, or a name prefix. */
  listing(filter: string): Promise<string>;
  /** Concise harness manifest for the system prompt. */
  manifest(): Promise<string>;
  /** Snapshot the harness and open a transaction. */
  beginTurn(): Promise<void>;
  /** Validate and commit the open transaction; records a history version. */
  endTurn(): Promise<HarnessCommitResult>;
  /** Restore the last snapshot and discard edits. */
  rollbackTurn(): Promise<void>;
  /** Replace a predicate with the given complete clause block. */
  define(head: string, clauses: string): Promise<{ ok: boolean; error?: string }>;
  /** Assert one clause (new predicates only). */
  assertClause(clause: string): Promise<{ ok: boolean; error?: string }>;
  /** Assert a block of clauses in order. */
  assertMany(clauses: string): Promise<{ ok: boolean; error?: string }>;
  /** Retract matching clauses. */
  retractClause(clause: string): Promise<{ ok: boolean; error?: string }>;
  /** Delete a predicate by `Name/Arity`. */
  deletePredicate(nameArity: string): Promise<{ ok: boolean; error?: string }>;
  /** Run a DML goal against the scratch harness. */
  execute(goal: string, limit?: number, signal?: AbortSignal, onEvent?: (event: DMLEvent) => void): Promise<HarnessExecuteResult>;
  askUser(prompt: string, choices?: string[]): Promise<string | undefined>;
  /** DML reference / authoring guide / examples / snippets. */
  reference(topic: string): Promise<string>;
}

function text(message: string): Record<string, unknown> {
  return { text: message };
}

const stringProp = (description: string): { type: string; description: string } => ({ type: 'string', description });

/** Build the authoring agent's harness tools. */
export function createHarnessTools(controller: HarnessToolController): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const frozenError = (name: string): { ok: false; error: string } | undefined =>
    controller.isFrozen() ? { ok: false, error: `harness is frozen; ${name} is disabled` } : undefined;

  tools.set('listing', {
    description: 'Read the harness: all predicates (filter "all"), one predicate ("Name/Arity"), "tools", "scripts", or a name prefix. Call this before editing.',
    parameters: {
      type: 'object',
      properties: { filter: stringProp('all (default), a Name/Arity, tools, scripts, or a name prefix.') },
      required: [],
    },
    execute: async (args) => text(await controller.listing(String(args.filter ?? 'all').trim() || 'all')),
  });

  tools.set('begin_turn', {
    description: 'Open an edit transaction: snapshot the harness before editing. Call it before the first edit of a turn; `end_turn` then commits (or `rollback` discards). The host also snapshots at the start of a request, so an extra call when nothing has changed is a no-op.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      await controller.beginTurn();
      return { ok: true };
    },
  });

  tools.set('end_turn', {
    description: 'Validate and commit the current transaction and record a harness version. Call after the harness is tested. Returns the predicates changed.',
    parameters: {
      type: 'object',
      properties: { summary: stringProp('One-line summary of the change (optional).') },
      required: [],
    },
    execute: async () => controller.endTurn(),
  });

  tools.set('rollback', {
    description: 'Discard every edit made in the current transaction and restore the last committed harness.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      await controller.rollbackTurn();
      return { ok: true };
    },
  });

  tools.set('define', {
    description: 'Replace the predicate(s) defined by a clause block: remove every predicate the block defines (plus the head pattern) and assert the block in order. Use this for any change to existing predicates — a block may define several.',
    parameters: {
      type: 'object',
      properties: {
        head: stringProp('A head pattern naming the predicate, e.g. "describe_image(Path, Text)".'),
        clauses: stringProp('The complete clause block, in order, each clause ending with a period.'),
      },
      required: ['head', 'clauses'],
    },
    execute: async (args) => frozenError('define') ?? controller.define(String(args.head ?? ''), String(args.clauses ?? '')),
  });

  tools.set('assert', {
    description: 'Assert one clause. Use only for a new predicate — assert appends, so asserting over an existing predicate duplicates clauses. Use define to change one.',
    parameters: {
      type: 'object',
      properties: { clause: stringProp('The DML clause/fact text to assert (no trailing period required).') },
      required: ['clause'],
    },
    execute: async (args) => frozenError('assert') ?? controller.assertClause(String(args.clause ?? '')),
  });

  tools.set('assert_many', {
    description: 'Assert a block of clauses in the order written. Use this to define a whole predicate so clause order (base case before recursive rule) is preserved.',
    parameters: {
      type: 'object',
      properties: { clauses: stringProp('The DML clauses/facts, in order, each ending with a period.') },
      required: ['clauses'],
    },
    execute: async (args) => frozenError('assert_many') ?? controller.assertMany(String(args.clauses ?? '')),
  });

  tools.set('retract', {
    description: 'Remove matching clauses from the harness (reserved names are protected).',
    parameters: {
      type: 'object',
      properties: { clause: stringProp('The clause pattern to retract (no trailing period required).') },
      required: ['clause'],
    },
    execute: async (args) => frozenError('retract') ?? controller.retractClause(String(args.clause ?? '')),
  });

  tools.set('delete', {
    description: 'Delete a predicate entirely (abolishes all its clauses), e.g. delete("describe_image/2").',
    parameters: {
      type: 'object',
      properties: { predicate: stringProp('The predicate indicator to delete, e.g. "describe_image/2".') },
      required: ['predicate'],
    },
    execute: async (args) => frozenError('delete') ?? controller.deletePredicate(String(args.predicate ?? '')),
  });

  tools.set('execute', {
    description: 'Run a DML goal against the scratch harness and return its bindings and output. Use this to test changes before committing.',
    parameters: {
      type: 'object',
      properties: {
        goal: stringProp('The DML goal to run, e.g. "fact(5, F)".'),
        limit: { type: 'integer', description: 'Maximum solutions to collect (default 5).' },
      },
      required: ['goal'],
    },
    execute: async (args, context) => controller.execute(
      String(args.goal ?? ''),
      typeof args.limit === 'number' ? args.limit : undefined,
      context?.signal,
      context?.onEvent,
    ),
  });

  tools.set('ask_user', {
    description: 'Ask the human a clarifying question before writing code. Provide options for a menu when appropriate.',
    parameters: {
      type: 'object',
      properties: {
        prompt: stringProp('The question to ask.'),
        options: { type: 'array', description: 'Optional menu of answers.' },
      },
      required: ['prompt'],
    },
    execute: async (args) => {
      const choices = Array.isArray(args.options) ? args.options.map(String) : undefined;
      const answer = await controller.askUser(String(args.prompt ?? ''), choices);
      return answer === undefined ? { cancelled: true } : { answer };
    },
  });

  tools.set('reference', {
    description: 'Read DeepClause language documentation. Topics: "language" (DML reference), "authoring" (authoring guide), "patterns" (harness patterns by use case), "examples" (harness examples), "snippets" (Prolog snippets), "tools" (host tool catalog).',
    parameters: {
      type: 'object',
      properties: { topic: stringProp('language | authoring | examples | snippets | tools.') },
      required: ['topic'],
    },
    execute: async (args) => text(await controller.reference(String(args.topic ?? 'language'))),
  });

  return tools;
}
