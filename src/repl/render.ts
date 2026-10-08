/**
 * Line-oriented REPL renderer.
 *
 * Three modes:
 *  - `rich` (default on a TTY): coloured bindings and labels, no live rewriting.
 *  - `plain` (default when stdout is not a TTY): one static line per event, no ANSI.
 *  - `json`: one JSON object per event for tooling.
 *
 * This is the M1 surface (solutions, output, answer, errors). Live streaming
 * of model text/tool calls is added in M3.
 */

import type { DMLBinding, DMLEvent } from '../types.js';
import { formatListing } from './highlight.js';

export type RenderMode = 'rich' | 'plain' | 'json';

export interface ReplRendererOptions {
  mode?: RenderMode;
  /** Colour output (rich mode only). */
  color?: boolean;
  /** Show DML `log` events. */
  verbose?: boolean;
  /** Render streamed model text/reasoning (default true). `--no-stream` disables. */
  stream?: boolean;
  /** Render activity events (task activity, tool calls, usage, logs); default true. `--no-events` disables. */
  events?: boolean;
  /** Terminal width for the tool-call panel background (default: stdout columns, or 80). */
  width?: number;
  /** Sink for normal lines. */
  sink?: (text: string) => void;
  /** Sink for error lines. */
  errorSink?: (text: string) => void;
  /** Observe every event before filtering (used by the status tracker). */
  onEvent?: (event: DMLEvent) => void;
}

/** Activity events hidden by `--no-events` (output/answer/input/error stay). */
const ACTIVITY_EVENTS = new Set<DMLEvent['type']>([
  'task_activity',
  'tool_call',
  'model_call',
  'usage',
  'log',
  'memory_compaction',
  'meta_result',
]);

function formatArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) {
    return '';
  }
  const parts = Object.entries(args).map(([key, value]) => {
    const text = (typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').trim();
    const compact = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    return `${key}=${compact}`;
  });
  return `(${parts.join(', ')})`;
}

/** Max captured output lines previewed under a completed tool call. */
const TOOL_OUTPUT_LINES = 3;

/** Max physical lines of a single `output` event before it is collapsed. */
const OUTPUT_LINES = 24;

/**
 * Bound a potentially huge `output` event (e.g. a `write/1` of a large term).
 * Keeps the head and tail and collapses the middle; `--verbose` shows it whole.
 */
function boundOutput(text: string, max = OUTPUT_LINES): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length <= max) {
    return lines;
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  const omitted = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    `… (+${omitted} more line${omitted === 1 ? '' : 's'})`,
    ...lines.slice(lines.length - tail),
  ];
}

/** Pull a few output lines from a tool result (bash stdout/stderr). */
function extractToolOutput(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  const text = typeof r.stdout === 'string' && r.stdout.trim()
    ? r.stdout
    : (typeof r.stderr === 'string' ? r.stderr : '');
  if (!text.trim()) return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\t/g, '    ').trimEnd())
    .filter((line) => line.trim() !== '');
}

/** Word-wrap a single line to `width`, hard-breaking tokens that are longer. */
function wrapLine(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) {
    return [text];
  }
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    let breakAt = remaining.lastIndexOf(' ', width);
    if (breakAt <= 0) {
      breakAt = width; // no space: hard-break a long token (URL, path, flag)
    }
    out.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^ +/, '');
  }
  out.push(remaining);
  return out;
}

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

/** Human-readable wall-clock duration: `450ms`, `1.2s`, `2m05s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m${String(remainder).padStart(2, '0')}s`;
}

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  /** DML `output/1` intermediate results. */
  output: '\u001b[38;5;150m',
  /** The final `answer/1`. */
  answer: '\u001b[1;38;5;118m',
} as const;

/** True when the terminal advertises 24-bit colour (COLORTERM). */
const TRUECOLOR = /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? '');

/**
 * Tool-call panel: a subtle, near-transparent green tint behind activity
 * (truecolor when available, else a 256-colour fallback). Kept light so it
 * reads as a faint wash over the terminal background rather than a solid fill.
 */
