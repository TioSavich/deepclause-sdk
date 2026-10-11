/**
 * M5 — default capability host toolset (bash) and file-predicate independence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { buildToolCatalog, createReplToolset, type ReplToolset } from '../src/repl/toolset.js';
import { createHarnessRepl, type HarnessRepl } from '../src/repl/index.js';
import { createReplRuntime } from '../src/cli/repl.js';
import type { DMLEvent } from '../src/types.js';

let workspace: string;
let toolset: ReplToolset | null = null;
let repl: HarnessRepl | null = null;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-bash-'));
});

afterEach(async () => {
  await toolset?.dispose();
  toolset = null;
  await repl?.dispose();
  repl = null;
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('capability toolset', () => {
  it('registers bash by default and advertises it in the catalog', async () => {
    toolset = await createReplToolset({ workspacePath: workspace });
    expect([...toolset.tools.keys()]).toEqual(['bash']);
    expect(toolset.catalog).toContain('bash');
    expect(toolset.catalog).toContain('file I/O');
  });

  it('registers no capability tools with --no-tools', async () => {
    toolset = await createReplToolset({ workspacePath: workspace, toolNames: null });
    expect(toolset.tools.size).toBe(0);
    expect(toolset.catalog).toContain('No capability host tools');
  });

  it('registers bash by default through the CLI runtime (no config)', async () => {
    const runtime = await createReplRuntime({ workspace, backend: 'env' });
    try {
      expect(runtime.toolset.tools.has('bash')).toBe(true);
      expect(runtime.toolset.catalog).toContain('bash');
    } finally {
      await runtime.repl.dispose();
      await runtime.toolset.dispose();
    }
  });

  it('executes a command through the shell manager', async () => {
    toolset = await createReplToolset({ workspacePath: workspace });
    const result = await toolset.tools.get('bash')!.execute({ command: 'printf "hello-from-bash"' }) as {
      success: boolean;
      stdout: string;
      exitCode: number;
      timeMs: number;
    };
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('hello-from-bash');
    expect(result.timeMs).toBeGreaterThanOrEqual(0);
  });

  it('honors a per-command timeoutMs and reports the elapsed time', async () => {
    toolset = await createReplToolset({ workspacePath: workspace });
    const started = Date.now();
    const result = await toolset.tools.get('bash')!.execute({ command: 'sleep 5', timeoutMs: 300 }) as {
      success: boolean;
      exitCode: number;
      timeMs: number;
      summary: string;
    };
    expect(result.exitCode).toBe(124);
    expect(result.summary).toContain('timed out after 300ms');
    expect(result.timeMs).toBeGreaterThanOrEqual(250);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15000);

  it('buildToolCatalog describes each tool and its parameters', () => {
    const catalog = buildToolCatalog(new Map([['bash', {
      description: 'Run a shell command.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: async () => ({}),
    }]]));
    expect(catalog).toContain('bash: Run a shell command.');
    expect(catalog).toContain('parameters: command');
  });
});

describe('file predicates are language, not host tools', () => {
  it('keeps write_file/read_file available with no capability tools', async () => {
    repl = await createHarnessRepl({
      workspacePath: workspace,
      model: 'test-model',
      provider: 'openai',
      tools: new Map(),
      hostToolsCatalog: 'No capability host tools are registered.',
    });

    const events: DMLEvent[] = [];
    for await (const event of repl.query('write_file("note.txt", "from-the-mi"), read_file("note.txt", Content)')) {
      events.push(event);
    }
    const solution = events.find((event) => event.type === 'solution');
    expect(solution?.solution?.bindings).toEqual([{ name: 'Content', value: '"from-the-mi"' }]);
    expect(await fs.readFile(path.join(workspace, 'note.txt'), 'utf8')).toBe('from-the-mi');
  });
});
