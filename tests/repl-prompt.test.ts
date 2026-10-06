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
      { name: 'set_result', arguments: { variable: 'Answer', value: '' } },
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

  it('includes the bundled DML reference and guard rails in the meta prompt', async () => {
    backend = new CannedBackend([finalResponse('kept(1).', '')]);
    repl = await openRepl();
    await collect(repl.prompt('build something'));

    const promptText = backend.calls[0].messages.map((message) => message.content).join('\n');
    expect(promptText).toContain('DML LANGUAGE REFERENCE');
    expect(promptText).toContain('# DML Language Reference');
    expect(promptText).toContain('IDIOMATIC HARNESS PATTERNS');
    expect(promptText).toContain('tool(run_python(Script, Output)');
    expect(promptText).toContain('script_body(word_count');
    expect(promptText).toContain('BOUNDED ITERATION');
    expect(promptText).toContain('CLAUSE ORDER MATTERS');
  });

  it('keeps meta memory clean: raw request/outcome pairs, not the assembled prompt', async () => {
    backend = new CannedBackend([finalResponse('p1(1).', ''), finalResponse('p2(1).', '')]);
    repl = await openRepl();
    await collect(repl.prompt('first request alpha'));
    await collect(repl.prompt('second request beta'));

    const secondCall = backend.calls[backend.calls.length - 1];
    const promptPrefixed = secondCall.messages.filter((message) => message.content.startsWith('Subtask:'));
    // Only the current turn's assembled prompt may appear; it is ephemeral.
    expect(promptPrefixed).toHaveLength(1);

    // Exclude the system prompt (it embeds the current turn's task text) and the
    // current `Subtask:` message; the remainder is the persisted meta memory.
    const persisted = secondCall.messages
      .filter((message) => message.role !== 'system' && !message.content.startsWith('Subtask:'))
      .map((message) => message.content)
      .join('\n');
    expect(persisted).not.toContain('You are the DeepClause REPL harness author');
    expect(persisted).toContain('first request alpha');
    expect(persisted).toContain('committed p1/1');
  });

  it('keeps the turn alive when an execute child goal fails', async () => {
    backend = new CannedBackend([{
      text: '',
      toolCalls: [
        { name: 'execute', arguments: { goal: 'no_such_predicate(1)' } },
        { name: 'set_result', arguments: { variable: 'DMLCode', value: 'kept(1).' } },
        { name: 'set_result', arguments: { variable: 'EntryGoal', value: '' } },
        { name: 'set_result', arguments: { variable: 'Answer', value: '' } },
        { name: 'finish', arguments: { success: true } },
      ],
    }]);
    repl = await openRepl();

    const events = await collect(repl.prompt('explore with a failing execute'));
    // The nested error is surfaced for rendering, but the turn still commits.
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(values(await collect(repl.query('kept(X)')), 'X')).toEqual(['1']);
  });

  it('assert_many keeps clause order so recursion terminates', async () => {
    backend = new CannedBackend([{
      text: '',
      toolCalls: [
        {
          name: 'assert_many',
          arguments: {
            clauses: 'fact(0, 1).\nfact(N, F) :- N > 0, N1 is N - 1, fact(N1, F1), F is N * F1.',
          },
        },
        { name: 'execute', arguments: { goal: 'fact(5, F)' } },
        { name: 'set_result', arguments: { variable: 'DMLCode', value: 'kept(1).' } },
        { name: 'set_result', arguments: { variable: 'EntryGoal', value: '' } },
        { name: 'set_result', arguments: { variable: 'Answer', value: '' } },
        { name: 'finish', arguments: { success: true } },
      ],
    }]);
    repl = await openRepl();

    const events = await collect(repl.prompt('define fact with assert_many'));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.some((event) => (
      event.type === 'tool_call'
      && event.toolName === 'execute'
      && event.toolState === 'completed'
      && event.toolSummary?.includes('solution')
    ))).toBe(true);
  });

  it('answers a simple question directly without changing the harness', async () => {
    backend = new CannedBackend([{
      text: 'Answering directly.',
      toolCalls: [
        { name: 'set_result', arguments: { variable: 'DMLCode', value: '' } },
        { name: 'set_result', arguments: { variable: 'EntryGoal', value: '' } },
        { name: 'set_result', arguments: { variable: 'Answer', value: 'We added a factorial rule.' } },
        { name: 'finish', arguments: { success: true } },
      ],
    }]);
    repl = await openRepl();
    await repl.session.loadCode('existing(1).\n');
    const before = await repl.list('all');

    const events = await collect(repl.prompt('what did we just do?'));
    expect(events.some((event) => event.type === 'output' && event.content === 'We added a factorial rule.')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(await repl.list('all')).toBe(before);
  });

  it('saves the current harness to a temp file when a turn is aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    backend = new CannedBackend(() => {
      calls += 1;
      if (calls === 1) {
        return { text: '', toolCalls: [{ name: 'assert', arguments: { clause: 'scratch_from_abort(1).' } }] };
      }
      controller.abort(new Error('cancelled by user'));
      return finalResponse('kept(1).', '');
    });
    repl = await openRepl();

    const events = await collect(repl.prompt('abort me', { signal: controller.signal }));
    const abortEvent = events.find((event) => event.type === 'error' && event.content?.includes('saved to'));
    expect(abortEvent).toBeDefined();

    // The scratch assert is discarded from the session...
    const scratch = await collect(repl.query('scratch_from_abort(_)'));
    expect(scratch.some((event) => event.type === 'solution')).toBe(false);

    // ...but preserved in the temp file.
    const savedPath = abortEvent!.content!.match(/saved to (.+)$/)?.[1]?.trim();
    expect(savedPath).toBeTruthy();
    const text = await fs.readFile(savedPath!, 'utf8');
    expect(text).toContain('scratch_from_abort');
    await fs.rm(savedPath!, { force: true });
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
      { name: 'set_result', arguments: { variable: 'Answer', value: '' } },
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
