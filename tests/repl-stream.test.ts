/**
 * M3 — streaming: model text, reasoning, and tool calls surface as events.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createHarnessRepl, type HarnessRepl } from '../src/repl/index.js';
import { ReplRenderer } from '../src/repl/render.js';
import type {
  DMLEvent,
  LLMBackend,
  LLMBackendRequest,
  LLMBackendResponse,
} from '../src/types.js';

const ANSI_PATTERN = /\u001b\[[0-9;]*m/;

class StreamingBackend implements LLMBackend {
  calls = 0;

  async complete(request: LLMBackendRequest): Promise<LLMBackendResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      request.onReasoning?.('Let me look at the harness.');
      request.onText?.('Checking the listing. ');
      return {
        text: 'Checking the listing. ',
        reasoning: 'Let me look at the harness.',
        toolCalls: [{ id: 'l1', name: 'listing', arguments: { filter: 'all' } }],
      };
    }
    request.onText?.('Here is the harness.');
    return {
      text: 'Here is the harness.',
      toolCalls: [
        { id: 's1', name: 'set_result', arguments: { variable: 'DMLCode', value: 'streamed(1).' } },
        { id: 's2', name: 'set_result', arguments: { variable: 'EntryGoal', value: '' } },
        { id: 'f1', name: 'finish', arguments: { success: true } },
      ],
    };
  }
}

let workspace: string;
let repl: HarnessRepl;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-stream-'));
});

afterEach(async () => {
  await repl?.dispose();
  await fs.rm(workspace, { recursive: true, force: true });
});

async function collect(gen: AsyncGenerator<DMLEvent>): Promise<DMLEvent[]> {
  const events: DMLEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('streaming and rendering', () => {
  it('surfaces text, reasoning, and tool-call events in order', async () => {
    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      streaming: true,
      llmBackend: new StreamingBackend(),
    });

    const events = await collect(repl.prompt('stream a harness'));
    const kinds = events.map((event) => event.type);

    expect(kinds).toContain('stream');
    expect(kinds).toContain('reasoning');
    expect(kinds).toContain('tool_call');
    expect(kinds.indexOf('reasoning')).toBeLessThan(kinds.lastIndexOf('tool_call'));

    const reasoning = events
      .filter((event) => event.type === 'reasoning' && event.content)
      .map((event) => event.content)
      .join('');
    expect(reasoning).toContain('Let me look at the harness.');

    const streamed = events
      .filter((event) => event.type === 'stream' && event.content)
      .map((event) => event.content)
      .join('');
    expect(streamed).toContain('Here is the harness.');

    expect(events.some((event) => event.type === 'tool_call' && event.toolName === 'listing')).toBe(true);
  });

  it('renders reasoning dimmed without leaking ANSI in plain mode', () => {
    const plainLines: string[] = [];
    const plain = new ReplRenderer({ mode: 'plain', sink: (text) => plainLines.push(text) });
    plain.render({ type: 'reasoning', content: 'thinking' });
    expect(plainLines.join('')).toContain('thinking');
    expect(plainLines.join('')).not.toMatch(ANSI_PATTERN);

    const richLines: string[] = [];
    const rich = new ReplRenderer({ mode: 'rich', color: true, sink: (text) => richLines.push(text) });
    rich.render({ type: 'reasoning', content: 'thinking' });
    expect(richLines.join('')).toMatch(ANSI_PATTERN);
    expect(richLines.join('')).toContain('thinking');
  });

  it('renders a tool-call line', () => {
    const lines: string[] = [];
    const renderer = new ReplRenderer({ mode: 'plain', sink: (text) => lines.push(text) });
    renderer.render({ type: 'tool_call', toolName: 'listing', toolArgs: { filter: 'tools' } });
    expect(lines.join('')).toContain('listing');
  });
});
