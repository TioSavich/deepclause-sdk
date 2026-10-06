/**
 * M3 — prompt mode: English -> meta task -> DML -> commit -> entry run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { createHarnessRepl, type HarnessRepl } from '../src/repl/index.js';
import type {
  DMLEvent,
  LLMBackend,
  LLMBackendRequest,
  LLMBackendResponse,
} from '../src/types.js';

interface CannedResponse {
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

class CannedBackend implements LLMBackend {
  readonly calls: LLMBackendRequest[] = [];

  constructor(private readonly script: CannedResponse[] | ((request: LLMBackendRequest, index: number) => CannedResponse)) {}

  async complete(request: LLMBackendRequest): Promise<LLMBackendResponse> {
    this.calls.push(request);
    const index = this.calls.length - 1;
    const response = typeof this.script === 'function'
      ? this.script(request, index)
      : this.script[Math.min(index, this.script.length - 1)];
    if (response.reasoning) request.onReasoning?.(response.reasoning);
    if (response.text) request.onText?.(response.text);
    return {
      text: response.text ?? '',
      reasoning: response.reasoning,
      toolCalls: (response.toolCalls ?? []).map((call, callIndex) => ({
        id: `${index}-${callIndex}`,
        name: call.name,
        arguments: call.arguments,
      })),
    };
  }
}

function finalResponse(code: string, entry = ''): CannedResponse {
  return {
    text: 'Here is the harness.',
    toolCalls: [
      { name: 'set_result', arguments: { variable: 'DMLCode', value: code } },
      { name: 'set_result', arguments: { variable: 'EntryGoal', value: entry } },
      { name: 'finish', arguments: { success: true } },
    ],
  };
}

let workspace: string;
let repl: HarnessRepl;
let backend: CannedBackend;

async function openRepl(): Promise<HarnessRepl> {
  return createHarnessRepl({
    workspacePath: workspace,
    model: 'test-model',
    provider: 'openai',
    streaming: true,
    llmBackend: backend,
  });
}

async function collect(gen: AsyncGenerator<DMLEvent>): Promise<DMLEvent[]> {
  const events: DMLEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function values(events: DMLEvent[], name: string): string[] {
  return events
    .filter((event) => event.type === 'solution')
    .map((event) => event.solution?.bindings.find((binding) => binding.name === name)?.value ?? '');
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'deepclause-repl-prompt-'));
});

afterEach(async () => {
  await repl?.dispose();
  await fs.rm(workspace, { recursive: true, force: true });
});

const FACTORIAL = [
  'fact(0, 1).',
  'fact(N, F) :- N > 0, N1 is N - 1, fact(N1, F1), F is N * F1.',
  'repl_entry(demo).',
  'demo :- fact(5, F), output(F).',
].join('\n');

describe('prompt mode', () => {
  it('commits generated DML and runs the declared entry', async () => {
    backend = new CannedBackend([finalResponse(FACTORIAL, 'demo')]);
    repl = await openRepl();

    const events = await collect(repl.prompt('add a factorial rule'));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.filter((event) => event.type === 'output').map((event) => event.content)).toContain('120');

    const after = await collect(repl.query('fact(5, F)'));
    expect(values(after, 'F')).toEqual(['120']);
  });

  it('does not synthesize agent_main', async () => {
    backend = new CannedBackend([finalResponse(FACTORIAL, 'demo')]);
    repl = await openRepl();
    await collect(repl.prompt('add a factorial rule'));

    const listing = await repl.list('all');
    expect(listing).not.toContain('agent_main');
    expect(listing).toContain('repl_entry(demo)');
  });

  it('replaces by predicate on redefinition', async () => {
    const first = [
      'fact(0, 1).',
      'fact(N, F) :- N > 0, N1 is N - 1, fact(N1, F1), F is N * F1.',
    ].join('\n');
    const second = 'fact(0, 1).';
    backend = new CannedBackend([finalResponse(first), finalResponse(second)]);
    repl = await openRepl();

    await collect(repl.prompt('primeira'));
    await collect(repl.prompt('segunda'));

    const clauses = await collect(repl.query('findall(N, fact(N, _), L)'));
    // Exactly one clause remains, so the clause list has one element.
    expect(clauses.filter((event) => event.type === 'solution').length).toBe(1);
    const listing = await repl.list('fact/2');
    expect(listing.match(/fact\(/g)?.length).toBe(1);
  });

  it('removes a predicate via repl_delete', async () => {
    backend = new CannedBackend([
      finalResponse('temp(1).\nkeep(2).'),
      finalResponse('repl_delete(temp/1).'),
    ]);
    repl = await openRepl();

    await collect(repl.prompt('add temp and keep'));
    expect(values(await collect(repl.query('temp(X)')), 'X')).toEqual(['1']);

    await collect(repl.prompt('remove temp'));
    const removed = await collect(repl.query('temp(X)'));
    expect(removed.some((event) => event.type === 'solution')).toBe(false);
    expect(values(await collect(repl.query('keep(X)')), 'X')).toEqual(['2']);
  });

  it('repairs once after invalid DML then commits', async () => {
    backend = new CannedBackend([
      finalResponse('fact(0, 1) :- .'),
      finalResponse('fixed(1).'),
    ]);
    repl = await openRepl();

    const events = await collect(repl.prompt('write something'));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(values(await collect(repl.query('fixed(X)')), 'X')).toEqual(['1']);
    expect(backend.calls).toHaveLength(2);
  });

  it('leaves the harness untouched when both attempts are invalid', async () => {
    backend = new CannedBackend([finalResponse('fact(0, 1) :- .')]);
    repl = await openRepl();
    await repl.session.loadCode('existing(1).\n');
    const before = await repl.list('all');

    const events = await collect(repl.prompt('write broken code'));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(await repl.list('all')).toBe(before);
    expect(values(await collect(repl.query('existing(X)')), 'X')).toEqual(['1']);
  });

  it('discards scratch asserts and retracts from the committed module', async () => {
    backend = new CannedBackend([{
      text: '',
      toolCalls: [
        { name: 'assert', arguments: { clause: 'scratch(1).' } },
        { name: 'execute', arguments: { goal: 'scratch(X)' } },
        { name: 'set_result', arguments: { variable: 'DMLCode', value: 'kept(1).' } },
        { name: 'set_result', arguments: { variable: 'EntryGoal', value: '' } },
        { name: 'finish', arguments: { success: true } },
      ],
    }]);
    repl = await openRepl();

    const events = await collect(repl.prompt('add kept but only test scratch'));
    expect(events.some((event) => event.type === 'error')).toBe(false);

    const scratch = await collect(repl.query('scratch(X)'));
    expect(scratch.some((event) => event.type === 'solution')).toBe(false);
    expect(values(await collect(repl.query('kept(X)')), 'X')).toEqual(['1']);
  });
});