const TOOL_PANEL_GREEN_BG = TRUECOLOR ? '\u001b[48;2;40;54;44m' : '\u001b[48;5;22m';
/** Blue tint for `execute` (a goal, not a shell command). */
const TOOL_PANEL_BLUE_BG = TRUECOLOR ? '\u001b[48;2;34;44;62m' : '\u001b[48;5;24m';
const TOOL_PANEL_FG = '\u001b[38;5;252m';
const TOOL_PANEL_ERROR_BG = TRUECOLOR ? '\u001b[48;2;58;36;36m' : '\u001b[48;5;52m';
const TOOL_PANEL_ERROR_FG = '\u001b[38;5;224m';

type ToolTone = 'green' | 'blue' | 'error';

/**
 * Tools whose main argument is a long literal worth showing in full (wrapped
 * and indented under the header), with the panel colour for that tool.
 */
const TOOL_DETAIL: Record<string, { arg: string; tone: ToolTone }> = {
  bash: { arg: 'command', tone: 'green' },
  execute: { arg: 'goal', tone: 'blue' },
};

/** A copy of `args` without `key` (for the compact header of a detail tool). */
function omitKey(args: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k !== key) rest[k] = v;
  }
  return rest;
}

/** Spinner frames for the live model-call indicator. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Strip ANSI SGR sequences (for measuring visible width). */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Format solution bindings as `Name = value` lines (or `true`). */
export function formatBindings(bindings: DMLBinding[]): string {
  if (bindings.length === 0) {
    return 'true';
  }
  return bindings.map((binding) => `${binding.name} = ${binding.value}`).join('\n');
}

export class ReplRenderer {
  readonly mode: RenderMode;
  private readonly color: boolean;
  private readonly verbose: boolean;
  private readonly showStream: boolean;
  private readonly showEvents: boolean;
  private width: number;
  private sink: (text: string) => void;
  private errorSink: (text: string) => void;
  private eventSink?: (event: DMLEvent) => void;
  /** Frame key of the currently open streamed-text region, or null. */
  private lastStreamFrame: string | null = null;
  private atLineStart = true;
  /** Last detail body printed for a running call (dedupes start/running). */
  private lastToolDetail?: string;
  /** Live model-call indicator state. */
  private spinnerTimer?: ReturnType<typeof setInterval>;
  private spinnerFrame = 0;
  private spinnerPrefix = '';
  private spinnerLabel = '';
  private spinnerVisible = false;

  constructor(options: ReplRendererOptions = {}) {
    this.mode = options.mode ?? 'plain';
    this.color = (options.color ?? true) && this.mode === 'rich';
    this.verbose = options.verbose ?? false;
    this.showStream = options.stream ?? true;
    this.showEvents = options.events ?? true;
    this.width = options.width ?? (process.stdout.columns || 80);
    this.sink = options.sink ?? ((text) => process.stdout.write(text));
    this.errorSink = options.errorSink ?? ((text) => process.stderr.write(text));
    this.eventSink = options.onEvent;
  }

  /** Replace the output sinks (used when moving into a TUI transcript). */
  setSink(sink: (text: string) => void, errorSink?: (text: string) => void): void {
    this.sink = sink;
    if (errorSink) this.errorSink = errorSink;
  }

  /** Update the rendering width (TUI resize). */
  setWidth(width: number): void {
    if (width > 0) this.width = width;
  }

  /** Clean up and syntax-highlight a Prolog listing for display. */
  listing(text: string): string {
    return formatListing(text, { color: this.color && this.mode === 'rich' });
  }

  /**
   * Suppress `input_required` prompt lines. The TUI editor shows the question in
   * its border, so a transcript line would be a duplicate.
   */
  setSuppressInputPrompt(suppress: boolean): void {
    this.suppressInputPrompt = suppress;
  }

  /** Stop the live indicator (call before the renderer goes out of scope). */
  dispose(): void {
    this.stopSpinner();
  }

