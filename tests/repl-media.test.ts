/**
 * Media (images) input: reference-only media in DML memory is resolved to pi
 * image content blocks for the model call. See `docs/DML_MEDIA.md`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createHarnessRepl, type HarnessRepl } from '../src/repl/index.js';
import { createPiAdapter } from '../src/repl/backend.js';
import type { DMLEvent, LLMBackend, LLMBackendRequest, LLMBackendResponse } from '../src/types.js';

interface CannedResponse {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

class CannedBackend implements LLMBackend {
  readonly requests: LLMBackendRequest[] = [];

  constructor(private readonly script: CannedResponse[]) {}

  async complete(request: LLMBackendRequest): Promise<LLMBackendResponse> {
    this.requests.push(request);
    const index = this.requests.length - 1;
    const response = this.script[Math.min(index, this.script.length - 1)] ?? { text: '' };
    return {
      text: response.text ?? '',
      toolCalls: (response.toolCalls ?? []).map((call, callIndex) => ({
        id: `${index}-${callIndex}`,
        name: call.name,
        arguments: call.arguments,
      })),
    };
  }
}

function describeImage(answer: string): CannedResponse {
  return {
    toolCalls: [
      { name: 'set_result', arguments: { variable: 'Description', value: answer } },
      { name: 'finish', arguments: { success: true } },
    ],
  };
}

async function collect(gen: AsyncGenerator<DMLEvent>): Promise<DMLEvent[]> {
  const events: DMLEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const HARNESS = `
run :-
    read_media("pic.png", Img),
    attach_media(Img),
    task("describe the image", Description),
    answer(Description).

round_trip :-
    read_media("pic.png", Img),
    attach_media(Img),
    get_memory(M0),
    (   member(Msg0, M0), is_dict(Msg0), get_dict(media, Msg0, _)
    ->  output(before_has_media)
    ;   output(before_no_media)
    ),
    task("describe the image", Description),
    get_memory(M),
    (   member(Msg, M), is_dict(Msg), get_dict(media, Msg, _)
    ->  output(after_has_media)
    ;   output(after_no_media)
    ),
    answer(Description).
`;

let workspace: string;
let repl: HarnessRepl | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-media-'));
  await fs.writeFile(path.join(workspace, 'pic.png'), PNG);
});

afterEach(async () => {
  await repl?.dispose();
  repl = undefined;
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('media input', () => {
  it('maps resolved media to pi image content blocks', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const registry = {
      hasConfiguredAuth: () => true,
      complete: async (_model: unknown, context: Record<string, unknown>) => {
        requests.push(context);
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input: 1, output: 1, totalTokens: 2 },
          stopReason: 'stop',
        };
      },
    };
    const model = { id: 'test-model', provider: 'openai', api: 'openai' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { backend } = createPiAdapter(registry as any, model as any);

    await backend.complete({
      messages: [
        { role: 'user', content: 'look', media: [{ mimeType: 'image/png', data: 'AAA' }] },
      ],
    });

    const content = (requests[0].messages as Array<{ content: unknown }>)[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toContainEqual({ type: 'text', text: 'look' });
    expect(content).toContainEqual({ type: 'image', data: 'AAA', mimeType: 'image/png' });
  });

  it('attaches a referenced image to a task call, reference-only in memory', async () => {
    const backend = new CannedBackend([describeImage('a red fox')]);
    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      llmBackend: backend,
      tools: new Map(),
    });
    const loaded = await repl.session.loadCode(HARNESS);
    expect(loaded.error).toBeUndefined();

    const events = await collect(repl.query('run'));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.find((event) => event.type === 'answer')?.content).toBe('a red fox');

    // The model request carried the image bytes on the user message.
    const mediaMessage = backend.requests[0]?.messages.find((message) => message.media?.length);
    expect(mediaMessage?.media?.[0]).toEqual({
      mimeType: 'image/png',
      data: PNG.toString('base64'),
    });
  });

  it('keeps the reference through the agent loop round-trip', async () => {
    const backend = new CannedBackend([describeImage('a red fox')]);
    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      llmBackend: backend,
      tools: new Map(),
    });
    await repl.session.loadCode(HARNESS);

    const events = await collect(repl.query('round_trip'));
    const outputs = events.filter((event) => event.type === 'output').map((event) => event.content);
    // The media reference is present before and survives the task's write-back
    // (the bytes are never stored).
    expect(outputs).toContain('before_has_media');
    expect(outputs).toContain('after_has_media');
  });
});
