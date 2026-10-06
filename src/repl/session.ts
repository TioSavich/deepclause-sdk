/**
 * DMLSession — a persistent REPL living module.
 *
 * Owns one Prolog session (the "living module"), one `DMLRunner` bound to it,
 * and the harness memory slot. Goal-mode queries create a `query_start/5`
 * frame, register it with the runner, and drive it with `runFrame`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { loadProlog, mountWorkspace, type SWIPLModule } from '../prolog/loader.js';
import { DMLRunner, type Frame, type InternalRunOptions, type RunnerOptions } from '../runner.js';
import type {
  DMLEvent,
  FrameKind,
  MemoryMessage,
  ToolDefinition,
  ToolPolicy,
} from '../types.js';
import { buildParamsTerm, plainValue } from './frames.js';
import {
  applySkillWrapper,
  buildHarnessHeader,
  type HarnessExportOptions,
  type HarnessExportResult,
} from './export.js';
import { createMetaTools, type ExecuteResult } from './tools.js';

export interface DMLSessionOptions {
  /** Optional explicit session id; generated when omitted. */
  sessionId?: string;
  workspacePath?: string;
  /** Session parameters exposed via param/2 and string interpolation. */
  params?: Record<string, unknown>;
  gasLimit?: number;
  /** Runner configuration (model/provider/temperature/backend). */
  runnerOptions: RunnerOptions;
  tools?: Map<string, ToolDefinition>;
  toolPolicy?: ToolPolicy | null;
  onInputRequired?: (prompt: string) => Promise<string>;
  initialHarnessMemory?: MemoryMessage[];
  /** Prompt-mode repair attempts after an invalid commit (default 1). */
  repairRounds?: number;
  /** Maximum nested frame depth (meta -> execute -> object task). Default 3. */
  maxDepth?: number;
  /** Maximum model calls across all frames for one turn (default 24; 0 = unlimited). */
  maxModelCalls?: number;
  /** Host tool catalog text injected into the meta prompt (M5). */
  hostToolsCatalog?: string;
  /** Human-in-the-loop channel for the meta ask_user tool (M6). */
  askUser?: (prompt: string, options?: string[]) => Promise<{ answer: string } | { cancelled: true }>;
}

export interface DMLQueryOptions {
  tools?: Map<string, ToolDefinition>;
  toolPolicy?: ToolPolicy | null;
  onInputRequired?: (prompt: string) => Promise<string>;
  signal?: AbortSignal;
  gasLimit?: number;
  /** Frame kind for the query (defaults to `object`). */
  frameKind?: FrameKind;
}

let sessionCounter = 0;

function nextSessionId(): string {
  sessionCounter += 1;
  return `repl_${Date.now().toString(36)}_${sessionCounter}`;
}

export class DMLSession {
  private swipl: SWIPLModule;
  private runner: DMLRunner;
  private sessionId: string;
  private workspacePath?: string;
  private gasLimit?: number;
  private model: string;
  private provider: string;
  private tools: Map<string, ToolDefinition>;
  private toolPolicy: ToolPolicy | null;
  private onInputRequired: (prompt: string) => Promise<string>;
  private repairRounds: number;
  private maxDepth: number;
  private maxModelCalls: number;
  private hostToolsCatalog?: string;
  private askUser?: (prompt: string, options?: string[]) => Promise<{ answer: string } | { cancelled: true }>;
  /** Current nested frame depth (used for the depth budget). */
  private frameDepth = 0;
  /** Model calls made in the current turn (shared across all frames). */
  private modelCallsThisTurn = 0;
  private disposed = false;

  private constructor(swipl: SWIPLModule, options: DMLSessionOptions) {
    this.swipl = swipl;
    this.sessionId = options.sessionId ?? nextSessionId();
    this.workspacePath = options.workspacePath;
    this.gasLimit = options.gasLimit;
    this.model = options.runnerOptions.model;
    this.provider = String(options.runnerOptions.provider);
    this.tools = options.tools ?? new Map();
    this.toolPolicy = options.toolPolicy ?? null;
    this.onInputRequired = options.onInputRequired ?? (async () => '');
    this.repairRounds = options.repairRounds ?? 1;
    this.maxDepth = options.maxDepth ?? 3;
    this.maxModelCalls = options.maxModelCalls ?? 24;
    this.hostToolsCatalog = options.hostToolsCatalog;
    this.askUser = options.askUser;
    this.runner = new DMLRunner(swipl, options.runnerOptions);
    this.runner.bindSession(this.sessionId);
  }

