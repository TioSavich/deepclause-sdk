/**
 * Minimal, streaming markdown → ANSI renderer for the REPL transcript.
 *
 * The transcript is line-based (`LineSink` → `TranscriptComponent`), so we
 * render markdown per completed line rather than using a component tree. This
 * covers the common shapes an agent emits — headings, fenced and inline code,
 * bold/italic/strike, links, lists, blockquotes, and horizontal rules — and can
 * style a fence's content because it tracks the open/close fence across lines.
 */

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  italic: '\u001b[3m',
  strike: '\u001b[9m',
  dim: '\u001b[2m',
  heading: '\u001b[1;38;5;180m',
  code: '\u001b[38;5;141m',
  codeBlock: '\u001b[38;5;114m',
  link: '\u001b[38;5;75m',
  bullet: '\u001b[38;5;141m',
  quote: '\u001b[38;5;245m',
  hr: '\u001b[38;5;240m',
} as const;

const PLACEHOLDER = /\u0000(\d+)\u0000/g;

/** Apply inline markdown (code, links, bold, italic, strike) to one line. */
export function renderMarkdownInline(text: string): string {
  const stash: string[] = [];
  const hold = (value: string): string => {
    stash.push(value);
    return `\u0000${stash.length - 1}\u0000`;
  };

  // Protect code spans and links first so emphasis rules cannot rewrite the
  // ANSI sequences or the bracketed parts.
  let out = text
    .replace(/`([^`]+)`/g, (_, code: string) => hold(`${ANSI.code}${code}${ANSI.reset}`))
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, label: string, url: string) => hold(`${ANSI.link}${label}${ANSI.reset}${ANSI.dim} (${url})${ANSI.reset}`),
    );

  out = out
    .replace(/~~([^~]+)~~/g, `${ANSI.strike}$1${ANSI.reset}`)
    .replace(/\*\*([^*]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`)
    .replace(/__([^_]+)__/g, `${ANSI.bold}$1${ANSI.reset}`)
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, `$1${ANSI.italic}$2${ANSI.reset}`)
    .replace(/(^|[^_\w])_([^_\n]+)_/g, `$1${ANSI.italic}$2${ANSI.reset}`);

  return out.replace(PLACEHOLDER, (_, index: string) => stash[Number(index)] ?? '');
}

/** Render one already-complete markdown line to an ANSI string. */
export function renderMarkdownLine(line: string, inCode: boolean): string {
  if (inCode) {
    return `${ANSI.codeBlock}${line}${ANSI.reset}`;
  }
  const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) {
    return `${ANSI.heading}${renderMarkdownInline(heading[2])}${ANSI.reset}`;
  }
  if (/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
    return `${ANSI.hr}${'─'.repeat(Math.max(3, Math.min(24, line.trim().length)))}${ANSI.reset}`;
  }
  const quote = /^ {0,3}>\s?(.*)$/.exec(line);
  if (quote) {
    return `${ANSI.quote}│ ${renderMarkdownInline(quote[1])}${ANSI.reset}`;
  }
  const list = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (list) {
    return `${list[1]}${ANSI.bullet}•${ANSI.reset} ${renderMarkdownInline(list[3])}`;
  }
  return renderMarkdownInline(line);
}

/**
 * A stateful, line-buffered markdown stream. `push` returns the styled lines
 * completed by a chunk; `flush` returns the trailing partial line.
 */
export class MarkdownStream {
  private buffer = '';
  private inCode = false;

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    const out: string[] = [];
    for (const line of parts) {
      out.push(this.line(line));
    }
    return out;
  }

  flush(): string[] {
    const out: string[] = [];
    if (this.buffer !== '') {
      out.push(this.line(this.buffer));
      this.buffer = '';
    }
    // A fence left open at the end of a message should not colour the next one.
    this.inCode = false;
    return out;
  }

  private line(line: string): string {
    const fence = /^ {0,3}(```|~~~)/.test(line);
    if (fence) {
      this.inCode = !this.inCode;
      return `${ANSI.dim}${line}${ANSI.reset}`;
    }
    return renderMarkdownLine(line, this.inCode);
  }
}
