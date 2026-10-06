/**
 * A small readline picker.
 *
 * pi's catalog has hundreds of models across dozens of providers, so printing
 * an exhaustive numbered list ("endless lists") is unusable. Instead we show a
 * bounded page and let the user type to filter, then select by number, id, or
 * Enter for the first match. No full TUI is needed.
 */

import * as readline from 'readline';

export interface PickItem {
  id: string;
  label: string;
  /** Optional annotation, e.g. `[reasoning]` or `✓ configured`. */
  hint?: string;
}

export interface PickOptions {
  message: string;
  items: PickItem[];
  pageSize?: number;
  /** Case-insensitive matcher over the raw (lowercased) query. */
  match?: (item: PickItem, query: string) => boolean;
  /** Marks the currently-selected item. */
  currentId?: string;
}

/** Pure filter helper (exported for tests). */
export function filterItems(
  items: PickItem[],
  query: string,
  match?: (item: PickItem, query: string) => boolean,
): PickItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  const matcher = match
    ?? ((item: PickItem, q: string) => item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q));
  return items.filter((item) => matcher(item, needle));
}

/** Build the display block for one picker iteration (exported for tests). */
export function renderPick(
  options: PickOptions,
  query: string,
): { lines: string[]; page: PickItem[]; filtered: PickItem[] } {
  const pageSize = options.pageSize ?? 15;
  const filtered = filterItems(options.items, query, options.match);
  const page = filtered.slice(0, pageSize);
  const lines: string[] = [options.message];
  if (options.currentId) {
    const current = options.items.find((item) => item.id === options.currentId);
    if (current) lines.push(`  current: ${current.label}`);
  }
  if (page.length === 0) {
    lines.push('  (no matches)');
  } else {
    page.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${item.label}${item.hint ? `  ${item.hint}` : ''}`);
    });
    if (filtered.length > page.length) {
      lines.push(`  … ${filtered.length - page.length} more — type to filter`);
    }
  }
  lines.push(
    page.length === 0
      ? 'no matches; refine the filter or q to cancel'
      : `${page.length} of ${options.items.length} • number selects, Enter = first, q cancels`,
  );
  return { lines, page, filtered };
}

/** Interactive picker. Returns the chosen item id, or null on cancel / no items. */
export async function pickFromList(options: PickOptions): Promise<string | null> {
  if (options.items.length === 0) return null;
  if (options.items.length === 1) return options.items[0].id;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> => new Promise((resolve) => rl.question(question, resolve));
  let query = '';
  try {
    for (;;) {
      const { lines, page } = renderPick(options, query);
      process.stdout.write(`${lines.join('\n')}\n`);
      const answer = (await ask('> ')).trim();
      if (answer === 'q' || answer === 'quit') return null;
      if (answer === '') {
        if (page.length > 0) return page[0].id;
        continue;
      }
      const asNumber = Number(answer);
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= page.length) {
        return page[asNumber - 1].id;
      }
      const exact = options.items.find((item) => item.id === answer);
      if (exact) return exact.id;
      query = answer;
    }
  } finally {
    rl.close();
  }
}