  /** Last rendered block group, used to separate tool/text/output blocks. */
  private currentBlock: string | null = null;
  private toolBlockCounter = 0;
  private currentToolBlock: string | null = null;
  private taskBlockCounter = 0;
  private currentTaskBlock: string | null = null;
  /** When true, `input_required` events are rendered by the input UI instead. */
  private suppressInputPrompt = false;

  /** Write a raw chunk to the normal sink. */
  write(text: string): void {
    this.stopSpinner();
    this.sink(text);
  }

  /** Write a line to the normal sink. */
  writeLine(text = ''): void {
    this.stopSpinner();
    this.sink(`${text}\n`);
    this.lastStreamFrame = null;
    this.atLineStart = true;
  }

  writeErrorLine(text: string): void {
    this.stopSpinner();
    this.errorSink(`${text}\n`);
  }

  /**
   * The visual block an event belongs to. Events in the same block are printed
   * contiguously; switching blocks inserts one blank line. Returns null for
   * events that do not participate (solutions, spinners, metadata).
   */
  private blockKeyFor(event: DMLEvent): string | null {
    switch (event.type) {
      case 'stream':
        return `text:${event.frameKind ?? 'run'}@${event.depth ?? 0}`;
      case 'reasoning':
        return event.content ? `reasoning:${event.frameKind ?? 'run'}@${event.depth ?? 0}` : null;
      case 'tool_call': {
        if (this.currentToolBlock === null || event.toolState === 'starting') {
          this.toolBlockCounter += 1;
          this.currentToolBlock = `tool:${this.toolBlockCounter}`;
        }
        return this.currentToolBlock;
      }
      case 'task_activity': {
        if (this.currentTaskBlock === null || event.taskState === 'started') {
          this.taskBlockCounter += 1;
          this.currentTaskBlock = `task:${this.taskBlockCounter}`;
        }
        return this.currentTaskBlock;
      }
      case 'output':
      case 'answer':
      case 'error':
        return 'output';
      case 'memory_compaction':
        return 'compaction';
      default:
        return null;
    }
  }

  /** Insert a separating blank line when the block changes. */
  private beginBlock(key: string | null): void {
    if (!key) return;
    if (this.currentBlock !== null && this.currentBlock !== key) {
      this.writeLine('');
    }
    this.currentBlock = key;
  }

