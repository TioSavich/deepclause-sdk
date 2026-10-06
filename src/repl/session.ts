/**
 * DMLSession — a persistent REPL living module.
 *
 * Owns one Prolog session (the "living module"), one `DMLRunner` bound to it,
 * and the harness memory slot. Goal-mode queries create a `query_start/5`
 * frame, register it with the runner, and drive it with `runFrame`.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { loadProlog, mountWorkspace, type SWIPLModule } from '../prolog/loader.js';
import { getWorkspaceDocAssetPath } from '../system/assets/index.js';
import { DMLRunner, type Frame, type InternalRunOptions, type RunnerOptions } from '../runner.js';
import type {
  DMLEvent,
  FrameKind,
  MemoryMessage,
  ToolDefinition,
  ToolPolicy,
} from '../types.js';
import { buildParamsTerm, plainValue, quotePrologString } from './frames.js';
import {
  buildHarnessHeader,
  type HarnessExportOptions,
  type HarnessExportResult,
} from './export.js';
import { createMetaTools, type ExecuteResult } from './tools.js';
import {
  HistoryStore,
  type HistoryChangedPredicate,
  type HistoryOptions,
  type HistoryTurnRecord,
} from './history.js';

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
  /** Legacy harness-only input handler (prefer onInput). */
  onInputRequired?: (prompt: string) => Promise<string>;
  /** Unified human-in-the-loop channel for meta ask_user and harness input/2. */
  onInput?: (prompt: string, options?: string[]) => Promise<string | undefined>;
  initialHarnessMemory?: MemoryMessage[];
  /** Prompt-mode repair attempts after an invalid commit (default 1). */
  repairRounds?: number;
  /** Maximum nested frame depth (meta -> execute -> object task). Default 3. */
  maxDepth?: number;
  /** Maximum model calls across all frames for one turn (default 100; 0 = unlimited). */
  maxModelCalls?: number;
  /** Host tool catalog text injected into the meta prompt (M5). */
  hostToolsCatalog?: string;
  /** Human-in-the-loop channel for the meta ask_user tool (M6). */
  askUser?: (prompt: string, options?: string[]) => Promise<{ answer: string } | { cancelled: true }>;
  /**
   * Persistent session/trace/harness history. When set, the session records
   * its turns, traces, and harness versions and loads prior harness_* facts
   * into the module so DML can query them. See
   * `docs/DML_REPL_SESSION_HISTORY.md`.
   */
  history?: HistoryOptions;
}

export interface DMLQueryOptions {
  tools?: Map<string, ToolDefinition>;
  toolPolicy?: ToolPolicy | null;
  onInputRequired?: (prompt: string) => Promise<string>;
  /** Per-run override of the unified input channel. */
  onInput?: (prompt: string, options?: string[]) => Promise<string | undefined>;
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
  private inputHandler?: (prompt: string, options?: string[]) => Promise<string | undefined>;
  private repairRounds: number;
  private maxDepth: number;
  private maxModelCalls: number;
  private hostToolsCatalog?: string;

  /** Current nested frame depth (used for the depth budget). */
  private frameDepth = 0;
  /** Model calls made in the current turn (shared across all frames). */
  private modelCallsThisTurn = 0;
  /** Current budget; grows by maxModelCalls when the user extends it. */
  private modelCallBudget: number;
  private dmlReference?: string;
  private dmlAuthoring?: string;
  private disposed = false;
  /** History recorder; present only when the caller enables it. */
  private history?: HistoryStore;
  private historyOptions?: HistoryOptions;
  /** Monotonic per-session turn counter used by history records. */
  private turnCounter = 0;
  private historyWarned = false;

