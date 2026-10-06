/**
 * M1 — REPL renderer: rich/plain/json modes.
 */
import { describe, expect, it } from 'vitest';

import { ReplRenderer, formatBindings } from '../src/repl/render.js';
import type { DMLEvent } from '../src/types.js';

function capture(mode: 'rich' | 'plain' | 'json', color = true): { lines: string[]; renderer: ReplRenderer } {
  const lines: string[] = [];
  const renderer = new ReplRenderer({
    mode,
    color,
    sink: (text) => lines.push(text),
    errorSink: (text) => lines.push(text),
  });
  return { lines, renderer };
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/;

describe('ReplRenderer', () => {
  it('formatBindings renders values, or true when there are none', () => {
    expect(formatBindings([])).toBe('true');
    expect(formatBindings([{ name: 'X', value: 'a' }, { name: 'Y', value: '2' }])).toBe('X = a\nY = 2');
  });

  it('plain mode emits no ANSI', () => {
    const { lines, renderer } = capture('plain');
    renderer.solution([{ name: 'X', value: 'a' }]);
    renderer.render({ type: 'error', content: 'boom' });
    renderer.render({ type: 'output', content: 'hello' });
    expect(lines.join('')).not.toMatch(ANSI_PATTERN);
    expect(lines.join('')).toContain('X = a');
    expect(lines.join('')).toContain('ERROR: boom');
  });

  it('rich mode colours binding names', () => {
    const { lines, renderer } = capture('rich', true);
    renderer.solution([{ name: 'X', value: 'a' }]);
    expect(lines.join('')).toMatch(ANSI_PATTERN);
    expect(lines.join('')).toContain('X');
  });

  it('rich mode without colour emits no ANSI', () => {
    const { lines, renderer } = capture('rich', false);
    renderer.solution([{ name: 'X', value: 'a' }]);
    expect(lines.join('')).not.toMatch(ANSI_PATTERN);
  });

  it('json mode emits one object per event', () => {
    const { lines, renderer } = capture('json');
    const events: DMLEvent[] = [
      { type: 'solution', solution: { bindings: [{ name: 'X', value: 'a' }], deterministic: false } },
      { type: 'answer', content: 'done' },
    ];
    for (const event of events) {
      renderer.render(event);
    }
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed[0]).toMatchObject({ type: 'solution', solution: { bindings: [{ name: 'X', value: 'a' }] } });
    expect(parsed[1]).toEqual({ type: 'answer', content: 'done' });
  });
});