  /** Render one runtime event. */
  render(event: DMLEvent): void {
    this.eventSink?.(event);
    if (!this.showStream && (event.type === 'stream' || event.type === 'reasoning')) {
      return;
    }
    if (!this.showEvents && ACTIVITY_EVENTS.has(event.type)) {
      return;
    }
    if (this.mode === 'json') {
      this.sink(`${JSON.stringify(event)}\n`);
      return;
    }

    // The top-level prompt task and the meta frame simply echo work that is
    // already shown by the user message and the streamed authoring text, and
    // skipped compactions are noise. Hide them unless verbose; the status
    // tracker still observes every event via `eventSink`.
    if (
      event.type === 'task_activity'
      && !event.frameKind
    ) {
      return;
    }
    if (event.type === 'memory_compaction' && event.compactionAction === 'skipped' && !this.verbose) {
      return;
    }

    this.stopSpinner();
    if (event.type !== 'stream' && event.type !== 'reasoning') {
      this.flushStream();
    }
    this.beginBlock(this.blockKeyFor(event));
    const prefix = this.frameLabel(event);

    switch (event.type) {
      case 'solution':
        this.solution(
          event.solution?.bindings ?? [],
          undefined,
          prefix,
          // Nested (`execute` child) bindings often carry a whole result term;
          // keep the transcript readable by truncating them.
          event.frameKind === 'nested' ? 160 : undefined,
        );
        break;
      case 'output': {
        // A single event can carry a large multi-line term (`write/1` of an
        // `exec(...)` result). Bound the line count, then fit each line to the
        // terminal width so nothing wraps (which would desync the TUI). Nested
        // activity is truncated to one line each; top-level output wraps.
        const max = event.frameKind === 'nested' ? 6 : OUTPUT_LINES;
        const bounded = this.verbose
          ? (event.content ?? '')
          : boundOutput(event.content ?? '', max).join('\n');
        this.writeFrameText(prefix, bounded, ANSI.output, event.frameKind === 'nested');
        break;
      }
      case 'answer':
        this.writeFrameText(prefix, event.content ?? '', ANSI.answer, false);
        break;
      case 'model_call':
        this.renderModelCall(event, prefix);
        break;
      case 'stream':
        this.writeStream(event, event.content ?? '', 'text');
        break;
      case 'reasoning':
        if (event.content) {
          this.writeStream(event, this.paint(event.content, ANSI.dim), 'reasoning');
        }
        break;
      case 'log':
        if (this.verbose) {
          this.writeLine(this.paint(`${prefix}[log] ${event.content ?? ''}`, ANSI.dim));
        }
        break;
      case 'task_activity':
        this.renderTaskActivity(event, prefix);
        break;
      case 'tool_call':
        this.renderToolCall(event, prefix);
        break;
      case 'input_required':
        if (!this.suppressInputPrompt) {
          this.writeLine(this.paint(`${prefix}? ${event.prompt ?? ''}`, ANSI.bold));
        }
        break;
      case 'error':
        this.writeErrorLine(this.paint(`${prefix}ERROR: ${event.content ?? ''}`, ANSI.red));
        break;
      case 'usage':
        if (this.verbose && event.usage) {
          this.writeLine(this.paint(
            `${prefix}[usage] in=${event.usage.inputTokens} out=${event.usage.outputTokens} total=${event.usage.totalTokens}`,
            ANSI.dim,
          ));
        }
        break;
      case 'memory_compaction':
        this.writeLine(this.paint(`${prefix}${event.content ?? 'memory compacted'}`, ANSI.dim));
        break;
      case 'finished':
      case 'meta_result':
      default:
        break;
    }
  }

  private renderTaskActivity(event: DMLEvent, prefix: string): void {
    const state = event.taskState ?? 'started';
    if (state === 'started') {
      this.writeLine(this.paint(`${prefix}▸ Task  ${this.describeTask(event)}`, ANSI.dim));
      return;
    }
    const ok = state === 'completed';
    this.writeLine(this.paint(`${prefix}${ok ? '✔' : '✖'} Task  ${ok ? 'done' : 'failed'}`, ok ? ANSI.dim : ANSI.red));
  }

  private describeTask(event: DMLEvent): string {
    const description = (event.taskDescription ?? '').replace(/\s+/g, ' ').trim();
    if (!description) return 'task';
    return description.length > 72 ? `${description.slice(0, 69)}…` : description;
  }

