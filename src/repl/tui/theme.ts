/**
 * Minimal ANSI theme for the REPL TUI.
 *
 * The transcript is fed by `ReplRenderer` (rich mode) and the status bar is
 * rendered as plain text; these helpers add the few colors the TUI itself owns
 * (user-message blocks, the editor border, and the dim footer).
 */

import { visibleWidth, type EditorTheme } from '@earendil-works/pi-tui';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  /** Blueish chrome for the input/status area border. */
  border: '\u001b[38;5;75m',
  /** Orange "input needed" border/label for ask_user / input/2. */
  prompt: '\u001b[38;5;214m',
  /** pi-style user message: blue background, bright foreground. */
  userBg: '\u001b[48;5;24m',
  userFg: '\u001b[38;5;255m',
} as const;

function paint(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}

/**
 * Render one line of a user message as a full-width blue block (pi-style). The
 * text is padded to the terminal width so the background spans the row.
 */
export function renderUserLine(text: string, width: number): string {
  const body = ` ${text} `;
  const padding = Math.max(0, width - visibleWidth(body));
  return `${ANSI.userBg}${ANSI.userFg}${body}${' '.repeat(padding)}${ANSI.reset}`;
}

/** An `ask_user` / `input/2` answer echo (distinct from a normal prompt). */
export function formatInputAnswer(text: string): string {
  return paint(`> ${text}`, ANSI.yellow);
}

/** The border of the editing box while the runtime needs human input. */
export function promptBorder(text: string): string {
  return paint(text, ANSI.prompt);
}

/** The question shown inside the editing box while input is needed. */
export function promptLabel(text: string): string {
  return paint(text, `${ANSI.bold}${ANSI.prompt}`);
}

/** Dim the status bar so it recedes behind the transcript. */
export function dim(text: string): string {
  return paint(text, ANSI.dim);
}

/** Editor theme: a blue border, cyan selection. */
export function editorTheme(): EditorTheme {
  return {
    borderColor: (text: string) => paint(text, ANSI.border),
    selectList: {
      selectedPrefix: (text: string) => paint(text, ANSI.cyan),
      selectedText: (text: string) => paint(text, `${ANSI.bold}${ANSI.cyan}`),
      description: (text: string) => paint(text, ANSI.dim),
      scrollInfo: (text: string) => paint(text, ANSI.dim),
      noMatch: (text: string) => paint(text, ANSI.dim),
    },
  };
}
