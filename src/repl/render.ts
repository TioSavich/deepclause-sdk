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
  /** Sink for normal lines. */
  sink?: (text: string) => void;
  /** Sink for error lines. */
  errorSink?: (text: string) => void;
}

/** Activity events hidden by `--no-events` (output/answer/input/error stay). */
const ACTIVITY_EVENTS = new Set<DMLEvent['type']>([
  'task_activity',
  'tool_call',
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

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  red: '\u001b[31m',
} as const;

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
  private readonly sink: (text: string) => void;
  private readonly errorSink: (text: string) => void;
  /** Frame key of the currently open streamed-text region, or null. */
  private lastStreamFrame: string | null = null;
  private atLineStart = true;

  constructor(options: ReplRendererOptions = {}) {
    this.mode = options.mode ?? 'plain';
    this.color = (options.color ?? true) && this.mode === 'rich';
    this.verbose = options.verbose ?? false;
    this.showStream = options.stream ?? true;
    this.showEvents = options.events ?? true;
    this.sink = options.sink ?? ((text) => process.stdout.write(text));
    this.errorSink = options.errorSink ?? ((text) => process.stderr.write(text));
  }

  /** Write a raw chunk to the normal sink. */
  write(text: string): void {
    this.sink(text);
  }

  /** Write a line to the normal sink. */
  writeLine(text = ''): void {
    this.sink(`${text}\n`);
    this.lastStreamFrame = null;
    this.atLineStart = true;
  }

  writeErrorLine(text: string): void {
    this.errorSink(`${text}\n`);
  }

  /** Render one runtime event. */
  render(event: DMLEvent): void {
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

    if (event.type !== 'stream' && event.type !== 'reasoning') {
      this.flushStream();
    }
    const prefix = this.frameLabel(event);

    switch (event.type) {
      case 'solution':
        this.solution(event.solution?.bindings ?? [], undefined, prefix);
        break;
      case 'output':
        this.writeLine(`${prefix}${event.content ?? ''}`);
        break;
      case 'answer':
        this.writeLine(`${prefix}${this.paint(event.content ?? '', ANSI.bold)}`);
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
        this.writeLine(this.paint(`${prefix}? ${event.prompt ?? ''}`, ANSI.bold));
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
      case 'finished':
      case 'memory_compaction':
      case 'meta_result':
      default:
        break;
    }
  }

  private renderTaskActivity(event: DMLEvent, prefix: string): void {
    const state = event.taskState ?? 'started';
    if (state === 'started') {
      this.writeLine(this.paint(`${prefix}⠋ ${this.describeTask(event)}`, ANSI.dim));
      return;
    }
    const ok = state === 'completed';
    this.writeLine(this.paint(`${prefix}${ok ? '✔' : '✖'} task ${ok ? 'done' : 'failed'}`, ok ? ANSI.dim : ANSI.red));
  }

  private describeTask(event: DMLEvent): string {
    if (event.frameKind === 'meta') {
      return 'meta task (writing the harness)';
    }
    const description = (event.taskDescription ?? '').replace(/\s+/g, ' ').trim();
    if (!description) return 'task';
    return description.length > 72 ? `${description.slice(0, 69)}…` : description;
  }

  private renderToolCall(event: DMLEvent, prefix: string): void {
    const name = event.toolName ?? 'tool';
    const args = formatArgs(event.toolArgs);
    const state = event.toolState;
    if (state === 'completed') {
      const summary = event.toolSummary ? ` — ${truncate(event.toolSummary, 80)}` : '';
      this.writeLine(this.paint(`${prefix}  ✔ ${name}${args}${summary}`, ANSI.dim));
    } else if (state === 'failed') {
      const reason = event.toolError ?? event.toolSummary ?? 'failed';
      this.writeLine(this.paint(`${prefix}  ✖ ${name}${args} — ${truncate(reason, 120)}`, ANSI.red));
    } else {
      this.writeLine(this.paint(`${prefix}  ⚙ ${name}${args}`, ANSI.dim));
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

  /** `meta │ `, `run │ `, or indented `nested │ ` for a frame's events. */
  private frameLabel(event: DMLEvent): string {
    // `--no-events` also drops the frame label, so output/answer lines are plain.
    if (!this.showEvents || !event.frameKind) return '';
    const label = event.frameKind === 'object' ? 'run' : event.frameKind;
    return `${'  '.repeat(event.depth ?? 0)}${label} │ `;
  }

  /**
   * Render one solution's bindings. `terminator` is appended after the last
   * binding line ('.' for the final answer, ' ' while more may follow).
   */
  solution(bindings: DMLBinding[], terminator?: string, prefix = ''): void {
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
      const name = this.paint(binding.name, ANSI.cyan);
      return `${prefix}${name} = ${binding.value}`;
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