  private renderToolCall(event: DMLEvent, prefix: string): void {
    const name = event.toolName ?? 'tool';
    const state = event.toolState;
    // Some tools have a long literal argument (a shell script, a DML goal) that
    // is shown in full, wrapped and indented, rather than truncated inline.
    const spec = TOOL_DETAIL[name];
    const rawDetail = spec ? event.toolArgs?.[spec.arg] : undefined;
    const detail = typeof rawDetail === 'string' ? rawDetail : undefined;
    const tone: ToolTone = spec?.tone ?? 'green';
    const args = detail === undefined ? formatArgs(event.toolArgs) : '';

    if (state === 'completed') {
      const duration = typeof event.toolDurationMs === 'number' ? ` · ${formatDuration(event.toolDurationMs)}` : '';
      const summary = event.toolSummary ? ` — ${truncate(event.toolSummary, 80)}` : '';
      this.lastToolDetail = undefined;
      this.writeLine(this.toolPanel(`${prefix}  ✔ ${name}${args}${duration}${summary}`, tone));
      // A short tail of the captured output (bash). Full output is --verbose.
      if (!this.verbose) {
        for (const line of this.toolOutputLines(prefix, tone, event.toolResult)) {
          this.writeLine(line);
        }
      }
      return;
    }
    if (state === 'failed') {
      const duration = typeof event.toolDurationMs === 'number' ? ` · ${formatDuration(event.toolDurationMs)}` : '';
      const reason = event.toolError ?? event.toolSummary ?? 'failed';
      this.lastToolDetail = undefined;
      this.writeLine(this.toolPanel(`${prefix}  ✖ ${name}${args}${duration} — ${truncate(reason, 120)}`, 'error'));
      return;
    }

    if (detail !== undefined) {
      // A call emits `starting` then `running`; print the body once.
      if (detail !== this.lastToolDetail) {
        this.lastToolDetail = detail;
        const others = formatArgs(omitKey(event.toolArgs, spec!.arg));
        this.writeLine(this.toolPanel(`${prefix}  ⚙ ${name}${others}`, tone));
        // Print the body on panel lines, word-wrapped to the available width
        // and indented under the header so wrapped bodies stay aligned.
        const indent = '    ';
        const avail = Math.max(20, this.width - stripAnsi(prefix).length - indent.length);
        for (const rawLine of detail.replace(/\r\n?/g, '\n').split('\n')) {
          for (const segment of wrapLine(rawLine, avail)) {
            this.writeLine(this.toolPanel(`${prefix}${indent}${segment}`, tone));
          }
        }
      }
      return;
    }

    this.writeLine(this.toolPanel(`${prefix}  ⚙ ${name}${args}`, tone));
  }

  /** Up to TOOL_OUTPUT_LINES captured output lines, as tinted panel lines. */
  private toolOutputLines(prefix: string, tone: ToolTone, result: unknown): string[] {
    const lines = extractToolOutput(result);
    if (lines.length === 0) {
      return [];
    }
    const indent = '    ';
    const avail = Math.max(20, this.width - stripAnsi(prefix).length - indent.length);
    const shown = lines.slice(-TOOL_OUTPUT_LINES);
    const omitted = lines.length - shown.length;
    const out: string[] = [];
    if (omitted > 0) {
      out.push(this.toolPanel(`${prefix}${indent}… (+${omitted} more line${omitted === 1 ? '' : 's'})`, tone));
    }
    for (const line of shown) {
      out.push(this.toolPanel(`${prefix}${indent}${line.length > avail ? `${line.slice(0, avail - 1)}…` : line}`, tone));
    }
    return out;
  }

  /** Show/hide the live model-call indicator. */
  private renderModelCall(event: DMLEvent, prefix: string): void {
    if (event.modelCallState === 'started') {
      this.startSpinner(prefix, event.modelId ? `model call (${event.modelId})…` : 'model call…');
      return;
    }
    this.stopSpinner();
  }

