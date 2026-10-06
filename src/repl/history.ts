/**
 * Persistent session / trace / harness history.
 *
 * See `docs/DML_REPL_SESSION_HISTORY.md`. Storage lives under a
 * workspace-relative directory (default `.deepclause/repl/`):
 *
 *   history.dml                       append-only harness_* facts, consulted at
 *                                     session start and queryable from DML
 *   harness/HEAD.json                 current version pointer
 *   harness/changes.jsonl             one line per harness change
 *   harness/versions/NNNN_<ts>.json   full module snapshot per version
 *   sessions/<id>/session.json        session metadata
 *   sessions/<id>/turns.jsonl         one summary per turn
 *   sessions/<id>/events.jsonl        runtime event trace
 *
 * The recorder is best-effort: callers swallow its errors so a turn never fails
 * because history could not be written.
 */

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export type HistoryTrace = 'off' | 'summary' | 'full';

export interface HistoryOptions {
  /** Workspace-relative root (default `.deepclause/repl`). */
  dir?: string;
  /** `off`, `summary` (event metadata), or `full` (include streamed text). */
  trace?: HistoryTrace;
  maxEventBytes?: number;
  maxSessions?: number;
  maxVersions?: number;
  includeInExport?: boolean;
  /** Regex sources applied to recorded text before writing. */
  redact?: string[];
}

export interface HistoryEventContext {
  turn: number;
  frame?: string;
}