  static async open(options: DMLSessionOptions): Promise<DMLSession> {
    const swipl = await loadProlog();
    const session = new DMLSession(swipl, options);

    // Mount the workspace so DML file I/O and `[file].` consult resolve under
    // /workspace exactly as they do for runDML.
    if (options.workspacePath) {
      mountWorkspace(swipl, options.workspacePath);
    }

    const sessionParams: Record<string, unknown> = {
      workspace_path: options.workspacePath ?? './',
      trace: false,
      ...options.params,
    };
    if (options.gasLimit !== undefined) {
      sessionParams.gas_limit = options.gasLimit;
    }

    const memory = session.serializeMemory(options.initialHarnessMemory ?? []);
    const result = session.prologQuery(
      `deepclause_mi:create_session('${session.sessionId}', ${buildParamsTerm(sessionParams)}, [${memory}], [])`
    );
    if (!result) {
      throw new Error('Failed to create REPL session');
    }
    return session;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Parse and load DML source into the living module. */
  async loadCode(code: string): Promise<{ error?: string }> {
    if (this.disposed) {
      return { error: 'Session has been disposed' };
    }
    const result = this.prologQuery(
      `deepclause_mi:load_code('${this.sessionId}', ${quoteString(code)}, Error)`
    );
    const error = plainValue(result?.Error);
    if (error === undefined || error === null) {
      return { error: 'Failed to load code' };
    }
    return error === 'none' ? {} : { error: String(error) };
  }

  /** Load a DML file into the living module (relative paths use the workspace). */
  async load(file: string): Promise<{ error?: string }> {
    const target = path.isAbsolute(file)
      ? file
      : path.resolve(this.workspacePath ?? process.cwd(), file);
    try {
      const code = await fs.readFile(target, 'utf8');
      return await this.loadCode(code);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to read ${file}: ${message}` };
    }
  }

  /** Read-only listing of the living module (`all`, `Name/Arity`, or `tools`). */
  async listing(filter: string = 'all'): Promise<string> {
    const filterTerm = filter === 'all' || filter === 'tools'
      ? filter
      : toListingFilter(filter);
    const result = this.prologQuery(
      `deepclause_mi:repl_listing('${this.sessionId}', ${filterTerm}, Text)`
    );
    const text = plainValue(result?.Text);
    return typeof text === 'string' ? text : '';
  }

  /**
   * Run a goal and enumerate its solutions.
   *
   * Yields `solution` events (one per answer), interleaved with `output`/`log`/
   * `answer` events from the goal, and finally `finished` or `error`.
   */
  async *query(goal: string, options: DMLQueryOptions = {}): AsyncGenerator<DMLEvent> {
    if (this.disposed) {
      yield { type: 'error', content: 'Session has been disposed' };
      return;
    }
    this.modelCallsThisTurn = 0;
    const frameKind = options.frameKind ?? 'object';
    const start = this.prologQuery(
      `deepclause_mi:repl_initial_state('${this.sessionId}', ${frameKind}, State), `
      + `deepclause_mi:query_start('${this.sessionId}', ${quoteString(goal)}, ${frameKind}, State, Error)`
    );
    const error = plainValue(start?.Error);
    if (error === undefined || error === null) {
      yield { type: 'error', content: 'Failed to start query' };
      return;
    }
    if (error !== 'none') {
      yield { type: 'error', content: String(error) };
      return;
    }

    const frame = this.runner.registerDefaultFrame(frameKind);
    if (!frame) {
      yield { type: 'error', content: 'Failed to create query frame' };
      return;
    }

    try {
      yield* this.runner.runFrame(frame.id, this.buildRunOptions(options));
    } finally {
      this.runner.endFrame(frame.id);
    }
  }

  /** Clear the living module and memories (the `reset.` command). */
  async reset(): Promise<void> {
    if (this.isFrozen()) {
      throw new Error('harness is frozen; reset is disabled');
    }
    this.prologQuery(`deepclause_mi:clear_session('${this.sessionId}')`);
    this.runner.clearFrames();
  }

  // ---- Freeze lock (M2) ----

  /** Make the living module read-only (assert/retract/load/commit refused). */
  async freeze(): Promise<void> {
    this.prologQuery(`deepclause_mi:repl_freeze('${this.sessionId}')`);
  }

  /** Like freeze(), but `unfreeze.` is refused for the rest of the process. */
  async lock(): Promise<void> {
    this.prologQuery(`deepclause_mi:repl_lock('${this.sessionId}')`);
  }

  /** Clear the lock list. Throws when the harness is irreversibly locked. */
  async unfreeze(): Promise<void> {
    const result = this.prologQuery(
      `deepclause_mi:repl_try_unfreeze('${this.sessionId}', Error)`
    );
    const error = plainValue(result?.Error);
    if (error !== undefined && error !== null && error !== 'none') {
      throw new Error(String(error));
    }
  }

  isFrozen(): boolean {
    const result = this.prologQuery(`deepclause_mi:repl_is_frozen('${this.sessionId}')`);
    return result?.success === true;
  }

  // ---- Export (M2) ----

  /** Serialize the living module to a self-contained .dml file. */
  async export(file?: string, options: HarnessExportOptions = {}): Promise<HarnessExportResult> {
    const header = options.header ?? buildHarnessHeader({
      timestamp: new Date().toISOString(),
      backend: options.skill ? 'skill' : this.provider,
      model: this.model,
    });
    const result = this.prologQuery(
      `deepclause_mi:export_harness('${this.sessionId}', ${quoteString(header)}, Text)`
    );
    let text = String(plainValue(result?.Text) ?? '');
    if (options.skill) {
      text = applySkillWrapper(text);
    }

    const target = path.resolve(
      this.workspacePath ?? process.cwd(),
      file ?? options.path ?? 'harness.dml',
    );
    await fs.writeFile(target, text, 'utf8');

    const stats = this.prologQuery(
      `deepclause_mi:export_stats('${this.sessionId}', Clauses, Tools, Scripts)`
    );
    return {
      path: target,
      clauses: Number(plainValue(stats?.Clauses) ?? 0),
      tools: Number(plainValue(stats?.Tools) ?? 0),
      scripts: Number(plainValue(stats?.Scripts) ?? 0),
    };
  }

  /**
   * Run a goal in an isolated `execute` child frame and collect its result.
   * Used by the meta `execute` tool. The child frame uses the living scratch
   * module and may itself call task() (RLM-style recursion).
   */
  async executeGoal(goal: string, limit = 5): Promise<ExecuteResult> {
    const childDepth = this.frameDepth + 1;
    if (childDepth > this.maxDepth) {
      return {
        bindings: [],
        solutions: [],
        output: '',
        error: `maximum frame depth (${this.maxDepth}) exceeded`,
      };
    }

    const start = this.prologQuery(
      `deepclause_mi:repl_execute_frame('${this.sessionId}', ${quoteString(goal)}, FrameId, Error)`
    );
    const error = plainValue(start?.Error);
    if (error === undefined || error === null) {
      return { bindings: [], solutions: [], output: '', error: 'Failed to start execute frame' };
    }
    if (error !== 'none') {
      return { bindings: [], solutions: [], output: '', error: String(error) };
    }

    const frameId = String(plainValue(start?.FrameId));
    const frame = this.runner.registerFrame(frameId, 'nested', 1);
    const solutions: ExecuteResult['solutions'] = [];
    let output = '';
    let runError: string | undefined;
    this.frameDepth = childDepth;
    try {
      for await (const event of this.runner.runFrame(frame.id, this.buildRunOptions({}))) {
        if (event.type === 'solution' && solutions.length < limit) {
          solutions.push(event.solution?.bindings ?? []);
        } else if (event.type === 'output' || event.type === 'answer') {
          output += `${event.content ?? ''}\n`;
        } else if (event.type === 'error') {
          runError = event.content;
        }
      }
    } finally {
      this.runner.endFrame(frame.id);
      this.frameDepth = childDepth - 1;
    }

    return {
      bindings: solutions[0] ?? [],
      solutions,
      output: output.slice(0, 4000),
      error: runError,
    };
  }

  /**
   * Prompt mode: English request -> meta task -> DML -> commit -> entry run.
   *
   * The meta task runs in a `meta` frame with exactly the host meta tools.
   * Its scratch edits are discarded; the returned DML source is the single
   * source of truth and is committed replace-by-predicate. A failed commit
   * triggers at most one repair round; any failure leaves the harness
   * byte-identical.
   */
  async *prompt(request: string, options: DMLQueryOptions = {}): AsyncGenerator<DMLEvent> {
    if (this.disposed) {
      yield { type: 'error', content: 'Session has been disposed' };
      return;
    }

    const runOptions = this.buildRunOptions(options);
    this.modelCallsThisTurn = 0;
    let succeeded = false;
    let lastError: string | undefined;
    let currentRequest = request;

    yield { type: 'task_activity', taskState: 'started', taskDescription: request };

    try {
      for (let attempt = 0; attempt <= this.repairRounds && !succeeded; attempt += 1) {
        // 1. Snapshot the living module + bookkeeping + harness memory.
        this.prologQuery(`deepclause_mi:repl_snapshot_save('${this.sessionId}')`);

        const catalog = this.hostToolsCatalog
          ?? 'No capability host tools are registered. Use DML/Prolog, or embed a script as a fact and run it with bash.';
        this.prologQuery(
          `deepclause_mi:repl_set_meta_catalog('${this.sessionId}', ${quoteString(catalog)})`
        );

        // 2. Assemble the prompt and create the meta frame.
        const promptResult = this.prologQuery(
          `deepclause_mi:repl_meta_prompt('${this.sessionId}', ${quoteString(currentRequest)}, Prompt)`
        );
        const promptText = String(plainValue(promptResult?.Prompt) ?? '');
        if (!promptText) {
          this.prologQuery(`deepclause_mi:repl_snapshot_restore('${this.sessionId}')`);
          lastError = 'failed to assemble the meta prompt';
          break;
        }

        const meta = this.prologQuery(
          `deepclause_mi:repl_run_meta('${this.sessionId}', ${quoteString(promptText)}, FrameId, Error)`
        );
        const metaError = plainValue(meta?.Error);
        if (metaError !== 'none' || !meta?.FrameId) {
          this.prologQuery(`deepclause_mi:repl_snapshot_restore('${this.sessionId}')`);
          lastError = String(metaError ?? 'failed to create the meta frame');
          break;
        }

        // 3. Run the meta task, streaming its events.
        const metaFrame = this.runner.registerFrame(String(plainValue(meta.FrameId)), 'meta', 0);
        const metaTools = createMetaTools({
          sessionId: this.sessionId,
          prologQuery: (goal) => this.prologQuery(goal),
          isFrozen: () => this.isFrozen(),
          executeGoal: (goal, limit) => this.executeGoal(goal, limit),
          askUser: this.askUser,
          hostToolsCatalog: this.hostToolsCatalog,
        });

        let code = '';
        let entry = '';
        let metaFailed: string | undefined;
        this.frameDepth = 1;
        try {
          for await (const event of this.runner.runFrame(metaFrame.id, { ...runOptions, metaTools })) {
            if (event.type === 'meta_result') {
              code = event.metaResult?.code ?? '';
              entry = event.metaResult?.entry ?? '';
            } else if (event.type === 'error') {
              metaFailed = event.content;
              yield event;
            } else if (event.type !== 'finished') {
              yield event;
            }
          }
        } catch (error) {
          metaFailed = error instanceof Error ? error.message : String(error);
          yield { type: 'error', content: metaFailed };
        } finally {
          this.runner.endFrame(metaFrame.id);
          this.frameDepth = 0;
        }

        // 4. Discard scratch edits.
        this.prologQuery(`deepclause_mi:repl_snapshot_restore('${this.sessionId}')`);

        if (metaFailed) {
          lastError = `meta task failed: ${metaFailed}`;
          break;
        }
        if (!code.trim()) {
          lastError = 'the meta task returned no DML source';
          break;
        }

        // 5. Strip an optional ```dml fence, then commit.
        const extract = this.prologQuery(
          `deepclause_mi:repl_extract_code(${quoteString(code)}, Source)`
        );
        const source = String(plainValue(extract?.Source) ?? code);
        const commit = this.prologQuery(
          `deepclause_mi:repl_commit('${this.sessionId}', ${quoteString(source)}, ${quoteString(entry)}, Result)`
        );
        const result = plainValue(commit?.Result);
        if (result !== 'ok') {
          lastError = String(result ?? 'commit failed');
          currentRequest = `${request}\n\nYour previous response was rejected: ${lastError}. Return the complete corrected DML.`;
          continue;
        }
        succeeded = true;

        // 6. Run the declared entry (EntryGoal or repl_entry/1), if any.
        const start = this.prologQuery(
          `deepclause_mi:repl_start_entry('${this.sessionId}', HasEntry, Error)`
        );
        const startError = plainValue(start?.Error);
        if (startError !== 'none') {
          yield { type: 'error', content: String(startError) };
          continue;
        }
        const hasEntry = String(plainValue(start?.HasEntry)) === 'true';

        let summary = `committed ${source.trim().split('\n').length} source lines`;
        if (hasEntry) {
          const entryFrame = this.runner.registerDefaultFrame('object');
          if (entryFrame) {
            this.frameDepth = 1;
            try {
              for await (const event of this.runner.runFrame(entryFrame.id, runOptions)) {
                yield event;
              }
            } catch (error) {
              yield { type: 'error', content: error instanceof Error ? error.message : String(error) };
            } finally {
              this.runner.endFrame(entryFrame.id);
              this.frameDepth = 0;
            }
          }
          summary += ' and ran the declared entry';
        } else {
          summary += ' (definitions only)';
        }

        // 7. Record the prompt + outcome in bounded meta memory.
        this.prologQuery(
          `deepclause_mi:repl_record_meta('${this.sessionId}', ${quoteString(request)}, ${quoteString(summary)})`
        );
      }
    } finally {
      yield {
        type: 'task_activity',
        taskState: succeeded ? 'completed' : 'failed',
        taskDescription: request,
      };
    }

    if (!succeeded) {
      yield { type: 'error', content: lastError ?? 'prompt failed' };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.prologQuery(`deepclause_mi:destroy_session('${this.sessionId}')`);
    this.runner.clearFrames();
    await this.runner.dispose();
  }

  private buildRunOptions(options: DMLQueryOptions): InternalRunOptions {
    return {
      workspacePath: this.workspacePath,
      gasLimit: options.gasLimit ?? this.gasLimit,
      tools: options.tools ?? this.tools,
      toolPolicy: options.toolPolicy ?? this.toolPolicy,
      onInputRequired: options.onInputRequired ?? this.onInputRequired,
      signal: options.signal,
      onModelCall: () => this.reserveModelCall(),
    };
  }

  /** Reserve one model call for the current turn; false when exhausted. */
  private reserveModelCall(): boolean {
    if (this.maxModelCalls > 0 && this.modelCallsThisTurn >= this.maxModelCalls) {
      return false;
    }
    this.modelCallsThisTurn += 1;
    return true;
  }

  private prologQuery(goal: string): Record<string, unknown> | null {
    try {
      const result = this.swipl.prolog.query(goal).once();
      return (result ?? null) as Record<string, unknown> | null;
    } catch (error) {
      if (process.env.DEBUG_REPL) {
        console.error('[repl] Prolog query failed:', goal, error);
      }
      return null;
    }
  }

  private serializeMemory(messages: MemoryMessage[]): string {
    return messages
      .map((message) => `message{role: ${message.role}, content: ${quoteString(message.content)}}`)
      .join(', ');
  }
}

/** Quote a JS string as a Prolog double-quoted string. */
export function quoteString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Turn `fact/2` into the Prolog term `fact/2`; other filters become atoms. */
function toListingFilter(filter: string): string {
  if (/^[a-z][a-zA-Z0-9_]*\/\d+$/.test(filter)) {
    return filter;
  }
  if (/^[a-z][a-zA-Z0-9_]*$/.test(filter)) {
    return filter;
  }
  return `'${filter.replace(/'/g, "''")}'`;
}

export type { Frame };
