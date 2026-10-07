/**
 * Fixed status bar for the REPL TUI (pi-style footer).
 *
 * Two lines: workspace/session/backend, then token totals, context usage for
 * the active frame slot, and the current model (with reasoning level).
 */

import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';

import {
  formatContextSegment,
  formatModelSegment,
  formatUsageSegment,
  type ReplStatusSnapshot,
} from '../status.js';
import { dim } from './theme.js';

export interface StatusBarOptions {
  getSnapshot: () => ReplStatusSnapshot;
  workspace: string;
  sessionId: string;
  backend: string;
  isFrozen?: () => boolean;
}

/** Right-align `right` within `width`, truncating the left side if needed. */
function align(left: string, right: string, width: number): string {
  const minPadding = 2;
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + minPadding + rightWidth <= width) {
    return left + ' '.repeat(width - leftWidth - rightWidth) + right;
  }
  const available = width - leftWidth - minPadding;
  if (available <= 0) {
    return truncateToWidth(left, width, '');
  }
  const truncated = truncateToWidth(right, available, '');
  const total = leftWidth + visibleWidth(truncated);
  return left + ' '.repeat(Math.max(0, width - total)) + truncated;
}

export class StatusBarComponent implements Component {
  constructor(private readonly options: StatusBarOptions) {}

  render(width: number): string[] {
    const snapshot = this.options.getSnapshot();
    const frozen = this.options.isFrozen?.() ? ' · FROZEN' : '';
    const line1 = truncateToWidth(
      `${this.options.workspace} · session ${this.options.sessionId} · backend ${this.options.backend}${frozen}`,
      width,
      '…',
    );

    const usage = formatUsageSegment(snapshot);
    const context = formatContextSegment(snapshot);
    const left = [usage, context].filter(Boolean).join('  ');
    const line2 = align(left, formatModelSegment(snapshot), width);

    return [dim(line1), dim(line2)];
  }

  invalidate(): void {
    // Stateless rendering: reads the snapshot on each frame.
  }
}
