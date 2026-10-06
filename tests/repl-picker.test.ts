/**
 * The readline picker: bounded pages + filter, so long model catalogs do not
 * render as endless lists.
 */
import { describe, expect, it } from 'vitest';

import { filterItems, renderPick, type PickItem } from '../src/repl/picker.js';

const ITEMS: PickItem[] = [
  { id: 'anthropic/claude', label: 'anthropic/claude', hint: '[reasoning]' },
  { id: 'openai/gpt', label: 'openai/gpt' },
  { id: 'openai/o3', label: 'openai/o3' },
];

describe('filterItems', () => {
  it('returns everything for an empty query', () => {
    expect(filterItems(ITEMS, '')).toHaveLength(3);
  });

  it('matches label/id substrings, case-insensitively', () => {
    expect(filterItems(ITEMS, 'OPENAI').map((item) => item.id)).toEqual(['openai/gpt', 'openai/o3']);
    expect(filterItems(ITEMS, 'claude').map((item) => item.id)).toEqual(['anthropic/claude']);
  });

  it('accepts a custom matcher', () => {
    expect(filterItems(ITEMS, 'gpt', (item, query) => item.id.endsWith(query))).toHaveLength(1);
  });
});

describe('renderPick', () => {
  it('pages long lists and reports the total', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ id: `m${index}`, label: `model-${index}` }));
    const { lines, page } = renderPick({ message: 'pick', items: many, pageSize: 5 }, '');
    expect(page).toHaveLength(5);
    expect(lines.join('\n')).toContain('… 25 more');
    expect(lines.join('\n')).toContain('5 of 30');
  });

  it('filters and reports no matches', () => {
    const { lines, page } = renderPick({ message: 'pick', items: ITEMS, pageSize: 5 }, 'zzz');
    expect(page).toHaveLength(0);
    expect(lines.join('\n')).toContain('(no matches)');
  });

  it('marks the current selection', () => {
    const { lines } = renderPick(
      { message: 'pick', items: ITEMS, pageSize: 5, currentId: 'openai/gpt' },
      '',
    );
    expect(lines.join('\n')).toContain('current: openai/gpt');
  });
});
