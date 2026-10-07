/**
 * Prolog/DML syntax highlighting and listing cleanup for the REPL.
 *
 * The runtime prints listings as Prolog source (`~q`), which is dense and long.
 * `formatListing` cleans it up for display (one predicate per block, merged
 * doc line, top-level conjuncts on separate lines) and applies ANSI syntax
 * highlighting. It is display-only: the raw text is what the model and files
 * see.
 */

export interface FormatListingOptions {
  /** Apply ANSI colors. When false, only the structural cleanup is done. */
  color?: boolean;
}

const ANSI = {
  reset: '\u001b[0m',
  /** Predicate header (`name/arity`). */
  header: '\u001b[1;36m',
  comment: '\u001b[38;5;244m',
  string: '\u001b[38;5;179m',
  quotedAtom: '\u001b[38;5;80m',
  variable: '\u001b[38;5;111m',
  number: '\u001b[38;5;215m',
  functor: '\u001b[38;5;81m',
  operator: '\u001b[38;5;245m',
  cut: '\u001b[1;31m',
} as const;

type TokenKind =
  | 'space'
  | 'comment'
  | 'string'
  | 'quotedAtom'
  | 'variable'
  | 'number'
  | 'atom'
  | 'functor'
  | 'operator'
  | 'cut'
  | 'other';

interface Token {
  kind: TokenKind;
  value: string;
}

const SYMBOL_CHARS = '+-*/\\^<>=~:.?@#&$';

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isLower(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

function isUpper(char: string): boolean {
  return char >= 'A' && char <= 'Z';
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

/** Tokenize Prolog source well enough to color it and to find top-level commas. */
export function tokenizeProlog(input: string): Token[] {
  const tokens: Token[] = [];
  const length = input.length;
  let index = 0;

  while (index < length) {
    const char = input[index];

    // Line comment.
    if (char === '%') {
      let end = index;
      while (end < length && input[end] !== '\n') end += 1;
      tokens.push({ kind: 'comment', value: input.slice(index, end) });
      index = end;
      continue;
    }
    // Block comment.
    if (char === '/' && input[index + 1] === '*') {
      let end = index + 2;
      while (end < length && !(input[end] === '*' && input[end + 1] === '/')) end += 1;
      end = Math.min(length, end + 2);
      tokens.push({ kind: 'comment', value: input.slice(index, end) });
      index = end;
      continue;
    }
    // Strings, quoted atoms, and back-quoted codes.
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      let end = index + 1;
      while (end < length) {
        if (input[end] === '\\') {
          end += 2;
          continue;
        }
        if (input[end] === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push({
        kind: quote === '"' ? 'string' : quote === "'" ? 'quotedAtom' : 'string',
        value: input.slice(index, end),
      });
      index = end;
      continue;
    }
    // Numbers (integer/float, including `_` separators).
    if (isDigit(char)) {
      let end = index;
      while (end < length && /[0-9_]/.test(input[end])) end += 1;
      if (input[end] === '.' && isDigit(input[end + 1])) {
        end += 1;
        while (end < length && isDigit(input[end])) end += 1;
      }
      if ((input[end] === 'e' || input[end] === 'E') && (isDigit(input[end + 1]) || input[end + 1] === '-' || input[end + 1] === '+')) {
        end += 2;
        while (end < length && isDigit(input[end])) end += 1;
      }
      tokens.push({ kind: 'number', value: input.slice(index, end) });
      index = end;
      continue;
    }
    // Variables.
    if (isUpper(char) || char === '_') {
      let end = index;
      while (end < length && isWordChar(input[end])) end += 1;
      tokens.push({ kind: 'variable', value: input.slice(index, end) });
      index = end;
      continue;
    }
    // Atoms.
    if (isLower(char)) {
      let end = index;
      while (end < length && isWordChar(input[end])) end += 1;
      tokens.push({ kind: 'atom', value: input.slice(index, end) });
      index = end;
      continue;
    }
    // Cut.
    if (char === '!') {
      tokens.push({ kind: 'cut', value: '!' });
      index += 1;
      continue;
    }
    // Symbolic operators.
    if (SYMBOL_CHARS.includes(char)) {
      let end = index;
      while (end < length && SYMBOL_CHARS.includes(input[end])) end += 1;
      tokens.push({ kind: 'operator', value: input.slice(index, end) });
      index = end;
      continue;
    }
    // Brackets, commas, bars, semicolons.
    if ('()[]{},|;'.includes(char)) {
      tokens.push({ kind: 'operator', value: char });
      index += 1;
      continue;
    }
    // Whitespace.
    if (/\s/.test(char)) {
      let end = index;
      while (end < length && /\s/.test(input[end])) end += 1;
      tokens.push({ kind: 'space', value: input.slice(index, end) });
      index = end;
      continue;
    }

    tokens.push({ kind: 'other', value: char });
    index += 1;
  }

  // An atom immediately followed by `(` or `[` is a functor/call: color it.
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].kind !== 'atom') continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j].kind === 'space') j += 1;
    if (tokens[j] && (tokens[j].value === '(' || tokens[j].value === '[')) {
      tokens[i] = { kind: 'functor', value: tokens[i].value };
    }
  }

  return tokens;
}

