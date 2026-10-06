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
  private tools: Map<string, ToolDefinition>;
  private toolPolicy: ToolPolicy | null;
  private onInputRequired: (prompt: string) => Promise<string>;
  private disposed = false;

  private constructor(swipl: SWIPLModule, options: DMLSessionOptions) {
    this.swipl = swipl;
    this.sessionId = options.sessionId ?? nextSessionId();
    this.workspacePath = options.workspacePath;
    this.gasLimit = options.gasLimit;
    this.tools = options.tools ?? new Map();
    this.toolPolicy = options.toolPolicy ?? null;
    this.onInputRequired = options.onInputRequired ?? (async () => '');
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
    this.prologQuery(`deepclause_mi:clear_session('${this.sessionId}')`);
    this.runner.clearFrames();
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
    };
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
