/**
 * TUI building blocks: transcript line handling and the status bar.
 */
import { describe, expect, it } from 'vitest';

import { LineSink, TranscriptComponent } from '../src/repl/tui/transcript.js';
import { StatusBarComponent } from '../src/repl/tui/status-bar.js';
import { dim, editorTheme, formatInputAnswer, renderUserLine } from '../src/repl/tui/theme.js';
import { ReplStatusTracker } from '../src/repl/status.js';

describe('TranscriptComponent + LineSink', () => {
  it('commits complete lines and keeps an unterminated line pending', () => {
    const transcript = new TranscriptComponent();
    const sink = new LineSink(transcript);
    sink.write('first\nsecond');
    expect(transcript.render(80)).toEqual(['first', 'second']);
    sink.write('\n');
    expect(transcript.render(80)).toEqual(['first', 'second']);
    expect(transcript.getLines()).toEqual(['first', 'second']);
  });

  it('handles carriage-return spinner updates by replacing the live line', () => {
    const transcript = new TranscriptComponent();
    const sink = new LineSink(transcript);
    sink.write('\r\u001b[K⠋ working');
    expect(transcript.render(80)).toEqual(['⠋ working']);
    sink.write('\r\u001b[K✔ done');
    expect(transcript.render(80)).toEqual(['✔ done']);
    sink.write('\n');
    expect(transcript.getLines()).toEqual(['✔ done']);
  });

  it('accumulates streamed text until a newline', () => {
    const transcript = new TranscriptComponent();
    const sink = new LineSink(transcript);
    sink.write('hel');
    sink.write('lo');
    expect(transcript.render(80)).toEqual(['hello']);
    sink.write('\n');
    expect(transcript.getLines()).toEqual(['hello']);
  });

  it('bounds the transcript length', () => {
    const transcript = new TranscriptComponent(3);
    const sink = new LineSink(transcript);
    for (let index = 0; index < 6; index += 1) sink.write(`line ${index}\n`);
    expect(transcript.getLines()).toEqual(['line 3', 'line 4', 'line 5']);
  });

  it('collapses consecutive blank lines', () => {
    const transcript = new TranscriptComponent();
    transcript.append('a');
    transcript.append('');
    transcript.append('');
    transcript.append('b');
    expect(transcript.getLines()).toEqual(['a', '', 'b']);
  });

  it('renders user entries as full-width blue blocks', () => {
    const transcript = new TranscriptComponent();
    transcript.append('hello', 'user');
    const rendered = transcript.render(20);
    expect(rendered[0]).toContain('\u001b[48;5;24m');
    expect(rendered[0].replace(/\u001b\[[0-9;]*m/g, '')).toHaveLength(20);
  });

  it('wraps long user entries without exceeding the width', () => {
    const transcript = new TranscriptComponent();
    transcript.append('x'.repeat(100), 'user');
    const rendered = transcript.render(20);
    expect(rendered.length).toBeGreaterThan(1);
    for (const line of rendered) {
      expect(line.replace(/\u001b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(20);
    }
  });

  it('wraps over-long lines (with ANSI) to the render width', () => {
    const transcript = new TranscriptComponent();
    const sink = new LineSink(transcript);
    sink.write(`\u001b[32m${'x'.repeat(500)}\u001b[0m\n`);
    const lines = transcript.render(40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.replace(/\u001b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(40);
    }
  });
});

describe('TUI theme', () => {
  it('renders a user line as a full-width blue block', () => {
    const line = renderUserLine('hello', 20);
    expect(line).toContain('\u001b[48;5;24m');
    const visible = line.replace(/\u001b\[[0-9;]*m/g, '');
    expect(visible).toBe(` hello ${' '.repeat(13)}`);
  });

  it('colors input answers distinctly', () => {
    const line = formatInputAnswer('yes');
    expect(line).toContain('\u001b[33m');
    expect(line.replace(/\u001b\[[0-9;]*m/g, '')).toBe('> yes');
  });

  it('provides a dimming helper and a blue-bordered editor', () => {
    expect(dim('x')).toContain('\u001b[2m');
    const theme = editorTheme();
    expect(theme.borderColor('─')).toContain('\u001b[38;5;75m');
    expect(theme.selectList.selectedText('x')).toContain('\u001b[36m');
  });
});

describe('StatusBarComponent', () => {
  it('renders workspace, usage, context, and model within the width', () => {
    const tracker = new ReplStatusTracker({
      model: { id: 'gpt-4o', provider: 'openai', reasoning: true, thinkingLevel: 'high' },
      contextWindow: 128_000,
    });
    tracker.observe({
      type: 'usage',
      usage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200, cacheReadTokens: 500 },
      frameKind: 'meta',
    });
    const bar = new StatusBarComponent({
      getSnapshot: () => tracker.snapshot(),
      workspace: '/work/project',
      sessionId: 'repl_1',
      backend: 'pi',
      isFrozen: () => false,
    });

    const lines = bar.render(80);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('/work/project');
    expect(lines[0]).toContain('repl_1');
    expect(lines[1]).toContain('↑1.0k');
    expect(lines[1]).toContain('meta 1.5k/128k');
    expect(lines[1]).toContain('gpt-4o · high');
    for (const line of lines) {
      // strip ANSI for width measurement
      expect(line.replace(/\u001b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(80);
    }
  });

  it('shows a FROZEN marker', () => {
    const tracker = new ReplStatusTracker({ model: { id: 'x', provider: 'env' } });
    const bar = new StatusBarComponent({
      getSnapshot: () => tracker.snapshot(),
      workspace: '/w',
      sessionId: 's',
      backend: 'env',
      isFrozen: () => true,
    });
    expect(bar.render(120)[0]).toContain('FROZEN');
  });
});
