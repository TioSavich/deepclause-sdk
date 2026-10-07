/**
 * M1 — REPL renderer: rich/plain/json modes.
 */
import { describe, expect, it, vi } from 'vitest';

import { ReplRenderer, formatBindings } from '../src/repl/render.js';
import type { DMLEvent } from '../src/types.js';

function capture(mode: 'rich' | 'plain' | 'json', color = true, width = 100): { lines: string[]; renderer: ReplRenderer } {
  const lines: string[] = [];
  const renderer = new ReplRenderer({
    mode,
    color,
    width,
    sink: (text) => lines.push(text),
    errorSink: (text) => lines.push(text),
  });
  return { lines, renderer };
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/;

describe('ReplRenderer', () => {
  it('stream:false / events:false hide activity but keep outputs and answers', () => {
    const lines: string[] = [];
    const renderer = new ReplRenderer({
      mode: 'plain',
      color: false,
      stream: false,
      events: false,
      sink: (text) => lines.push(text),
    });

    renderer.render({ type: 'stream', content: 'streamed text' } as DMLEvent);
    renderer.render({ type: 'reasoning', content: 'thinking' } as DMLEvent);
    renderer.render({ type: 'task_activity', taskState: 'started', taskDescription: 'x' } as DMLEvent);
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'completed' } as DMLEvent);
    renderer.render({ type: 'output', content: 'plain output' } as DMLEvent);
    renderer.render({ type: 'answer', content: 'the answer' } as DMLEvent);

    const rendered = lines.join('');
    expect(rendered).toContain('plain output');
    expect(rendered).toContain('the answer');
    expect(rendered).not.toContain('streamed text');
    expect(rendered).not.toContain('thinking');
    expect(rendered).not.toContain('bash');
  });

  it('renders the full bash script (not truncated) once per call', () => {
    const { lines, renderer } = capture('plain');
    const command = 'curl -s "https://example.com/data.json" \\\n  | jq -r ".items[] | select(.ok) | .id"';
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command } } as DMLEvent);
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'running', toolArgs: { command } } as DMLEvent);
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'completed', toolArgs: { command }, toolSummary: 'exit 0' } as DMLEvent);

    const rendered = lines.join('');
    expect(rendered).toContain('curl -s "https://example.com/data.json"');
    expect(rendered).toContain('jq -r ".items[] | select(.ok) | .id"');
    // Printed once for the call, not on every lifecycle event.
    expect(rendered.match(/jq -r/g)).toHaveLength(1);
    // Full script: no inline truncation ellipsis.
    expect(rendered).not.toContain('…');

    // A second call with the same script prints again.
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command } } as DMLEvent);
    expect(lines.join('').match(/jq -r/g)).toHaveLength(2);
  });

  it('tints tool-call lines with a full-width panel background (rich mode)', () => {
    const { lines, renderer } = capture('rich', true, 60);
    renderer.render({
      type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command: 'echo hi' },
    } as DMLEvent);

    // A background panel code is applied (truecolor or 256-colour fallback).
    expect(lines[0]).toMatch(/\u001b\[48;[25];/);
    // Visible text (ignoring SGR) is padded out to the panel width.
    const visible = lines[0].replace(/\u001b\[[0-9;]*m/g, '').replace(/\n$/, '');
    expect(visible).toHaveLength(60);

    // Plain mode has no panel background.
    const plain = capture('plain', false, 60);
    plain.renderer.render({
      type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command: 'echo hi' },
    } as DMLEvent);
    expect(plain.lines.join('')).not.toMatch(/\u001b\[48;/);
  });

  it('word-wraps and indents a long bash script to the panel width', () => {
    const width = 50;
    const { lines, renderer } = capture('rich', true, width);
    const command = 'for f in $(ls *.png); do convert "$f" -resize 50% "small-$f"; done';
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command } } as DMLEvent);

    const ansi = /\u001b\[[0-9;]*m/g;
    const visible = lines.map((line) => line.replace(ansi, '').replace(/\n$/, ''));
    expect(visible[0]).toContain('⚙ bash');
    expect(visible.length).toBeGreaterThan(2); // wrapped onto several lines
    for (const line of visible.slice(1)) {
      expect(line.length).toBeLessThanOrEqual(width);
      expect(line.startsWith('    ')).toBe(true); // indented script lines
    }
    // Wrapping only reflows whitespace; the script text is intact.
    const joined = visible.slice(1).map((line) => line.trim()).join(' ');
    expect(joined).toContain('convert "$f" -resize 50% "small-$f"; done');
  });

  it('hard-breaks a single over-long token to fit the panel width', () => {
    const width = 40;
    const { lines, renderer } = capture('rich', true, width);
    renderer.render({
      type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command: `curl ${'x'.repeat(120)}` },
    } as DMLEvent);

    const ansi = /\u001b\[[0-9;]*m/g;
    const visible = lines.map((line) => line.replace(ansi, '').replace(/\n$/, ''));
    expect(visible.length).toBeGreaterThan(3);
    for (const line of visible) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it('colours output and answer differently (rich mode)', () => {
    const { lines, renderer } = capture('rich', true, 100);
    renderer.render({ type: 'output', content: 'intermediate' } as DMLEvent);
    renderer.render({ type: 'answer', content: 'final' } as DMLEvent);
    expect(lines[0]).toContain('\u001b[38;5;150m');
    expect(lines[1]).toContain('\u001b[1;38;5;118m');
  });

  it('shows a live spinner while a model call is in progress (rich mode)', () => {
    vi.useFakeTimers();
    try {
      const { lines, renderer } = capture('rich', true, 80);
      renderer.render({ type: 'model_call', modelCallState: 'started', modelId: 'gpt-x', frameKind: 'meta' } as DMLEvent);
      expect(lines.join('')).toContain('model call (gpt-x)…');
      // The frame is rewritten in place (carriage return + clear line).
      vi.advanceTimersByTime(200);
      expect(lines.join('')).toContain('\r\u001b[K');

      renderer.render({ type: 'model_call', modelCallState: 'completed' } as DMLEvent);
      renderer.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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
