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
  /** Sink for normal lines. */
  sink?: (text: string) => void;
  /** Sink for error lines. */
  errorSink?: (text: string) => void;
}

function formatArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) {
    return '';
  }
  const parts = Object.entries(args).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const compact = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    return `${key}=${compact}`;
  });
  return `(${parts.join(', ')})`;
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
  private readonly sink: (text: string) => void;
  private readonly errorSink: (text: string) => void;

  constructor(options: ReplRendererOptions = {}) {
    this.mode = options.mode ?? 'plain';
    this.color = (options.color ?? true) && this.mode === 'rich';
    this.verbose = options.verbose ?? false;
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
  }

  writeErrorLine(text: string): void {
    this.errorSink(`${text}\n`);
  }

  /** Render one runtime event. */
  render(event: DMLEvent): void {
    if (this.mode === 'json') {
      this.sink(`${JSON.stringify(event)}\n`);
      return;
    }

    switch (event.type) {
      case 'solution':
        this.solution(event.solution?.bindings ?? []);
        break;
      case 'output':
        this.writeLine(`${this.indentFor(event)}${event.content ?? ''}`);
        break;
      case 'answer':
        this.writeLine(`${this.indentFor(event)}${this.paint(event.content ?? '', ANSI.bold)}`);
        break;
      case 'stream':
        this.sink(event.content ?? '');
        break;
      case 'reasoning':
        if (event.content) {
          this.sink(this.paint(event.content, ANSI.dim));
        }
        break;
      case 'log':
        if (this.verbose) {
          this.writeLine(this.paint(`${this.indentFor(event)}[log] ${event.content ?? ''}`, ANSI.dim));
        }
        break;
      case 'task_activity':
        if (this.verbose && event.taskState && event.taskDescription) {
          this.writeLine(this.paint(`${this.indentFor(event)}[task ${event.taskState}] ${event.taskDescription}`, ANSI.dim));
        }
        break;
      case 'tool_call':
        if (event.toolName) {
          this.writeLine(this.paint(`${this.indentFor(event)}  ⚙ ${event.toolName}${formatArgs(event.toolArgs)}`, ANSI.dim));
        }
        break;
      case 'input_required':
        this.writeLine(this.paint(`${this.indentFor(event)}? ${event.prompt ?? ''}`, ANSI.bold));
        break;
      case 'error':
        this.writeErrorLine(this.paint(`${this.indentFor(event)}ERROR: ${event.content ?? ''}`, ANSI.red));
        break;
      case 'usage':
        if (this.verbose && event.usage) {
          this.writeLine(this.paint(
            `[usage] in=${event.usage.inputTokens} out=${event.usage.outputTokens} total=${event.usage.totalTokens}`,
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

  /**
   * Render one solution's bindings. `terminator` is appended after the last
   * binding line ('.' for the final answer, ' ' while more may follow).
   */
  solution(bindings: DMLBinding[], terminator?: string): void {
    if (this.mode === 'json') {
      this.sink(`${JSON.stringify({ type: 'solution', solution: { bindings, deterministic: false } })}\n`);
      return;
    }
    if (bindings.length === 0) {
      this.writeLine(`true${terminator ?? '.'}`);
      return;
    }
    const lines = bindings.map((binding) => {
      const name = this.paint(binding.name, ANSI.cyan);
      return `${name} = ${binding.value}`;
    });
    const last = lines.length - 1;
    lines.forEach((line, index) => {
      this.writeLine(index === last ? `${line}${terminator ?? '.'}` : line);
    });
  }

  /** Indent nested frame activity (execute children run at depth >= 1). */
  private indentFor(event: DMLEvent): string {
    const depth = event.depth ?? 0;
    return depth > 0 ? '  '.repeat(depth) : '';
  }

  private paint(text: string, code: string): string {
    if (!this.color) {
      return text;
    }
    return `${code}${text}${ANSI.reset}`;
  }
}
