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

  it('shows the full execute goal wrapped and indented on a blue panel', () => {
    const width = 52;
    const { lines, renderer } = capture('rich', true, width);
    const goal = 'what_is_in("images", "*.png", File, Text), output(File), output(Text)';
    renderer.render({ type: 'tool_call', toolName: 'execute', toolState: 'starting', toolArgs: { goal } } as DMLEvent);
    renderer.render({ type: 'tool_call', toolName: 'execute', toolState: 'running', toolArgs: { goal } } as DMLEvent);
    renderer.render({
      type: 'tool_call', toolName: 'execute', toolState: 'completed', toolArgs: { goal }, toolSummary: '1 solution',
    } as DMLEvent);

    const rendered = lines.join('');
    // Blue panel (truecolor or 256-colour fallback) — distinct from the green tools.
    expect(rendered).toMatch(/\u001b\[48;2;34;44;62m|\u001b\[48;5;24m/);
    expect(rendered).not.toMatch(/\u001b\[48;2;40;54;44m|\u001b\[48;5;22m/);
    // The full goal is shown (wrapped, not truncated) and printed once.
    expect(rendered).not.toContain('…');
    expect(rendered.match(/what_is_in/g)).toHaveLength(1);
    const ansi = /\u001b\[[0-9;]*m/g;
    const visible = lines.map((line) => line.replace(ansi, '').replace(/\n$/, ''));
    expect(visible[0]).toContain('⚙ execute');
    for (const line of visible) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
    const goalLines = visible.slice(1).filter((line) => !line.includes('✔'));
    expect(goalLines.length).toBeGreaterThan(1); // the goal wrapped
    for (const line of goalLines) {
      expect(line.startsWith('    ')).toBe(true);
    }
    const joined = goalLines.map((line) => line.trim()).join(' ');
    expect(joined).toContain('what_is_in("images", "*.png", File, Text), output(File), output(Text)');
  });

  it('previews a few tail lines of tool output on completion', () => {
    const { lines, renderer } = capture('rich', true, 80);
    const command = 'ls -la';
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command } } as DMLEvent);
    renderer.render({
      type: 'tool_call',
      toolName: 'bash',
      toolState: 'completed',
      toolArgs: { command },
      toolResult: { success: true, stdout: 'l1\nl2\nl3\nl4\nl5\n', stderr: '' },
      toolSummary: 'exit 0',
    } as DMLEvent);

    const ansi = /\u001b\[[0-9;]*m/g;
    const text = lines.map((line) => line.replace(ansi, '').replace(/\n$/, '')).join('\n');
    expect(text).toMatch(/\+2 more lines/);
    for (const kept of ['l3', 'l4', 'l5']) expect(text).toContain(kept);
    for (const dropped of ['l1', 'l2']) expect(text).not.toContain(dropped);
  });

  it('verbose mode shows no output preview (the full logs are already streamed)', () => {
    const lines: string[] = [];
    const renderer = new ReplRenderer({
      mode: 'plain', color: false, verbose: true, width: 80, sink: (t) => lines.push(t),
    });
    renderer.render({
      type: 'tool_call', toolName: 'bash', toolState: 'completed', toolArgs: { command: 'ls' },
      toolResult: { success: true, stdout: 'l1\nl2\nl3\nl4\nl5\n', stderr: '' }, toolSummary: 'exit 0',
    } as DMLEvent);
    expect(lines.join('')).not.toContain('l5');
  });

  it('colours output and answer differently (rich mode)', () => {
    const { lines, renderer } = capture('rich', true, 100);
    renderer.render({ type: 'output', content: 'intermediate' } as DMLEvent);
    renderer.render({ type: 'answer', content: 'final' } as DMLEvent);
    expect(lines[0]).toContain('\u001b[38;5;150m');
    expect(lines[1]).toContain('\u001b[1;38;5;118m');
  });

  it('collapses a huge multi-line output event (head + tail)', () => {
    const { lines, renderer } = capture('plain', false);
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    renderer.render({ type: 'output', content } as DMLEvent);
    const out = lines.join('\n');
    expect(out).toContain('line 0');
    expect(out).toContain('line 99');
    expect(out).toContain('more line');
    // The middle is collapsed, not printed.
    expect(out).not.toContain('line 50');
  });

  it('verbose mode keeps a huge output event whole', () => {
    const lines: string[] = [];
    const renderer = new ReplRenderer({
      mode: 'plain',
      color: false,
      verbose: true,
      sink: (text) => lines.push(text),
      errorSink: (text) => lines.push(text),
    });
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    renderer.render({ type: 'output', content } as DMLEvent);
    expect(lines.join('\n')).toContain('line 50');
  });

  it('keeps the nested frame prefix on every output line', () => {
    const { lines, renderer } = capture('plain', false);
    renderer.render({ type: 'output', content: 'first\nsecond', frameKind: 'nested', depth: 1 } as DMLEvent);
    expect(lines[0]).toContain('nested');
    expect(lines[1]).toContain('nested');
    expect(lines[1]).toContain('second');
  });

  it('truncates a long nested output line to the width', () => {
    const { lines, renderer } = capture('plain', false, 80);
    renderer.render({ type: 'output', content: 'x'.repeat(500), frameKind: 'nested', depth: 1 } as DMLEvent);
    expect(lines[0]).toContain('nested');
    expect(lines[0]).toContain('…');
    // Prefix + content + ellipsis stays within the width (sink chunks keep \n).
    expect(lines[0].replace(/\n$/, '').length).toBeLessThanOrEqual(80);
    expect(lines.length).toBe(1);
  });

  it('truncates a long nested solution binding', () => {
    const { lines, renderer } = capture('plain', false, 200);
    renderer.render({
      type: 'solution',
      frameKind: 'nested',
      depth: 1,
      solution: { bindings: [{ name: 'R', value: `dict{stdout:"${'y'.repeat(400)}"}` }], deterministic: false },
    } as DMLEvent);
    const text = lines.join('\n');
    expect(text).toContain('nested');
    expect(text).toContain('R = ');
    expect(text).toContain('…');
    expect(text).not.toContain('y'.repeat(400));
  });

  it('wraps a long top-level output line to the width', () => {
    const { lines, renderer } = capture('plain', false, 40);
    renderer.render({ type: 'output', content: 'a'.repeat(95) } as DMLEvent);
    // 95 chars at width 40 wraps into three lines, each within the width.
    expect(lines.length).toBe(3);
    for (const line of lines) expect(line.replace(/\n$/, '').length).toBeLessThanOrEqual(40);
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

describe('block spacing', () => {
  it('inserts a blank line between streamed text and a tool block', () => {
    const { lines, renderer } = capture('plain');
    renderer.render({ type: 'stream', content: 'thinking' } as DMLEvent);
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command: 'ls' } } as DMLEvent);
    expect(lines.join('')).toMatch(/thinking\n\n/);
  });

  it('inserts a blank line between a tool block and following text', () => {
    const { lines, renderer } = capture('plain');
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'completed', toolArgs: { command: 'ls' }, toolSummary: 'exit 0' } as DMLEvent);
    renderer.render({ type: 'stream', content: 'done' } as DMLEvent);
    expect(lines.join('')).toMatch(/\n\ndone/);
  });

  it('inserts a blank line between consecutive tool calls', () => {
    const { lines, renderer } = capture('plain');
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command: 'ls' } } as DMLEvent);
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command: 'pwd' } } as DMLEvent);
    expect(lines.join('')).toMatch(/\n\n/);
  });

  it('keeps a single tool call lifecycle lines together', () => {
    const { lines, renderer } = capture('plain');
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'starting', toolArgs: { command: 'ls' } } as DMLEvent);
    renderer.render({ type: 'tool_call', toolName: 'bash', toolState: 'completed', toolArgs: { command: 'ls' }, toolSummary: 'exit 0' } as DMLEvent);
    expect(lines.join('')).not.toMatch(/\n\n/);
  });

  it('does not separate output from answer', () => {
    const { lines, renderer } = capture('plain');
    renderer.render({ type: 'output', content: 'intermediate' } as DMLEvent);
    renderer.render({ type: 'answer', content: 'final' } as DMLEvent);
    expect(lines.join('')).not.toMatch(/\n\n/);
  });

  it('indents nested (execute child) frames one extra level', () => {
    const { lines, renderer } = capture('plain');
    renderer.render({ type: 'output', content: 'inside', frameKind: 'nested', depth: 1 } as DMLEvent);
    expect(lines.join('')).toContain('    nested │ inside');
  });

  it('separates a compaction notice from surrounding output', () => {
    const { lines, renderer } = capture('plain');
    renderer.render({ type: 'output', content: 'before' } as DMLEvent);
    renderer.render({ type: 'memory_compaction', content: 'compact applied' } as DMLEvent);
    expect(lines.join('')).toMatch(/before\n\ncompact applied/);
  });

  it('hides top-level and meta task activity, and skipped compaction notices', () => {
    const { lines, renderer } = capture('plain');
    renderer.render({ type: 'task_activity', taskState: 'started', taskDescription: 'How are you' } as DMLEvent);
    renderer.render({ type: 'memory_compaction', compactionAction: 'skipped', content: 'compact skipped 62 -> 62' } as DMLEvent);
    renderer.render({ type: 'memory_compaction', compactionAction: 'applied', content: 'compact applied 100 -> 10' } as DMLEvent);
    renderer.render({ type: 'task_activity', taskState: 'started', frameKind: 'meta' } as DMLEvent);
    renderer.render({ type: 'task_activity', taskState: 'started', taskDescription: 'nested subtask', frameKind: 'nested', depth: 1 } as DMLEvent);
    const rendered = lines.join('');
    expect(rendered).not.toContain('How are you');
    expect(rendered).not.toContain('meta task (writing the harness)');
    expect(rendered).not.toContain('skipped');
    expect(rendered).toContain('compact applied 100 -> 10');
    expect(rendered).toContain('nested subtask');
  });

  it('shows skipped compaction notices in verbose mode', () => {
    const lines: string[] = [];
    const renderer = new ReplRenderer({ mode: 'plain', color: false, verbose: true, sink: (text) => lines.push(text) });
    renderer.render({ type: 'memory_compaction', compactionAction: 'skipped', content: 'compact skipped 62 -> 62' } as DMLEvent);
    expect(lines.join('')).toContain('skipped');
  });

  it('renders input prompts unless the input UI owns them', () => {
    const { lines, renderer } = capture('plain');
    renderer.render({ type: 'input_required', prompt: 'What is your name?' } as DMLEvent);
    expect(lines.join('')).toContain('? What is your name?');
    renderer.setSuppressInputPrompt(true);
    renderer.render({ type: 'input_required', prompt: 'What do you do?' } as DMLEvent);
    expect(lines.join('')).not.toContain('What do you do?');
  });
});
