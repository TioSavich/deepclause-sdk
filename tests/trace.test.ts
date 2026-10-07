/**
 * Execution trace: with trace mode enabled the engine attaches the trace to the
 * `finished` event (which `deepclause run --trace <file>` writes to disk).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { DMLSession } from '../src/repl/session.js';
import type { DMLEvent, LLMBackend, LLMBackendRequest, LLMBackendResponse } from '../src/types.js';

class NoopBackend implements LLMBackend {
  async complete(_request: LLMBackendRequest): Promise<LLMBackendResponse> {
    return { text: '' };
  }
}

let workspace: string;
let session: DMLSession | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-trace-'));
});

afterEach(async () => {
  await session?.dispose();
  session = undefined;
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('execution trace', () => {
  it('attaches a trace to the finished event when trace mode is enabled', async () => {
    session = await DMLSession.open({
      workspacePath: workspace,
      trace: true,
      tools: new Map(),
      runnerOptions: {
        model: 'test-model',
        provider: 'openai',
        streaming: false,
        trace: true,
        llmBackend: new NoopBackend(),
      },
    });
    const loaded = await session.loadCode('agent_main :- answer("done").');
    expect(loaded.error).toBeUndefined();

    const events: DMLEvent[] = [];
    for await (const event of session.query('agent_main')) {
      events.push(event);
    }
    const finished = events.find((event) => event.type === 'finished');
    expect(Array.isArray(finished?.trace)).toBe(true);
    expect((finished?.trace ?? []).length).toBeGreaterThan(0);
  });

  it('omits the trace when trace mode is off', async () => {
    session = await DMLSession.open({
      workspacePath: workspace,
      tools: new Map(),
      runnerOptions: { model: 'test-model', provider: 'openai', streaming: false, llmBackend: new NoopBackend() },
    });
    await session.loadCode('agent_main :- answer("done").');
    const events: DMLEvent[] = [];
    for await (const event of session.query('agent_main')) {
      events.push(event);
    }
    const finished = events.find((event) => event.type === 'finished');
    expect(finished?.trace).toBeUndefined();
  });
});
