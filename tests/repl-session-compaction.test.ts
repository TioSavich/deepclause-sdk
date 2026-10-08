/**
 * Session + loop compaction wired into the REPL (TypeScript, ported from pi).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createHarnessRepl, type HarnessRepl } from '../src/repl/index.js';
import type { DMLEvent, LLMBackend, LLMBackendRequest, LLMBackendResponse } from '../src/types.js';

interface CannedResponse {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/** A direct agent answer (no harness edit). */
function answeredResponse(answer: string): CannedResponse {
  return { text: answer };
}

class CannedBackend implements LLMBackend {
  readonly calls: LLMBackendRequest[] = [];
  constructor(
    private readonly handler: (request: LLMBackendRequest, index: number) => { text?: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; finishReason?: 'stop' },
  ) {}
  async complete(request: LLMBackendRequest): Promise<LLMBackendResponse> {
    this.calls.push(request);
    const index = this.calls.length - 1;
    const response = this.handler(request, index);
    return {
      text: response.text ?? '',
      toolCalls: (response.toolCalls ?? []).map((call, callIndex) => ({
        id: `${index}-${callIndex}`,
        name: call.name,
        arguments: call.arguments,
      })),
      finishReason: response.finishReason ?? 'stop',
    };
  }
}

async function collect(gen: AsyncGenerator<DMLEvent>): Promise<DMLEvent[]> {
  const events: DMLEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

let workspace: string;
let repl: HarnessRepl | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-compaction-'));
});

afterEach(async () => {
  await repl?.dispose();
  repl = undefined;
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('REPL session compaction', () => {
  it('compacts meta memory on demand and reports the reduction', async () => {
    const long = 'x'.repeat(600);
    const backend = new CannedBackend((request) => {
      const system = request.messages[0]?.content ?? '';
      if (system.includes('summarization assistant')) {
        return { text: '## Goal\nKeep the harness authoring context small.', toolCalls: [] };
      }
      return answeredResponse(`ok-${request.messages.length}`);
    });

    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      streaming: true,
      llmBackend: backend,
      compaction: {
        settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
        auto: false,
      },
    });

    await collect(repl.prompt(`${long} first`));
    await collect(repl.prompt(`${long} second`));

    const result = await repl.compact();
    expect(result.applied).toBe(true);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(result.error).toBeUndefined();
  });

  it('emits a memory_compaction event before an auto-compacted turn', async () => {
    const long = 'y'.repeat(600);
    const backend = new CannedBackend((request) => {
      const system = request.messages[0]?.content ?? '';
      if (system.includes('summarization assistant')) {
        return { text: '## Goal\nSummarized.', toolCalls: [] };
      }
      return answeredResponse('ok');
    });

    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      streaming: true,
      llmBackend: backend,
      compaction: {
        settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
        auto: true,
      },
      contextWindow: 10,
    });

    await collect(repl.prompt(`${long} first`));
    await collect(repl.prompt(`${long} second`));
    const events = await collect(repl.prompt(`${long} third`));
    expect(events.some((event) => event.type === 'memory_compaction' && event.compactionAction === 'applied')).toBe(true);
  });

  it('is a no-op when compaction is disabled', async () => {
    const backend = new CannedBackend(() => answeredResponse('ok'));
    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      streaming: true,
      llmBackend: backend,
    });
    const result = await repl.compact();
    expect(result.applied).toBe(false);
    expect(result.error).toContain('disabled');
  });
});
