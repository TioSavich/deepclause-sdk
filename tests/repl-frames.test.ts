/**
 * M0 — frame-aware, reentrant runner.
 *
 * Covers:
 *  - `runDML` event regression after the frame refactor.
 *  - The Prolog frame predicates (create_frame/6, step_frame/4, frame_info/4,
 *    end_frame/1, default_frame/2) and legacy step_engine/4 delegation.
 *  - A synthetic nested frame: step A, create B from inside A's step handling,
 *    step B to completion, resume A; no slot/engine cross-talk.
 *  - The runner's `createNestedFrame` / `runFrame` / `endFrame` surface.
 */
import { describe, expect, it } from 'vitest';

import { createDeepClause } from '../src/index.js';
import { DMLRunner } from '../src/runner.js';
import { loadProlog, type SWIPLModule } from '../src/prolog/loader.js';

const EMPTY_STATE = 'state{memory: [], params: params{}, context_stack: [], depth: 0}';

let sessionCounter = 0;
function freshSession(prefix: string): string {
  sessionCounter += 1;
  return `${prefix}_${Date.now()}_${sessionCounter}`;
}

/** Unwrap a swipl-wasm value into a plain JS value for assertions. */
function plain(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const tagged = value as { $t?: string; v?: unknown };
    if (tagged.$t) return tagged.v;
  }
  return value;
}

interface StepResult {
  status: string;
  content?: unknown;
  payload?: unknown;
}

let swipl: SWIPLModule | null = null;

async function getSwipl(): Promise<SWIPLModule> {
  if (!swipl) swipl = await loadProlog();
  return swipl;
}

async function defineProgram(module: SWIPLModule, session: string, code: string): Promise<void> {
  const path = `/tmp/${session}.dml`;
  module.FS.writeFile(path, code);
  const result = module.prolog.query(
    `deepclause_mi:parse_dml('${path}', '${session}', 'mem', params{}, Error)`
  ).once() as Record<string, unknown> | null;
  expect(String(plain(result?.Error))).toBe('none');
}

function stepFrame(module: SWIPLModule, frameId: string): StepResult {
  const result = module.prolog.query(
    `deepclause_mi:step_frame('${frameId}', Status, Content, Payload)`
  ).once() as Record<string, unknown> | null;
  return {
    status: String(plain(result?.Status)),
    content: plain(result?.Content),
    payload: plain(result?.Payload),
  };
}

function createFrame(
  module: SWIPLModule,
  session: string,
  kind: string,
  depth: number,
  goal: string,
): string {
  const result = module.prolog.query(
    `deepclause_mi:create_frame('${session}', ${kind}, ${depth}, ${goal}, ${EMPTY_STATE}, FrameId)`
  ).once() as Record<string, unknown> | null;
  expect(result?.FrameId, 'create_frame/6 should bind a FrameId').toBeTruthy();
  return String(plain(result?.FrameId));
}

describe('runDML regression after the frame refactor', () => {
  it('preserves the seeded output/answer/finished event sequence', async () => {
    const sdk = await createDeepClause({ model: 'test-model' });
    try {
      const events = [];
      for await (const event of sdk.runDML(`
        agent_main :-
          output("hello"),
          user("world"),
          answer("done").
      `)) {
        events.push(event);
      }

      expect(events.map((event) => event.type)).toEqual(['output', 'answer', 'finished']);
      expect(events[0]?.content).toBe('hello');
      expect(events[1]?.content).toBe('done');
    } finally {
      await sdk.dispose();
    }
  });

  it('delegates legacy step_engine/4 to the default query frame', async () => {
    const module = await getSwipl();
    const session = freshSession('sess_legacy');
    await defineProgram(module, session, 'agent_main :- output("legacy"), answer("ok").\n');

    const created = module.prolog.query(
      `deepclause_mi:create_engine('${session}', 'mem', [], params{}, [], Engine), deepclause_mi:default_frame('${session}', FrameId)`
    ).once() as Record<string, unknown> | null;
    const frameId = String(plain(created?.FrameId));
    expect(frameId).toBeTruthy();

    const info = module.prolog.query(
      `deepclause_mi:frame_info('${frameId}', Session, Kind, Depth)`
    ).once() as Record<string, unknown> | null;
    expect(String(plain(info?.Session))).toBe(session);
    expect(String(plain(info?.Kind))).toBe('query');

    const first = module.prolog.query(
      `deepclause_mi:step_engine('${session}', Status, Content, Payload)`
    ).once() as Record<string, unknown> | null;
    expect(String(plain(first?.Status))).toBe('output');
    expect(String(plain(first?.Content))).toBe('legacy');

    const second = module.prolog.query(
      `deepclause_mi:step_engine('${session}', Status, Content, Payload)`
    ).once() as Record<string, unknown> | null;
    expect(String(plain(second?.Status))).toBe('answer');

    module.prolog.query(`deepclause_mi:destroy_engine('${session}')`).once();
    const afterDestroy = module.prolog.query(
      `deepclause_mi:step_engine('${session}', Status, Content, Payload)`
    ).once() as Record<string, unknown> | null;
    expect(String(plain(afterDestroy?.Status))).toBe('error');
  });
});