function colorFor(kind: TokenKind): string | undefined {
  switch (kind) {
    case 'comment': return ANSI.comment;
    case 'string': return ANSI.string;
    case 'quotedAtom': return ANSI.quotedAtom;
    case 'variable': return ANSI.variable;
    case 'number': return ANSI.number;
    case 'functor': return ANSI.functor;
    case 'operator': return ANSI.operator;
    case 'cut': return ANSI.cut;
    default: return undefined;
  }
}

/** Highlight one line of Prolog, preserving its visible text exactly. */
export function highlightProlog(text: string, color = true): string {
  if (!color) return text;
  return tokenizeProlog(text)
    .map((token) => {
      const code = colorFor(token.kind);
      return code ? `${code}${token.value}${ANSI.reset}` : token.value;
    })
    .join('');
}

function isPredicateHeader(line: string): boolean {
  return /^[a-z][A-Za-z0-9_]*\/\d+$/.test(line.trim());
}

/** Split a clause body line on top-level commas (ignoring quoted/parenthesized ones). */
export function splitTopLevelGoals(line: string): string[] {
  const indent = /^(\s*)/.exec(line)?.[1] ?? '';
  const body = line.slice(indent.length);
  const tokens = tokenizeProlog(body);
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  let offset = 0;

  for (const token of tokens) {
    const tokenStart = offset;
    offset += token.value.length;
    if (token.kind === 'space' || token.kind === 'comment') continue;
    if (token.kind === 'operator') {
      if (token.value === '(' || token.value === '[' || token.value === '{') {
        depth += 1;
      } else if (token.value === ')' || token.value === ']' || token.value === '}') {
        depth = Math.max(0, depth - 1);
      } else if (token.value === ',' && depth === 0) {
        segments.push(body.slice(start, tokenStart + 1).trimEnd());
        start = tokenStart + 1;
      }
    }
  }
  segments.push(body.slice(start).trimEnd());

  return segments.map((segment) => `${indent}${segment.trimStart()}`);
}

/** Clean up a listing: merge doc lines, group predicates, split long bodies. */
export function reflowListing(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inBody = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') {
      out.push('');
      inBody = false;
      continue;
    }

    // A predicate header, optionally followed by its `% doc` line.
    if (isPredicateHeader(line)) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(line.trim());
      inBody = false;
      continue;
    }
    // A `% doc` line directly under a header becomes part of the header block.
    if (line.trim().startsWith('%') && out.length > 0 && isPredicateHeader(out[out.length - 1])) {
      out[out.length - 1] = `${out[out.length - 1]}  ${line.trim()}`;
      continue;
    }

    // `head(...) :-` starts a clause body on the following line(s).
    if (line.trimEnd().endsWith(':-')) {
      out.push(line.trimEnd());
      inBody = true;
      continue;
    }

    if (inBody) {
      out.push(...splitTopLevelGoals(line));
      inBody = false;
      continue;
    }

    out.push(line);
  }

  // Trim leading/trailing blank lines.
  while (out.length > 0 && out[0] === '') out.shift();
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** Clean and highlight a README-style Prolog listing for display. */
export function formatListing(text: string, options: FormatListingOptions = {}): string {
  const color = options.color ?? true;
  const cleaned = reflowListing(text);
  return cleaned
    .split('\n')
    .map((line) => {
      const header = /^([a-z][A-Za-z0-9_]*\/\d+)(\s+%.*)?$/.exec(line);
      if (header && color) {
        const rest = header[2] ?? '';
        return `${ANSI.header}${header[1]}${ANSI.reset}${highlightProlog(rest, color)}`;
      }
      return highlightProlog(line, color);
    })
    .join('\n');
}