  private constructor(swipl: SWIPLModule, options: DMLSessionOptions) {
    this.swipl = swipl;
    this.sessionId = options.sessionId ?? nextSessionId();
    this.workspacePath = options.workspacePath;
    this.gasLimit = options.gasLimit;
    this.model = options.runnerOptions.model;
    this.provider = String(options.runnerOptions.provider);
    this.tools = options.tools ?? new Map();
    this.toolPolicy = options.toolPolicy ?? null;
    this.inputHandler = options.onInput
      ?? (options.askUser ? (prompt, choices) => options.askUser!(prompt, choices).then((r) => ('cancelled' in r ? undefined : r.answer)) : undefined)
      ?? options.onInputRequired
      ?? undefined;
    this.repairRounds = options.repairRounds ?? 1;
    this.maxDepth = options.maxDepth ?? 3;
    this.maxModelCalls = options.maxModelCalls ?? 100;
    this.modelCallBudget = this.maxModelCalls;
    this.hostToolsCatalog = options.hostToolsCatalog;
    this.historyOptions = options.history;
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
    await session.initHistory();
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

  /**
   * Load a DML file (or a `.zip` bundle) into the living module.
   *
   * A `.zip` bundle extracts its script files into the workspace and loads
   * `harness.dml`; a single-file `.dml` export materializes any inlined
   * `embedded_file/2` facts back into the workspace.
   */
  async load(file: string): Promise<{ error?: string }> {
    const before = this.predicateList();
    const target = path.isAbsolute(file)
      ? file
      : path.resolve(this.workspacePath ?? process.cwd(), file);
    try {
      if (target.toLowerCase().endsWith('.zip')) {
        const result = await this.loadBundle(target);
        if (!result.error) await this.recordHistoryChange('load', this.turnCounter, before);
        return result;
      }
      const code = await fs.readFile(target, 'utf8');
      const result = await this.loadCode(code);
      if (!result.error) {
        this.prologQuery(`deepclause_mi:repl_materialize_embedded('${this.sessionId}')`);
        await this.recordHistoryChange('load', this.turnCounter, before);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to read ${file}: ${message}` };
    }
  }

  /** Workspace-relative files linked by `script_file/2` facts. */
  private scriptFiles(): string[] {
    const result = this.prologQuery(
      `deepclause_mi:repl_script_files('${this.sessionId}', Paths)`
    );
    const paths = plainValue(result?.Paths);
    if (!Array.isArray(paths)) return [];
    return paths.map((value) => String(plainValue(value) ?? '')).filter(Boolean);
  }

  // ---- History (docs/DML_REPL_SESSION_HISTORY.md) ----

  private async initHistory(): Promise<void> {
    if (!this.historyOptions) return;
    try {
      const store = new HistoryStore(
        this.workspacePath ?? process.cwd(),
        this.sessionId,
        this.historyOptions,
      );
      await store.init();
      const existing = await store.readFacts();
      if (existing.trim()) {
        this.prologQuery(`deepclause_mi:repl_history_load('${this.sessionId}', ${quoteString(existing)})`);
      }
      this.history = store;
      this.assertHistoryFacts(await store.startSession({ model: this.model, backend: this.provider }));
    } catch (error) {
      this.warnHistory(error);
    }
  }

  private assertHistoryFacts(facts: string[]): void {
    if (!this.history || facts.length === 0) return;
    try {
      this.prologQuery(
        `deepclause_mi:repl_history_record('${this.sessionId}', ${quoteString(facts.join('\n'))})`
      );
    } catch (error) {
      this.warnHistory(error);
    }
  }

  private recordHistoryEvent(turn: number, event: DMLEvent): void {
    this.history?.recordEvent(
      { turn, frame: event.frameKind },
      event as unknown as { type: string } & Record<string, unknown>,
    );
  }

  private manifestText(): string {
    const result = this.prologQuery(`deepclause_mi:repl_manifest('${this.sessionId}', Text)`);
    return String(plainValue(result?.Text) ?? '');
  }

  private predicateList(): string[] {
    const result = this.prologQuery(`deepclause_mi:repl_user_predicates_text('${this.sessionId}', Text)`);
    return String(plainValue(result?.Text) ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private moduleSource(): string {
    const result = this.prologQuery(`deepclause_mi:export_harness('${this.sessionId}', none, Text)`);
    return String(plainValue(result?.Text) ?? '');
  }

  private async scriptHashes(): Promise<Array<{ path: string; sha256: string }>> {
    const { createHash } = await import('crypto');
    const out: Array<{ path: string; sha256: string }> = [];
    for (const rel of this.scriptFiles()) {
      try {
        const content = await fs.readFile(this.resolveWorkspacePath(rel));
        out.push({ path: rel, sha256: createHash('sha256').update(content).digest('hex') });
      } catch {
        out.push({ path: rel, sha256: 'missing' });
      }
    }
    return out;
  }

  private diffPredicates(
    before: string[],
    after: string[],
    touched: string[],
  ): HistoryChangedPredicate[] {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const changed: HistoryChangedPredicate[] = [];
    for (const predicate of touched) {
      if (!afterSet.has(predicate)) continue;
      changed.push({ predicate, action: beforeSet.has(predicate) ? 'replaced' : 'added' });
    }
    for (const predicate of before) {
      if (!afterSet.has(predicate)) changed.push({ predicate, action: 'removed' });
    }
    changed.sort((a, b) => a.predicate.localeCompare(b.predicate));
    return changed;
  }

  private touchedPredicates(): string[] {
    return this.lastCommitPredicates().split(',').map((entry) => entry.trim()).filter(Boolean);
  }

  /** Record a harness version; returns the new version number. */
  private async recordHistoryChange(
    kind: 'commit' | 'load' | 'reset',
    turn: number,
    before: string[],
  ): Promise<number | undefined> {
    if (!this.history) return undefined;
    try {
      const after = this.predicateList();
      const changed = this.diffPredicates(
        before,
        after,
        kind === 'commit' ? this.touchedPredicates() : after,
      );
      const { facts, version } = await this.history.recordChange({
        kind,
        sessionId: this.sessionId,
        turn,
        changed,
        scripts: await this.scriptHashes(),
        module: this.moduleSource(),
        manifest: this.manifestText(),
      });
      this.assertHistoryFacts(facts);
      return version;
    } catch (error) {
      this.warnHistory(error);
      return undefined;
    }
  }

  private async finishHistoryTurn(record: HistoryTurnRecord): Promise<void> {
    if (!this.history) return;
    try {
      this.assertHistoryFacts(await this.history.recordTurn(record));
      await this.history.flushEvents();
    } catch (error) {
      this.warnHistory(error);
    }
  }

  private warnHistory(error: unknown): void {
    if (this.historyWarned) return;
    this.historyWarned = true;
    if (process.env.DEBUG_REPL) {
      console.error('[repl] history recording failed:', error);
    }
  }

  /** Extract a `.zip` bundle and load its harness.dml. */
  private async loadBundle(zipPath: string): Promise<{ error?: string }> {
    const data = new Uint8Array(await fs.readFile(zipPath));
    const entries = unzipSync(data);
    const harnessName = Object.keys(entries).find((name) => name === 'harness.dml' || name.endsWith('/harness.dml'));
    if (!harnessName) {
      return { error: 'bundle does not contain harness.dml' };
    }

    const files: Array<{ rel: string; bytes: Uint8Array }> = [];
    for (const [name, bytes] of Object.entries(entries)) {
      if (name === harnessName || name === 'manifest.json') continue;
      const rel = name.replace(/^\.\//, '');
      if (path.isAbsolute(rel) || rel.split('/').includes('..')) {
        return { error: `unsafe bundle entry: ${name}` };
      }
      this.resolveWorkspacePath(rel);
      files.push({ rel, bytes });
    }

    for (const file of files) {
      const abs = this.resolveWorkspacePath(file.rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, Buffer.from(file.bytes));
    }

    return this.loadCode(strFromU8(entries[harnessName]));
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
    this.modelCallBudget = this.maxModelCalls;
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

    this.turnCounter += 1;
    const historyTurn = this.turnCounter;
    const historyStart = Date.now();

    const frame = this.runner.registerDefaultFrame(frameKind);
    if (!frame) {
      yield { type: 'error', content: 'Failed to create query frame' };
      return;
    }

    let historyOutcome: HistoryTurnRecord['outcome'] = 'query';
    try {
      for await (const event of this.runner.runFrame(frame.id, this.buildRunOptions(options))) {
        this.recordHistoryEvent(historyTurn, event);
        if (event.type === 'error') historyOutcome = 'failed';
        yield event;
      }
    } finally {
      this.runner.endFrame(frame.id);
    }

    // An aborted goal may have asserted scratch state; preserve it.
    if (options.signal?.aborted) {
      historyOutcome = 'aborted';
      const saved = await this.saveCurrentHarness('cancelled');
      yield {
        type: 'error',
        content: saved ? `turn aborted; current harness saved to ${saved}` : 'turn aborted',
      };
    }

    await this.finishHistoryTurn({
      turn: historyTurn,
      mode: 'goal',
      request: goal,
      outcome: historyOutcome,
      durationMs: Date.now() - historyStart,
      modelCalls: this.modelCallsThisTurn,
    });
  }

  /** Load the bundled DML reference once, for inclusion in the meta prompt. */
  private async loadDmlReference(): Promise<string> {
    if (this.dmlReference !== undefined) {
      return this.dmlReference;
    }
    try {
      this.dmlReference = await fs.readFile(getWorkspaceDocAssetPath('dml-reference'), 'utf8');
    } catch {
      this.dmlReference = '';
    }
    return this.dmlReference;
  }

  /** Load the curated authoring patterns once, for the meta prompt. */
  private async loadDmlAuthoring(): Promise<string> {
    if (this.dmlAuthoring !== undefined) {
      return this.dmlAuthoring;
    }
    try {
      this.dmlAuthoring = await fs.readFile(getWorkspaceDocAssetPath('dml-authoring'), 'utf8');
    } catch {
      this.dmlAuthoring = '';
    }
    return this.dmlAuthoring;
  }

  /** Predicates replaced by the most recent successful commit ("name/arity, …"). */
  private lastCommitPredicates(): string {
    const result = this.prologQuery(
      `deepclause_mi:repl_last_commit_summary('${this.sessionId}', Text)`
    );
    return String(plainValue(result?.Text) ?? '');
  }

  /**
   * Serialize the *current* living module (including any scratch edits) to a
   * temp .dml file. Used as an abort safety net so a cancelled turn's work is
   * not lost.
   */
  /** True when the living module has no user predicates (nothing worth saving). */
  isEmpty(): boolean {
    const result = this.prologQuery(
      `deepclause_mi:repl_user_predicates_text('${this.sessionId}', Text)`
    );
    return String(plainValue(result?.Text) ?? '').trim() === '';
  }

  async saveCurrentHarness(
    reason: string,
    header: string = `aborted turn: ${reason}`,
  ): Promise<string | null> {
    const result = this.prologQuery(
      `deepclause_mi:export_harness('${this.sessionId}', ${quoteString(header)}, Text)`
    );
    const text = String(plainValue(result?.Text) ?? '');
    if (!text.trim()) {
      return null;
    }
    // A bundle (module + current scripts) so an aborted
    // turn's work is fully recoverable, not just the module source.
    const file = path.join(
      os.tmpdir(),
      `deepclause-repl-${this.sessionId}-${Date.now()}.zip`,
    );
    await this.writeBundle(file, text, this.scriptFiles(), header);
    return file;
  }

  /** Clear the living module and memories (the `reset.` command). */
  async reset(): Promise<void> {
    if (this.isFrozen()) {
      throw new Error('harness is frozen; reset is disabled');
    }
    const before = this.predicateList();
    this.prologQuery(`deepclause_mi:clear_session('${this.sessionId}')`);
    this.runner.clearFrames();
    await this.recordHistoryChange('reset', this.turnCounter, before);
  }

  /**
   * Undo the most recent harness transaction by restoring the previous history
   * version. No-op when there is nothing to undo; refused when frozen. The
   * rollback itself is recorded as a change (harness_rollback/5).
   */
  async rollback(): Promise<{ ok: boolean; from?: number; to?: number; error?: string }> {
    if (this.disposed) return { ok: false, error: 'Session has been disposed' };
    if (!this.history) return { ok: false, error: 'history is not enabled; rollback is unavailable' };
    if (this.isFrozen()) return { ok: false, error: 'harness is frozen; rollback is disabled' };
    const plan = await this.history.prepareRollback();
    if (!plan) return { ok: false, error: 'no harness changes to roll back' };
    const result = this.prologQuery(
      `deepclause_mi:repl_rollback('${this.sessionId}', ${quoteString(plan.module)}, Result)`
    );
    const outcome = plainValue(result?.Result);
    if (outcome !== 'ok') {
      return { ok: false, error: String(outcome ?? 'rollback failed') };
    }
    this.assertHistoryFacts(
      await this.history.recordRollback(plan.from, plan.to, this.turnCounter, this.sessionId)
    );
    return { ok: true, from: plan.from, to: plan.to };
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

  /**
   * Serialize the living module.
   *
   * `.zip` produces the self-contained bundle (harness.dml + linked script
   * files + manifest.json). Any other extension produces a single `.dml` with
   * the linked scripts auto-inlined as `embedded_file/2` facts.
   */
  async export(file?: string, options: HarnessExportOptions = {}): Promise<HarnessExportResult> {
    const header = options.header ?? buildHarnessHeader({
      timestamp: new Date().toISOString(),
      backend: options.skill ? 'skill' : this.provider,
      model: this.model,
    });
    const result = this.prologQuery(
      `deepclause_mi:export_harness('${this.sessionId}', ${quoteString(header)}, Text)`
    );
    const moduleText = String(plainValue(result?.Text) ?? '');

    const target = path.resolve(
      this.workspacePath ?? process.cwd(),
      file ?? options.path ?? 'harness.dml',
    );
    const scripts = this.scriptFiles();

    if (target.toLowerCase().endsWith('.zip')) {
      await this.writeBundle(target, moduleText, scripts, header);
    } else {
      await fs.writeFile(target, await this.inlineScripts(moduleText, scripts), 'utf8');
    }

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

  /** Inline linked script files as `embedded_file/2` facts on a single .dml. */
  private async inlineScripts(moduleText: string, scripts: string[]): Promise<string> {
    const facts: string[] = [];
    for (const rel of [...scripts].sort()) {
      const content = await this.readWorkspaceFile(rel);
      if (content === null) continue;
      facts.push(`embedded_file(${quotePrologString(rel)}, ${quotePrologString(content)}).`);
    }
    if (facts.length === 0) return moduleText;
    return `% inlined script files (materialized on load)\n${facts.join('\n')}\n\n${moduleText}`;
  }

  /** Write a `.zip` bundle: harness.dml + linked files + manifest.json. */
  private async writeBundle(
    target: string,
    moduleText: string,
    scripts: string[],
    header: string,
  ): Promise<void> {
    const entries: Record<string, Uint8Array> = { 'harness.dml': strToU8(moduleText) };
    const manifestFiles: Array<{ path: string; bytes: number }> = [];
    for (const rel of [...scripts].sort()) {
      const content = await this.readWorkspaceFile(rel);
      if (content === null) continue;
      const bytes = strToU8(content);
      entries[rel] = bytes;
      manifestFiles.push({ path: rel, bytes: bytes.length });
    }
    entries['manifest.json'] = strToU8(`${JSON.stringify({
      version: 1,
      header,
      model: this.model,
      provider: this.provider,
      timestamp: new Date().toISOString(),
      files: manifestFiles,
    }, null, 2)}\n`);

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(zipSync(entries, { level: 6 })));
  }

  /**
   * Run a goal in an isolated `execute` child frame and collect its result.
   * Used by the meta `execute` tool. The child frame uses the living scratch
   * module and may itself call task() (RLM-style recursion).
   */
  async executeGoal(
    goal: string,
    limit = 5,
    onEvent?: (event: DMLEvent) => void,
  ): Promise<ExecuteResult> {
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
        onEvent?.(event);
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
    this.modelCallBudget = this.maxModelCalls;
    let succeeded = false;
    let lastError: string | undefined;
    let currentRequest = request;
    this.turnCounter += 1;
    const historyTurn = this.turnCounter;
    const historyStart = Date.now();
    const historyBefore = this.predicateList();
    let historyOutcome: HistoryTurnRecord['outcome'] = 'failed';
    let historyVersion: number | undefined;

    yield { type: 'task_activity', taskState: 'started', taskDescription: request };

    try {
      for (let attempt = 0; attempt <= this.repairRounds && !succeeded; attempt += 1) {
        // 1. Snapshot the living module + bookkeeping + harness memory.
        //    (Workspace file edits are written straight to disk.)
        this.prologQuery(`deepclause_mi:repl_snapshot_save('${this.sessionId}')`);

        const catalog = this.hostToolsCatalog
          ?? 'No capability host tools are registered. Use DML/Prolog, or embed a script as a fact and run it with bash.';
        this.prologQuery(
          `deepclause_mi:repl_set_meta_catalog('${this.sessionId}', ${quoteString(catalog)})`
        );
        const reference = await this.loadDmlReference();
        if (reference) {
          this.prologQuery(
            `deepclause_mi:repl_set_dml_reference('${this.sessionId}', ${quoteString(reference)})`
          );
        }
        const authoring = await this.loadDmlAuthoring();
        if (authoring) {
          this.prologQuery(
            `deepclause_mi:repl_set_authoring_examples('${this.sessionId}', ${quoteString(authoring)})`
          );
        }

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
        // Build meta tools per agent-loop so nested `execute` output streams
        // into the meta frame's event sequence.
        const metaTools = (emit: (event: DMLEvent) => void) => createMetaTools({
          sessionId: this.sessionId,
          prologQuery: (goal) => this.prologQuery(goal),
          isFrozen: () => this.isFrozen(),
          executeGoal: (goal, limit) => this.executeGoal(goal, limit, emit),
          askUser: async (prompt, choices) => {
            const answer = await this.requireInput(prompt, choices);
            return answer === undefined ? { cancelled: true } : { answer };
          },
          hostToolsCatalog: this.hostToolsCatalog,
          onEvent: emit,
          fileTools: {
            read: (filePath) => this.readWorkspaceFile(filePath),
            write: (filePath, content) => this.writeWorkspaceFile(filePath, content),
            list: (dir) => this.listWorkspaceDir(dir),
            remove: (filePath) => this.writeWorkspaceFile(filePath, null),
          },
        });

        let code = '';
        let answer = '';
        let metaFailed: string | undefined;
        this.frameDepth = 1;
        try {
          for await (const event of this.runner.runFrame(metaFrame.id, { ...runOptions, metaTools })) {
            if (event.type === 'meta_result') {
              code = event.metaResult?.code ?? '';
              answer = event.metaResult?.answer ?? '';
            } else if (event.type === 'error') {
              // Only the meta frame's own errors abort the turn. An error from
              // an `execute` child frame is a tool result the model can react
              // to (it is still surfaced for rendering).
              if (event.frameKind !== 'nested') {
                metaFailed = event.content;
              }
              this.recordHistoryEvent(historyTurn, event);
              yield event;
            } else if (event.type !== 'finished') {
              this.recordHistoryEvent(historyTurn, event);
              yield event;
            }
          }
        } catch (error) {
          metaFailed = error instanceof Error ? error.message : String(error);
          this.history?.recordEvent(
            { turn: historyTurn, frame: 'meta' },
            { type: 'error', content: metaFailed },
          );
          yield { type: 'error', content: metaFailed };
        } finally {
          this.runner.endFrame(metaFrame.id);
          this.frameDepth = 0;
        }

        // Aborted turn: preserve the scratch state to a temp file, then restore
        // the committed harness (the turn stays atomic).
        if (options.signal?.aborted) {
          historyOutcome = 'aborted';
          const saved = await this.saveCurrentHarness('cancelled');
          this.prologQuery(`deepclause_mi:repl_snapshot_restore('${this.sessionId}')`);
          yield {
            type: 'error',
            content: saved ? `turn aborted; current harness saved to ${saved}` : 'turn aborted',
          };
          lastError = 'turn aborted';
          break;
        }

        // A failed or empty meta turn (iteration cap, budget, model error):
        // save the scratch module + linked scripts BEFORE discarding the
        // transaction, so the author's work is recoverable, then abort.
        if (metaFailed || (!code.trim() && !answer.trim())) {
          historyOutcome = 'failed';
          const saved = await this.saveCurrentHarness(
            metaFailed ? 'meta task failed' : 'meta task produced no DML',
          );
          this.prologQuery(`deepclause_mi:repl_snapshot_restore('${this.sessionId}')`);
          lastError = (metaFailed
            ? `meta task failed: ${metaFailed}`
            : 'the meta task returned no DML source or answer')
            + (saved ? ` (current harness saved to ${saved})` : '');
          break;
        }

        // 4. Discard scratch edits.
        this.prologQuery(`deepclause_mi:repl_snapshot_restore('${this.sessionId}')`);

        // Direct answer: a simple question the model answered without changing
        // the harness. Render the reply and skip the commit entirely.
        if (!code.trim() && answer.trim()) {
          historyOutcome = 'answered';
          const reply = answer.trim();
          yield { type: 'output', content: reply };
          const summary = `answered: ${reply.length > 200 ? `${reply.slice(0, 197)}…` : reply}`;
          this.prologQuery(
            `deepclause_mi:repl_record_meta('${this.sessionId}', ${quoteString(request)}, ${quoteString(summary)})`
          );
          succeeded = true;
          break;
        }

        // 5. Strip an optional ```dml fence, then commit.
        const extract = this.prologQuery(
          `deepclause_mi:repl_extract_code(${quoteString(code)}, Source)`
        );
        const source = String(plainValue(extract?.Source) ?? code);
        const commit = this.prologQuery(
          `deepclause_mi:repl_commit('${this.sessionId}', ${quoteString(source)}, Result)`
        );
        const result = plainValue(commit?.Result);
        if (result !== 'ok') {
          lastError = String(result ?? 'commit failed');
          currentRequest = `${request}\n\nYour previous response was rejected: ${lastError}. Return the complete corrected DML.`;
          continue;
        }
        succeeded = true;
        historyOutcome = 'committed';
        historyVersion = await this.recordHistoryChange('commit', historyTurn, historyBefore);

        // 6. Summarize the commit. Running is the meta task's job (via execute).
        const committed = this.lastCommitPredicates();
        const summary = committed ? `committed ${committed}` : 'committed (no predicates)';

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

    await this.finishHistoryTurn({
      turn: historyTurn,
      mode: 'prompt',
      request,
      outcome: historyOutcome,
      commitVersion: historyVersion,
      durationMs: Date.now() - historyStart,
      modelCalls: this.modelCallsThisTurn,
      error: succeeded ? undefined : lastError,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.history) {
      try {
        this.assertHistoryFacts(await this.history.endSession('dispose'));
      } catch (error) {
        this.warnHistory(error);
      }
    }
    this.prologQuery(`deepclause_mi:destroy_session('${this.sessionId}')`);
    this.runner.clearFrames();
    await this.runner.dispose();
  }

  private buildRunOptions(options: DMLQueryOptions): InternalRunOptions {
    const inputHandler = options.onInput ?? this.inputHandler;
    return {
      workspacePath: this.workspacePath,
      gasLimit: options.gasLimit ?? this.gasLimit,
      tools: options.tools ?? this.tools,
      toolPolicy: options.toolPolicy ?? this.toolPolicy,
      onInputRequired: inputHandler
        ? (prompt) => this.requireInput(prompt)
        : async () => undefined,
      signal: options.signal,
      onModelCall: () => this.reserveModelCall(),
    };
  }

  // ---- Workspace file tools (meta task) ----

  /** Resolve a workspace-relative path, rejecting traversal/absolute paths. */
  private resolveWorkspacePath(relPath: string): string {
    const workspace = path.resolve(this.workspacePath ?? process.cwd());
    if (path.isAbsolute(relPath)) {
      throw new Error(`path must be workspace-relative: ${relPath}`);
    }
    const abs = path.resolve(workspace, relPath);
    if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
      throw new Error(`path escapes the workspace: ${relPath}`);
    }
    return abs;
  }

  private normalizeRel(relPath: string): string {
    return path.relative(path.resolve(this.workspacePath ?? process.cwd()), this.resolveWorkspacePath(relPath))
      .split(path.sep).join('/');
  }

  /** Read a workspace file. */
  private async readWorkspaceFile(relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolveWorkspacePath(this.normalizeRel(relPath)), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Write a workspace file (or delete it when content is null). Writes land on
   * disk immediately so the author can run the file with bash in the same turn.
   */
  private async writeWorkspaceFile(relPath: string, content: string | null): Promise<void> {
    if (this.isFrozen()) {
      throw new Error('harness is frozen; file writes are disabled');
    }
    const abs = this.resolveWorkspacePath(this.normalizeRel(relPath));
    if (content === null) {
      await fs.rm(abs, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  /** List a workspace directory. */
  private async listWorkspaceDir(relPath = '.'): Promise<string[]> {
    try {
      return (await fs.readdir(this.resolveWorkspacePath(this.normalizeRel(relPath)))).sort();
    } catch {
      return [];
    }
  }

  /**
   * Replace the human-in-the-loop channel after construction. The CLI uses
   * this to route input through the REPL's own readline interface instead of a
   * second interface on the same stdin.
   */
  setInputHandler(handler: ((prompt: string, options?: string[]) => Promise<string | undefined>) | undefined): void {
    this.inputHandler = handler;
  }

  /** Resolve a human answer, or undefined when no channel is configured. */
  private async requireInput(prompt: string, options?: string[]): Promise<string | undefined> {
    if (!this.inputHandler) {
      return undefined;
    }
    return this.inputHandler(prompt, options);
  }

  /**
   * Reserve one model call for the current turn. When the budget is reached,
   * the human is asked whether to extend it by another `maxModelCalls`
   * (interactive runs); autonomous runs abort. `0` means unlimited.
   */
  private async reserveModelCall(): Promise<boolean> {
    if (this.maxModelCalls <= 0) {
      this.modelCallsThisTurn += 1;
      return true;
    }
    if (this.modelCallsThisTurn >= this.modelCallBudget) {
      const extend = await this.askBudgetExtension();
      if (!extend) {
        return false;
      }
      this.modelCallBudget += this.maxModelCalls;
    }
    this.modelCallsThisTurn += 1;
    return true;
  }

  private async askBudgetExtension(): Promise<boolean> {
    if (!this.inputHandler) {
      return false;
    }
    const answer = await this.inputHandler(
      `Max model-call budget reached (${this.modelCallBudget}). Continue for another ${this.maxModelCalls} calls? (yes/no)`,
    );
    return /^(y|yes)$/i.test((answer ?? '').trim());
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