export interface HistoryTurnRecord {
  turn: number;
  mode: 'goal' | 'prompt';
  request: string;
  outcome: 'committed' | 'answered' | 'failed' | 'aborted' | 'query';
  commitVersion?: number;
  entry?: string;
  durationMs: number;
  modelCalls: number;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface HistoryChangedPredicate {
  predicate: string;
  action: 'added' | 'removed' | 'replaced';
}

export interface HistoryChangeRecord {
  kind: 'commit' | 'load' | 'reset';
  sessionId: string;
  turn: number;
  entry?: string;
  changed: HistoryChangedPredicate[];
  scripts: Array<{ path: string; sha256: string }>;
  module: string;
  manifest: string;
}

const DEFAULT_DIR = '.deepclause/repl';

function nowIso(): string {
  return new Date().toISOString();
}

/** Single-quoted Prolog atom. */
export function prologAtom(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export class HistoryStore {
  readonly rootRel: string;
  readonly sessionDirRel: string;
  private readonly rootAbs: string;
  private readonly sessionDirAbs: string;
  private readonly trace: HistoryTrace;
  private readonly maxEventBytes: number;
  private readonly maxSessions: number;
  private readonly maxVersions: number;
  private readonly redactions: RegExp[];
  private eventBuffer: string[] = [];
  private versionCounter = 0;

  constructor(
    workspacePath: string,
    private readonly sessionId: string,
    options: HistoryOptions = {},
  ) {
    this.rootRel = (options.dir ?? DEFAULT_DIR).replace(/\\/g, '/').replace(/\/+$/, '');
    this.rootAbs = path.resolve(workspacePath, this.rootRel);
    this.sessionDirRel = `${this.rootRel}/sessions/${sessionId}`;
    this.sessionDirAbs = path.resolve(workspacePath, this.sessionDirRel);
    this.trace = options.trace ?? 'summary';
    this.maxEventBytes = options.maxEventBytes ?? 8192;
    this.maxSessions = options.maxSessions ?? 50;
    this.maxVersions = options.maxVersions ?? 200;
    this.redactions = (options.redact ?? []).map((source) => new RegExp(source, 'g'));
  }

  get currentVersion(): number {
    return this.versionCounter;
  }

  get tracePath(): string {
    return `${this.sessionDirRel}/events.jsonl`;
  }

  private get historyFile(): string {
    return path.join(this.rootAbs, 'history.dml');
  }

  private get harnessDir(): string {
    return path.join(this.rootAbs, 'harness');
  }

  private get headFile(): string {
    return path.join(this.harnessDir, 'HEAD.json');
  }

  private get changesFile(): string {
    return path.join(this.harnessDir, 'changes.jsonl');
  }

  /** Create directories, read the current version, and prune old entries. */
  async init(): Promise<void> {
    await fs.mkdir(this.sessionDirAbs, { recursive: true });
    await fs.mkdir(path.join(this.harnessDir, 'versions'), { recursive: true });
    try {
      const head = JSON.parse(await fs.readFile(this.headFile, 'utf8')) as { version?: number };
      if (typeof head.version === 'number') this.versionCounter = head.version;
    } catch {
      // no HEAD yet
    }
    await this.prune();
  }

  /** The persisted facts, to be loaded into the module at session start. */
  async readFacts(): Promise<string> {
    try {
      return await fs.readFile(this.historyFile, 'utf8');
    } catch {
      return '';
    }
  }

  async startSession(info: { model: string; backend: string }): Promise<string[]> {
    const startedAt = nowIso();
    const facts = [
      `harness_session(${prologAtom(this.sessionId)}, ${prologAtom(startedAt)}, `
        + `${prologAtom(info.model)}, ${prologAtom(info.backend)}, ${prologAtom(this.sessionDirRel)}).`,
    ];
    await this.appendFacts(facts);
    await this.writeJson(path.join(this.sessionDirAbs, 'session.json'), {
      sessionId: this.sessionId,
      startedAt,
      endedAt: null,
      exit: null,
      model: info.model,
      backend: info.backend,
      traceDir: this.sessionDirRel,
    });
    return facts;
  }

  async endSession(reason: string): Promise<string[]> {
    await this.flushEvents();
    const endedAt = nowIso();
    const facts = [`harness_session_end(${prologAtom(this.sessionId)}, ${prologAtom(endedAt)}).`];
    await this.appendFacts(facts);
    const sessionFile = path.join(this.sessionDirAbs, 'session.json');
    try {
      const existing = JSON.parse(await fs.readFile(sessionFile, 'utf8')) as Record<string, unknown>;
      await this.writeJson(sessionFile, { ...existing, endedAt, exit: reason });
    } catch {
      // best effort
    }
    return facts;
  }

  async recordTurn(record: HistoryTurnRecord): Promise<string[]> {
    const ts = nowIso();
    const facts = [
      `harness_turn(${prologAtom(this.sessionId)}, ${record.turn}, ${prologAtom(ts)}, `
        + `${prologAtom(record.mode)}, ${prologAtom(record.outcome)}).`,
      `harness_trace(${prologAtom(this.sessionId)}, ${record.turn}, ${prologAtom(this.tracePath)}).`,
    ];
    await this.appendFacts(facts);
    await this.appendJsonl(path.join(this.sessionDirAbs, 'turns.jsonl'), { ts, ...record });
    return facts;
  }

  /**
   * Record a harness version. Returns the facts to assert and the new version.
   */
  async recordChange(record: HistoryChangeRecord): Promise<{ facts: string[]; version: number }> {
    const version = this.versionCounter + 1;
    this.versionCounter = version;
    const ts = nowIso();
    const hash = createHash('sha256')
      .update(record.module)
      .update('\n')
      .update(JSON.stringify(record.scripts))
      .digest('hex');
    const entryAtom = record.entry ? prologAtom(record.entry) : 'none';
    const facts = [
      `harness_change(${version}, ${prologAtom(ts)}, ${prologAtom(record.kind)}, `
        + `${prologAtom(record.sessionId)}, ${record.turn}, ${entryAtom}).`,
      ...record.changed.map((change) => {
        const [name, arity] = splitPredicate(change.predicate);
        return `harness_changed(${version}, ${prologAtom(name)}, ${arity}, ${prologAtom(change.action)}).`;
      }),
      `harness_head(${version}, ${prologAtom(ts)}, ${prologAtom(record.sessionId)}, ${record.turn}).`,
    ];
    await this.appendFacts(facts);
    await this.appendJsonl(this.changesFile, {
      version,
      ts,
      sessionId: record.sessionId,
      turn: record.turn,
      kind: record.kind,
      entry: record.entry ?? null,
      hash,
      changed: record.changed,
      scripts: record.scripts,
    });
    await this.writeJson(
      path.join(this.harnessDir, 'versions', `${String(version).padStart(4, '0')}_${fileStamp(ts)}.json`),
      {
        version,
        ts,
        parentVersion: version > 1 ? version - 1 : null,
        kind: record.kind,
        sessionId: record.sessionId,
        turn: record.turn,
        entry: record.entry ?? null,
        hash,
        changed: record.changed,
        scripts: record.scripts,
        module: record.module,
        manifest: record.manifest,
      },
    );
    await this.writeJson(this.headFile, {
      version,
      ts,
      sessionId: record.sessionId,
      turn: record.turn,
      hash,
    });
    return { facts, version };
  }

  /** Buffer one event line (flushed at turn end / dispose). */
  recordEvent(context: HistoryEventContext, event: { type: string } & Record<string, unknown>): void {
    if (this.trace === 'off') return;
    try {
      const line = this.serializeEvent(context, event);
      if (!line) return;
      this.eventBuffer.push(line);
      if (this.eventBuffer.length >= 200) void this.flushEvents();
    } catch {
      // never let tracing break the turn
    }
  }

  async flushEvents(): Promise<void> {
    if (this.eventBuffer.length === 0) return;
    const payload = `${this.eventBuffer.join('\n')}\n`;
    this.eventBuffer = [];
    await this.appendRaw(path.join(this.sessionDirAbs, 'events.jsonl'), payload);
  }

  private serializeEvent(
    context: HistoryEventContext,
    event: { type: string } & Record<string, unknown>,
  ): string | null {
    const base: Record<string, unknown> = {
      ts: nowIso(),
      sessionId: this.sessionId,
      turn: context.turn,
      frame: context.frame,
      type: event.type,
    };
    const put = (key: string, value: unknown): void => {
      if (value !== undefined && value !== null) base[key] = this.scrub(value);
    };
    switch (event.type) {
      case 'stream':
        if (this.trace === 'full') put('content', event.content);
        break;
      case 'output':
      case 'answer':
      case 'error':
      case 'log':
        put('content', event.content);
        break;
      case 'tool_call':
        put('toolName', event.toolName);
        put('toolState', event.toolState);
        put('toolSummary', event.toolSummary);
        put('toolArgs', event.toolArgs);
        break;
      case 'solution':
        put('bindings', (event.solution as { bindings?: unknown } | undefined)?.bindings);
        break;
      case 'usage':
        put('usage', event.usage);
        break;
      case 'task_activity':
        put('taskState', event.taskState);
        put('taskDescription', event.taskDescription);
        break;
      default:
        break;
    }
    return JSON.stringify(base);
  }

  /** Redact and truncate strings recursively. */
  private scrub(value: unknown): unknown {
    if (typeof value === 'string') {
      let text = value;
      for (const pattern of this.redactions) text = text.replace(pattern, '[redacted]');
      if (Buffer.byteLength(text, 'utf8') > this.maxEventBytes) {
        text = `${text.slice(0, this.maxEventBytes)}…[truncated]`;
      }
      return text;
    }
    if (Array.isArray(value)) return value.map((entry) => this.scrub(entry));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, this.scrub(entry)]),
      );
    }
    return value;
  }

  private async appendFacts(facts: string[]): Promise<void> {
    if (facts.length === 0) return;
    await this.appendRaw(this.historyFile, `${facts.join('\n')}\n`);
  }

  private async appendJsonl(file: string, record: Record<string, unknown>): Promise<void> {
    if (this.trace === 'off' && file.endsWith('events.jsonl')) return;
    await this.appendRaw(file, `${JSON.stringify(record)}\n`);
  }

  private async appendRaw(file: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, text, 'utf8');
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  /** Keep only the newest sessions and versions. */
  private async prune(): Promise<void> {
    await this.pruneDir(path.join(this.rootAbs, 'sessions'), this.maxSessions);
    await this.pruneDir(path.join(this.harnessDir, 'versions'), this.maxVersions);
  }

  private async pruneDir(dir: string, keep: number): Promise<void> {
    try {
      const entries = await fs.readdir(dir);
      if (entries.length <= keep) return;
      const sorted = entries.sort();
      for (const entry of sorted.slice(0, entries.length - keep)) {
        await fs.rm(path.join(dir, entry), { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

function splitPredicate(predicate: string): [string, number] {
  const slash = predicate.lastIndexOf('/');
  if (slash === -1) return [predicate, 0];
  return [predicate.slice(0, slash), Number(predicate.slice(slash + 1)) || 0];
}

function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}