describe('nested frames (Prolog layer)', () => {
  it('runs a child frame to completion and resumes the parent without cross-talk', async () => {
    const module = await getSwipl();
    const session = freshSession('sess_nested');
    await defineProgram(
      module,
      session,
      [
        'frame_a :- output("a_first"), output("a_second").',
        'frame_b :- output("b_first"), output("b_done").',
      ].join('\n') + '\n',
    );

    // Frame A: the parent that yields once and is then suspended.
    const frameA = createFrame(module, session, 'nested', 0, `${session}:frame_a`);

    // Step A once: it yields a_first and is now suspended mid-body.
    const a1 = stepFrame(module, frameA);
    expect(a1.status).toBe('output');
    expect(a1.content).toBe('a_first');

    // "Inside A's step handling": create frame B and run it to completion.
    const frameB = createFrame(module, session, 'object', 1, `${session}:frame_b`);
    const bOutputs: unknown[] = [];
    let bFinished = false;
    for (let i = 0; i < 5 && !bFinished; i += 1) {
      const step = stepFrame(module, frameB);
      if (step.status === 'finished') {
        bFinished = true;
      } else if (step.status === 'output' && typeof step.content === 'string') {
        bOutputs.push(step.content);
      }
    }
    expect(bOutputs).toEqual(['b_first', 'b_done']);
    expect(bFinished).toBe(true);

    // Resume A: its own engine is untouched, so it yields a_second then finishes.
    const a2 = stepFrame(module, frameA);
    expect(a2.status).toBe('output');
    expect(a2.content).toBe('a_second');

    let aFinished = false;
    for (let i = 0; i < 5 && !aFinished; i += 1) {
      const step = stepFrame(module, frameA);
      if (step.status === 'finished') aFinished = true;
    }
    expect(aFinished).toBe(true);

    // Both frames are still registered and end_frame/1 unregisters each.
    const infoB = module.prolog.query(
      `deepclause_mi:frame_info('${frameB}', Session, Kind, Depth)`
    ).once() as Record<string, unknown> | null;
    expect(String(plain(infoB?.Kind))).toBe('object');
    expect(Number(plain(infoB?.Depth))).toBe(1);

    module.prolog.query(`deepclause_mi:end_frame('${frameA}')`).once();
    module.prolog.query(`deepclause_mi:end_frame('${frameB}')`).once();
    const gone = module.prolog.query(
      `deepclause_mi:frame_info('${frameA}', Session, Kind, Depth)`
    ).once() as Record<string, unknown> | null;
    expect(gone?.Session).toBeUndefined();

    module.prolog.query(`deepclause_mi:destroy_engine('${session}')`).once();
  });
});

describe('runner frame API', () => {
  it('createNestedFrame + runFrame drive a non-LLM frame to completion', async () => {
    const module = await getSwipl();
    const session = freshSession('sess_runner');
    await defineProgram(module, session, 'frame_c :- output("c_first"), output("c_second").\n');

    const runner = new DMLRunner(module, {
      model: 'test-model',
      provider: 'openai',
      temperature: 0,
      maxTokens: 1024,
    });
    // Point the runner at the session we set up (the REPL/M1 session layer will
    // own this lifecycle; for M0 the test wires it directly).
    (runner as unknown as { sessionId: string }).sessionId = session;

    const frame = runner.createNestedFrame({
      kind: 'nested',
      goalTerm: `${session}:frame_c`,
      depth: 1,
    });
    expect(frame).not.toBeNull();

    const events = [];
    for await (const event of runner.runFrame(frame!.id, {
      tools: new Map(),
      toolPolicy: null,
      onInputRequired: async () => '',
    })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === 'output').map((event) => event.content))
      .toEqual(['c_first', 'c_second']);
    expect(events.at(-1)?.type).toBe('finished');

    runner.endFrame(frame!.id);
    const unknown = [];
    for await (const event of runner.runFrame(frame!.id, {
      tools: new Map(),
      toolPolicy: null,
      onInputRequired: async () => '',
    })) {
      unknown.push(event);
    }
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.type).toBe('error');
  });
});
