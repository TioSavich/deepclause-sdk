/**
 * Editor that can display a "human input needed" question in its top border.
 *
 * The REPL uses the same editor for normal prompts and for `ask_user` / `input/2`.
 * While input is needed the border turns orange and shows the question, so the
 * user can see *why* the cursor is waiting without a separate prompt line.
 */

import { Editor, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from '@earendil-works/pi-tui';

import { promptBorder, promptLabel } from './theme.js';

export class PromptEditor extends Editor {
  private prompt: string | null = null;

  constructor(tui: TUI, theme: EditorTheme) {
    super(tui, theme);
  }

  /** Set (or clear) the question shown in the top border. */
  setPrompt(prompt: string | null): void {
    this.prompt = prompt;
    this.invalidate();
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    if (!this.prompt || width <= 0) {
      return super.renderTopBorder(width, hiddenLineCount);
    }
    const left = '── ';
    const right = ' ';
    const available = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    const label = truncateToWidth(`? ${this.prompt}`, available, '…');
    const used = visibleWidth(left) + visibleWidth(label) + visibleWidth(right);
    const rest = '─'.repeat(Math.max(0, width - used));
    return `${promptBorder(left)}${promptLabel(label)}${promptBorder(`${right}${rest}`)}`;
  }

  protected renderBottomBorder(width: number, hiddenLineCount: number): string {
    if (!this.prompt || width <= 0) {
      return super.renderBottomBorder(width, hiddenLineCount);
    }
    return promptBorder('─'.repeat(width));
  }
}
