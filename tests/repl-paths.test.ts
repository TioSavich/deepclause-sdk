/**
 * Workspace-relative paths: DML file predicates resolve against the workspace,
 * so `size_file`/`time_file` (plain SWI builtins, wrapped by the MI) accept a
 * relative path too, and traversal is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createHarnessRepl, type HarnessRepl } from '../src/repl/index.js';
import type { DMLEvent, LLMBackend, LLMBackendRequest, LLMBackendResponse } from '../src/types.js';

class NoopBackend implements LLMBackend {
  async complete(_request: LLMBackendRequest): Promise<LLMBackendResponse> {
    return { text: '' };
  }
}

async function collect(gen: AsyncGenerator<DMLEvent>): Promise<DMLEvent[]> {
  const events: DMLEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function outputs(events: DMLEvent[]): string[] {
  return events.filter((event) => event.type === 'output').map((event) => event.content);
}

let workspace: string;
let repl: HarnessRepl | undefined;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-paths-'));
});

afterEach(async () => {
  await repl?.dispose();
  repl = undefined;
  await fs.rm(workspace, { recursive: true, force: true });
});

async function openRepl(): Promise<HarnessRepl> {
  return createHarnessRepl({
    workspacePath: workspace,
    model: 'test-model',
    provider: 'openai',
    llmBackend: new NoopBackend(),
    tools: new Map(),
  });
}

describe('workspace-relative paths', () => {
  it('resolves size_file/time_file against the workspace without a /workspace prefix', async () => {
    await fs.writeFile(path.join(workspace, 'data.bin'), 'hello');
    repl = await openRepl();

    const events = await collect(repl.query(
      'size_file("data.bin", S), time_file("data.bin", T), output(S), '
        + '( T > 0 -> output(recent) ; output(stale) )',
    ));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const out = outputs(events);
    expect(out).toContain('5');
    expect(out).toContain('recent');
  });

  it('refuses traversal outside the workspace', async () => {
    repl = await openRepl();
    const events = await collect(repl.query('size_file("../outside.bin", S), output(S)'));
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });
});