  /** Start a `\r`-based spinner on the current line (rich TTY only). */
  private startSpinner(prefix: string, label: string): void {
    if (!this.color || this.mode !== 'rich') {
      return;
    }
    this.stopSpinner();
    this.spinnerPrefix = prefix;
    this.spinnerLabel = label;
    this.spinnerFrame = 0;
    this.paintSpinner();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame += 1;
      this.paintSpinner();
    }, 90);
  }

  private paintSpinner(): void {
    const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
    this.sink(`\r\u001b[K${this.spinnerPrefix}${this.paint(`${frame} ${this.spinnerLabel}`, ANSI.dim)}`);
    this.spinnerVisible = true;
  }

  /** Clear the spinner line and stop its timer (no-op when inactive). */
  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    if (this.spinnerVisible) {
      this.sink('\r\u001b[K');
      this.spinnerVisible = false;
    }
  }

  /**
   * A full-width, tinted line for tool activity (pi-style panel). Falls back to
   * the bare text when colour is disabled. Existing ANSI in `text` is preserved
   * and the visible width (ignoring SGR) is padded out to the terminal width.
   */
  private toolPanel(text: string, tone: ToolTone): string {
    if (!this.color) {
      return text;
    }
    const bg = tone === 'error'
      ? TOOL_PANEL_ERROR_BG
      : tone === 'blue'
        ? TOOL_PANEL_BLUE_BG
        : TOOL_PANEL_GREEN_BG;
    const fg = tone === 'error' ? TOOL_PANEL_ERROR_FG : TOOL_PANEL_FG;
    const width = this.width - stripAnsi(text).length;
    const pad = width > 0 ? ' '.repeat(width) : '';
    return `${bg}${fg}${text}${pad}${ANSI.reset}`;
  }

  /**
   * Write `text` as frame-prefixed lines that each fit the terminal width:
   * wrap by default, or truncate each physical line (nested activity).
   */
  private writeFrameText(prefix: string, text: string, code: string, truncate: boolean): void {
    const avail = Math.max(20, this.width - stripAnsi(prefix).length);
    const normalized = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    for (const rawLine of normalized.split('\n')) {
      const segments = truncate
        ? [rawLine.length > avail ? `${rawLine.slice(0, avail - 1)}…` : rawLine]
        : wrapLine(rawLine, avail);
      for (const segment of segments) {
        this.writeLine(`${prefix}${this.paint(segment, code)}`);
      }
    }
  }

  /** Write a streamed chunk, prefixing it with its frame label on first use. */
  private writeStream(event: DMLEvent, chunk: string, kind: 'text' | 'reasoning'): void {
    // Include the kind so switching reasoning <-> text starts a fresh region.
    const key = `${event.frameKind ?? 'plain'}@${event.depth ?? 0}:${kind}`;
    if (key !== this.lastStreamFrame) {
      if (!this.atLineStart) {
        this.sink('\n');
      }
      const prefix = this.frameLabel(event);
      if (prefix) this.sink(prefix);
      this.lastStreamFrame = key;
      this.atLineStart = false;
    }
    this.sink(chunk);
    this.atLineStart = chunk.endsWith('\n');
  }

  /** Close an open streamed-text region before writing a line. */
  private flushStream(): void {
    if (this.lastStreamFrame !== null) {
      if (!this.atLineStart) this.sink('\n');
      this.lastStreamFrame = null;
      this.atLineStart = true;
    }
  }

  /** `run │ ` for an object frame; nested (`execute` child) events are indented only. */
  private frameLabel(event: DMLEvent): string {
    // `--no-events` also drops the frame label, so output/answer lines are plain.
    if (!this.showEvents || !event.frameKind) return '';
    const depth = event.depth ?? 0;
    // Nested (`execute` child) activity reads as belonging to the parent tool
    // call through indentation alone — no `nested` label.
    if (event.frameKind === 'nested') {
      return '  '.repeat(depth + 1);
    }
    const label = event.frameKind === 'object' ? 'run' : event.frameKind;
    const indent = '  '.repeat(depth);
    return `${indent}${label} │ `;
  }

  /**
   * Render one solution's bindings. `terminator` is appended after the last
   * binding line ('.' for the final answer, ' ' while more may follow).
   */
  solution(bindings: DMLBinding[], terminator?: string, prefix = '', maxValue?: number): void {
    if (this.mode === 'json') {
      this.sink(`${JSON.stringify({ type: 'solution', solution: { bindings, deterministic: false } })}\n`);
      return;
    }
    this.flushStream();
    if (bindings.length === 0) {
      this.writeLine(`${prefix}true${terminator ?? '.'}`);
      return;
    }
    const lines = bindings.map((binding) => {
      const value = maxValue !== undefined ? truncate(binding.value, maxValue) : binding.value;
      const name = this.paint(binding.name, ANSI.cyan);
      return `${prefix}${name} = ${value}`;
    });
    const last = lines.length - 1;
    lines.forEach((line, index) => {
      this.writeLine(index === last ? `${line}${terminator ?? '.'}` : line);
    });
  }

  private paint(text: string, code: string): string {
    if (!this.color) {
      return text;
    }
    return `${code}${text}${ANSI.reset}`;
  }
}
