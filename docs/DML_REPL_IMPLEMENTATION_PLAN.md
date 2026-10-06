# DML REPL — Implementation Plan

> **Canonical design:** [`docs/DML_REPL_PROPOSAL.md`](./DML_REPL_PROPOSAL.md)
> Read that document first; this plan only sequences the work, names the files,
> and defines the acceptance tests. Section references below (`§n`) point at
> the proposal.

## 0. What we are building (one paragraph)

A first-class SDK CLI tool, `deepclause repl [-g goal] [-l file] [-f]`, that
starts with a blank in-memory DML module and lets a user grow a *living harness*.
Two input modes: `goal: <dml>.` runs a DML goal directly; anything else is
plain English that the model compiles through a `task_named/3` meta frame into
DML, which is committed to the module (replace-by-predicate) and run. `export`
serializes the harness to a self-contained `.dml` (embedded scripts as facts);
`freeze` locks the module read-only. A dedicated `bash` host tool and an
`ask_user`/`input` channel are available; the meta task is restricted to
`listing`, `assert`, `retract`, `execute`, `ask_user`.

## 1. How to start in a fresh session

Paste this into the first message of a new session:

```text
Read deepclause-sdk/docs/DML_REPL_PROPOSAL.md and
deepclause-sdk/docs/DML_REPL_IMPLEMENTATION_PLAN.md in full.

We are implementing the DML REPL in deepclause-sdk.
Start at the current milestone in the plan (see the Progress table).
Follow the plan's tasks in order, keep `npm run build` and `npm test` green,
and do not start a milestone until the previous one's acceptance tests pass.
Do not invoke the compiler or create `.deepclause/` around the REPL harness.
```

Repo and commands:

```bash
cd deepclause-sdk
npm install
npm run build          # tsc + copies prolog-src and assets
npm test               # vitest run
npm run cli -- repl    # tsx src/cli/index.ts repl  (dev entry)
```

Working branch: `feat/dml-repl` (one branch for the whole feature is fine; use
the milestone id in commit messages, e.g. `repl(M1): session + goal mode`).

## 2. Invariants (do not break)

These are the load-bearing decisions from the proposal. A change here is a
design change and must update the proposal + this plan.

1. `runDML` behavior is byte-for-byte unchanged after the frame refactor (§8).
2. No Markdown→DML compiler is invoked; the REPL loads/validates DML directly.
3. The REPL writes only to user-named files (`export`) and its SDK config
   (`.deepclause/config.json`); it never creates pi's `.pi/deepclause/`.
4. Default capability host tool is exactly `bash`; DML file I/O is the MI
   predicates (`open/3`, `write/2`, `write_file/2`, …); `ask_user` is the
   separate, always-on input channel.
5. The meta frame's agent tool set is exactly `listing`, `assert`, `retract`,
   `execute`, `ask_user` — harness tools are hidden from it (§9.2).
6. `freeze` is an in-memory read-only lock, not a sandbox and not a serializer
   (§12.1).
7. The harness declares entries with `repl_entry/1` (or an `EntryGoal` output);
   there is **no** implicit `agent_main` fallback (§9.3, §9.5).
8. Top-level classifier: `goal:` prefix → goal mode; everything else → English
   prompt mode; out-of-band REPL commands are matched first (§9.1).
9. `task` output streams live: assistant text, reasoning (new `reasoning`
   event), and tool calls rendered in place; the prompt is suspended while
   streaming and `plain` mode is used when stdout is not a TTY (§15).
10. Commit is **replace-by-predicate**: retractall the returned predicates, then
    load the returned source; removals use a `repl_delete/1` directive (§7.3,
    §9.5).
11. Meta tools are serialized; child frames run to completion before the meta
    frame resumes (no concurrent `execute`) (§10.3, §20 #9).

## 3. Progress table

Update the `Status` column as work lands. One milestone at a time.

| Milestone | Scope | Proposal | Status |
|---|---|---|---|
| **M0** | Frame-aware, reentrant runner | §8 | ✅ |
| **M1** | Session, goal mode, `goal:` classifier, CLI skeleton | §7, §9.1, §11, §13.1–13.3 | ✅ |
| **M2** | `freeze` lock + `export`/`-l` | §12 | ☐ |
| **M3** | Prompt mode (meta frame, meta tools, commit/run) + streaming | §9.2–9.6, §10, §15 | ☐ |
| **M4** | Context, scratch memory, `execute`, recursion budgets | §7.2, §10 | ☐ |
| **M5** | Backends + host tools (`set-backend pi`, `bash`) | §13.5, §14.4, §14.5 | ☐ |
| **M6** | `ask_user` at both levels + non-interactive policy | §9.4, §13.6 | ☐ |
| **M7** | Polish, docs, optional pi embedding | §14.3, §17, §18 | ☐ |

---

## M0 — Frame-aware, reentrant runner

**Goal.** Generalize the single-engine step loop in `runner.ts` into a
reentrant frame stack, with zero behavior change for `runDML`.

**Proposal refs.** §8, §14.1, §20 #17.

**Deliverables.**

* `src/runner.ts`: extract the `while(true)` switch from `run()` into
  `private async *stepLoop(frame, options)`. Introduce a `Frame` record
  `{ id, kind, depth }` and a runner-owned `Map<FrameId, engine>`. `run()`
  registers one `query` frame and delegates.
* `src/prolog-src/deepclause_mi.pl`: add
  `session_frame/4`, `session_frame_engine/2`, `step_frame/4`, `end_frame/1`,
  `frame_info/4`; keep `step_engine/4` as a thin wrapper over the default
  frame so existing code paths keep working.
* `src/types.ts`: add `FrameKind = 'query' | 'meta' | 'nested' | 'object'`.

**Tasks.**

1. Add the Prolog frame predicates; make `step_engine/4` resolve the default
   `query` frame for the session and delegate to `step_frame/4`.
2. In `runner.ts`, replace `this.engine` usage with the frame map; keep
   `this.sessionId` for compatibility.
3. Extract `stepLoop`; `run()` becomes setup + `yield* this.stepLoop(...)` +
   `cleanup()`.
4. Add `runFrame(frameId, options)` that steps a specific frame (used later by
   `execute`).
5. Make result/signal slots frame-aware enough for nesting: either key
   `session_agent_result/2` etc. by frame, or add a guard that asserts nesting
   is strictly depth-first (§8). Document the chosen approach in the code.

**Tests.** `tests/repl-frames.test.ts`

* Full existing suite green (`npm test`).
* `runDML` output/events unchanged for the seeded example (snapshot test).
* A synthetic nested frame (no LLM): create frame A, create frame B from
  inside A's step handling, step B to completion, resume A; assert both
  produce correct results and no slot cross-talk.

**Acceptance.** `runDML` regression suite passes; frame predicates exist and
are exercised by a test; no behavior change in CLI `run`.

**Risks.** This touches the hottest code path. Keep the change mechanical; no
logic changes inside the handlers.

---

## M1 — Session, goal mode, `goal:` classifier, CLI skeleton

**Goal.** `deepclause repl` works for goal mode and loads `-l` files; the
classifier is the new `goal:`/English split.

**Proposal refs.** §2.1–2.2, §7.1, §9.1, §11, §13.1–13.3, §14.1, §14.2.

**Deliverables.**

* Prolog (`deepclause_mi.pl`):
  `create_session/4`, `end_frame/1`, `clear_session/1`, `load_code/3`,
  `query_start/5`, `repl_solve/4`, `collect_bindings/2`,
  `process_engine_result(solution(B,D), …)`, `mi_call(halt/list/help/reset)`,
  and the `repl_mode`-gated `format`/`writeln` output shims.
* TypeScript:
  * `src/repl/session.ts` — `DMLSession` (open/load/query/runGoal/reset/dispose).
  * `src/repl/frames.ts` — helpers over the M0 frame stack.
  * `src/repl/render.ts` — initial line-oriented renderer: rich/plain modes,
    solution bindings, errors, usage footer (task streaming lands in M3).
  * `src/repl/index.ts` — `createHarnessRepl(...)` facade (goal mode only for now).
  * `src/cli/repl.ts` — command, interactive loop, `dml> ` prompt, solution pager.
  * `src/cli/index.ts` — register `program.command('repl')`.
  * `src/cli/config.ts` — `repl` config section (`promptPrefix`, etc.).
  * `package.json` — `deepclause-repl` bin (thin wrapper).
* Classifier in `src/cli/repl.ts`:
  * match out-of-band commands first (`halt.`, `help.`, `listing.`, `reset.`,
    `export.`, `freeze.`, `unfreeze.`, `trace.`, `notrace.`, `params.`);
  * `line.startsWith("goal:")` → strip prefix, `session.query(rest)`;
  * otherwise → English (for now: print "prompt mode not yet available" in M1;
    wired in M3).

**Tasks.**

1. Implement `create_session` + `load_code`; unit-test loading a small DML file.
2. Implement `query_start/5` with goal preprocessing (`preprocess_loaded_term/3`
   — see §4.1 correctness detail) and `repl_solve/4` enumeration.
3. Implement `collect_bindings/2` (rendered text; unbound shown as `_`).
4. Implement `DMLSession.query` over `stepLoop`; map `solution` → `DMLSolution`.
5. Build the CLI loop: read line, classify, dispatch, render bindings, pager
   (`;` next, `.` stop, `a` all, `w`/`p` write/print, `?` help).
6. `-g` runs one goal after `-l` loads and exits.
7. `-l` merges files in order; `[file].` as a goal works (MI `consult`).
8. Wire `reset.` to `clear_session`; `halt.` to exit; `listing.` to
   `repl_listing`.
9. Add `render.ts` with `rich`/`plain`/`json` modes; auto-select `plain` when
   stdout is not a TTY; ensure no ANSI in plain mode.

**Tests.** `tests/repl-goal.test.ts`, `tests/repl-cli.test.ts`,
`tests/repl-render.test.ts`

* `goal: member(X,[a,b,c]).` enumerates and stops correctly.
* `goal: fact(5,F).` (after `-l`) binds `F`.
* `goal: undefined_pred(X).` yields an error event, not a hang.
* Syntax error after `goal:` is reported and does not enter prompt mode.
* Non-`goal:` text is classified as English (assert the M1 placeholder).
* `-l a.dml -l b.dml -g "p(X)"` merges and runs.
* `-g` exit code is non-zero on error.
* `reset.` empties the module.
* `render.ts`: plain/non-TTY emits no ANSI; rich mode colors bindings;
  `--json` emits one object per event.

**Acceptance.** A user can start the REPL, load a harness, run `goal:` queries,
enumerate solutions, and exit. `npm test` green.

---

## M2 — Freeze lock + export/reload

**Goal.** `freeze`/`unfreeze`, the mutation guards, `export`/`-l`, `--export`,
`-f`, `--locked`.

**Proposal refs.** §2.5–2.6, §12, §14.1 (export predicates), §20 #2/#3/#5.

**Deliverables.**

* Prolog: `session_frozen/2`, `repl_freeze/1`, `repl_unfreeze/1`,
  `repl_is_frozen/1`; guards in `mi_call(assertz/asserta/retract/retractall)`,
  `mi_call(consult/[F])`, and `load_code/3`; `export_harness/3`,
  `export_directives/2`, `export_tools/2`, `export_scripts/2`,
  `export_clauses/2`; `repl_delete/1` handling.
* `src/repl/export.ts` — serialize + write; `--skill` wrapper option.
* `src/repl/tools.ts` — `repl_assert`/`repl_retract` refuse when frozen.
* CLI: `export [file].`, `freeze.`, `unfreeze.`, `--export`, `-f`, `--locked`.

**Tasks.**

1. Implement the freeze flag and guards; ensure the transaction commit path
   also checks it.
2. Implement deterministic export: directives first; tools (`tool_source/2` or
   reconstructed); scripts (`script_body/2`, `*_source/2`) emitted once;
   user predicates sorted by `name/arity`; `repl_entry/1`; internal predicates
   excluded.
3. Escape string facts with `write_term` `quoted(true)`; add a round-trip test
   with `"`, `\`, newlines, and Unicode.
4. `export --skill` emits an `agent_main/N` wrapper over the default
   `repl_entry`.
5. `-l` loads via `load_code`; `-f`/`--locked` order: always load first, then
   freeze, regardless of argv order.

**Tests.** `tests/repl-freeze-export.test.ts`

* Frozen: `assertz`, `retract`, `consult`, `[file]`, commit, `reset` all
  refused; read-only queries and `execute` still work; `unfreeze` restores.
* `--locked` forbids `unfreeze`.
* `export → -l → export` byte-stable (normalized timestamps).
* `export → -l → -g goal` matches pre-export behavior.
* Embedded-script fact survives round-trip and runs after workspace cleanup.
* `repl_delete/1` removes a predicate.

**Acceptance.** A harness can be locked, exported, reloaded, and run
identically; mutation is impossible while frozen.

---

## M3 — Prompt mode (meta frame, meta tools, commit/run)

**Goal.** Plain English → `task_named` meta frame → DML → commit → entry run.

**Proposal refs.** §9.2–9.6, §10.1–10.3, §14.1, §20 #4/#5/#8.

**Deliverables.**

* Prolog: `repl_meta_prompt/2`, `repl_extract_code/2`, `repl_entry_goal/2`,
  `repl_reserved/1`, `repl_tool_catalog/2`, `repl_manifest` inputs.
* `src/repl/prompt.ts` — build the prompt string, construct the `task_named/3`
  goal with `DMLCode`/`EntryGoal` typed outputs, run it in a meta frame, extract
  and validate the ````dml` block, one repair round, commit, run entry.
* `src/repl/tools.ts` — the five host meta tools (M6 adds `ask_user`; M3 ships
  the first four) injected by frame kind.
* **Streaming (proposal §15):** `onReasoning` in `agent.ts` + the `reasoning`
  `DMLEvent`; `render.ts` live text/reasoning/tool rendering; prompt
  suspend/resume around streaming.
* Commit logic: **replace-by-predicate** + `repl_delete/1`.

**Tasks.**

1. Implement `repl_meta_prompt/2` assembly: authoring contract + host tool
   catalog + harness manifest + meta memory + request + output contract
   (including the self-containment and naming/entry rules).
2. Build the meta-frame goal in the SDK: call `repl_meta_prompt/2` first, then
   construct `task_named/3`; escape `Request` via `toPrologTerm`.
3. Implement the meta tools (`listing`, `assert`, `retract`, `execute`) as host
   tools; inject exactly these for `meta` frames (harness tools hidden).
4. `assert` routes through `process_clause/2`; reserved names rejected.
5. Extract the fenced `dml` block and `EntryGoal`; validate in a throwaway
   module; one repair round on syntax errors.
6. Commit: snapshot bookkeeping + module + `M0` at turn start; restore; then
   replace-by-predicate load; process `repl_delete/1`.
7. Entry run: `EntryGoal` → `repl_entry/1` → definitions-only; object frame
   with harness memory.
8. Wire the CLI: non-`goal:` lines feed `HarnessRepl.prompt`; render progress,
   commit summary, and entry answer.
9. Add the reasoning channel: `onReasoning` in `agent.ts`, `reasoning`
   `DMLEvent`, forward in `runner.ts` (top-level and nested).
10. Extend `render.ts`: streamed markdown-lite text, dimmed reasoning,
    in-place tool lines (`starting → completed/failed`), task activity, usage
    footer; suspend/resume the `dml> ` prompt around streaming.

**Tests.** `tests/repl-prompt.test.ts`, `tests/repl-stream.test.ts`
(canned backend emitting text + reasoning + tool deltas)

* Canned `fact/2` program commits; `goal: fact(5,F).` then binds `F`.
* Canned `repl_entry(explain_factorial). explain_factorial :- …` runs the entry.
* Redefinition: second turn returns a new `fact/2`; assert only one definition
  exists (`findall`).
* `repl_delete(fact/2)` removes it.
* No `agent_main` is synthesized.
* Invalid DML → one repair then abort; module unchanged.
* Transactional: a failing prompt leaves the harness byte-identical
  (module + bookkeeping + memory).
* `execute` sees scratch asserts; the committed module does not.
* Reasoning: a `reasoning-delta` from the stub backend surfaces as a
  `reasoning` event and is rendered dimmed; text deltas produce `stream` events.
* Tool calls render a `starting` line that becomes `completed`/`failed`;
  nested tool calls indent; the `dml> ` prompt is restored after streaming.

**Acceptance.** A plain-English prompt can create, modify, and delete harness
predicates and run the declared entry; failures are atomic.

---

## M4 — Context, scratch memory, `execute`, recursion budgets

**Goal.** Two memories + scratch, nested child frames, reserved-functor guards,
budgets, serialized meta tools.

**Proposal refs.** §7.2–7.3, §10, §14.1, §20 #1/#2/#9/#10/#17.

**Deliverables.**

* `session_meta_memory/2`, `session_repl_memory/2`, `memory_slot` in state;
  `query_start/5` seeds from the right slot; `repl_solve` writes back by slot.
* `execute` host tool: child frame over scratch; nested `task` allowed; result
  returned truncated.
* Children get no meta tools; `execute` rejects reserved functors; three-place
  reserved guard (`execute`, `mi_call_dispatch`/`call`, `assert`/`load_code`).
* Budgets: frame depth, model-call counter, gas.
* Serialize meta-tool dispatch.

**Tasks.**

1. Implement the memory slots and wire meta/scratch/harness seeding.
2. Implement scratch memory per transaction; share across `execute` calls;
   discard at commit.
3. Implement child-frame `execute` with recursive `task` support.
4. Add reserved-functor enforcement in all three places.
5. Add depth/model-call/gas budgets and a clear budget-exceeded error.
6. Serialize meta-tool calls (queue) so two `execute`s cannot race.
7. Event routing: `frameId`/`depth` on events; CLI indentation.

**Tests.** `tests/repl-context.test.ts`

* Meta `task` never sees harness memory; harness `task` never sees meta memory.
* `execute` writes are discarded; entry run advances harness memory.
* Nested `task` inside `execute` works and is bounded.
* `call(repl_freeze)` / asserted `repl_*` / consulted `repl_*` are refused.
* Depth and model-call limits abort cleanly.
* Two `execute` calls in one meta turn run sequentially (canned backend issues
  both).

**Acceptance.** The two-level memory model holds under tests; recursion is
bounded and cannot re-enter the meta level.

---

## M5 — Backends + host tools (`set-backend pi`, `bash`)

**Goal.** `deepclause set-backend pi|env|status`; default `bash` capability tool
with sandbox config; host tool catalog in the prompt.

**Proposal refs.** §13.5, §14.4, §14.5, §16, §20 #22.

**Deliverables.**

* `src/repl/backend.ts` — resolve `env` vs `pi`; dynamic import of
  `@earendil-works/pi-coding-agent`; `ModelRuntime` + `ModelRegistry` adapter
  reused from `deepclause-pi/src/runtime.ts` `createPiBackend`.
* `src/repl/toolset.ts` — register `bash` via `createShellManager` and the
  existing sandbox config.
* `src/cli/set-backend.ts` + `program.command('set-backend')`.
* `.deepclause/config.json` `backend` section; `repl.tools`.
* `package.json`: optional peer deps (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-ai`).
* Catalog injection into `repl_meta_prompt`; `listing(tools)`.

**Tasks.**

1. Resolve paths (explicit → `<cwd>/.pi` → `~/.pi/agent`); map to
   `ModelRuntime.create({ authPath, modelsPath })`.
2. Implement the `LLMBackend` adapter; map usage/finishReason/providerData.
3. `set-backend` writes/reads config; `status` reports.
4. Register only `bash` by default; `--tools`/`--no-tools`; sandbox wiring.
5. Inject the tool catalog into the meta prompt.
6. Security: generated tools pass untrusted data via files, not shell
   interpolation (document + example in the prompt).

**Tests.** `tests/repl-backend.test.ts`, `tests/repl-bash.test.ts`

* Path precedence; missing pi packages → clear error; `status` accurate.
* Stub registry maps to `LLMBackend` (text/toolCalls/usage).
* `bash` executes under the sandbox; unapproved/dangerous config honored.
* `listing(tools)` matches the registry; `--no-tools` removes `bash` but leaves
  file predicates.
* Meta prompt contains the catalog.

**Acceptance.** Without API keys, `deepclause repl` runs against pi's model;
`bash` works with the existing sandbox.

---

## M6 — `ask_user` at both levels + non-interactive policy

**Goal.** Fifth meta tool and harness input channel; no hangs in autonomous
runs.

**Proposal refs.** §2.7, §9.2, §9.4, §13.6, §14.5, §16, §20 #26/#27.

**Deliverables.**

* Meta `askUser` in `metaTools`; host-backed tool.
* Harness channel: `mi_call(input/2)` (exists) and `exec(ask_user(...))`
  (SDK internal), routed through one `onInput`.
* `RunOpts.onInput` on `HarnessRepl.query/prompt`.
* CLI: `--no-ask`, `--answer`, `--interactive-input`; mode table from §13.6.
* Policy: `ask_user` exempt from the capability whitelist/blacklist.

**Tasks.**

1. Add the `askUser` meta tool; serialize it with the other meta tools.
2. Route both levels through the same `onInput`; emit `input_required`.
3. Non-interactive behavior: `cancelled` (meta) / goal failure (harness) /
   `--no-ask` immediate fail / `--answer` canned.
4. Exempt `ask_user` from capability policy while keeping it cancellable.
5. Update the meta prompt to note it may ask clarifying questions.

**Tests.** `tests/repl-ask-user.test.ts`

* Meta `ask_user` mid-turn returns the answer and the turn continues.
* Harness `input/2` uses the same callback.
* Non-interactive: no hang; `cancelled`/failure; `--no-ask` fails fast;
  `--answer` reused.
* Nested `task` inside `execute` calling `input/2` does not deadlock.
* `ask_user` allowed under a strict capability whitelist.

**Acceptance.** Both levels can ask, and CI never blocks on input.

---

## M7 — Polish, docs, optional pi embedding

**Goal.** Finish the experience and hand off.

**Proposal refs.** §14.3, §15, §17, §18, §19.

**Deliverables.**

* `src/cli/repl.ts`: `--json`, non-TTY scripting, pager polish
  (`w`/`p`/`+`/`-`), trace presentation, `--export` on exit.
* `docs/REPL.md` user guide; `src/system/assets/docs/DML_REFERENCE.md` update
  (REPL + `repl_entry/1` + self-containment + `ask_user`).
* Optional: `deepclause-pi` `/dc-repl`/`/dc-query` built on `HarnessRepl`,
  mapping events to pi UI via `buildInitialMessages` and `ctx.modelRegistry`.
* Optional: model-callable `dc_query`/`dc_run` bridge (gated like `dc_run`).

**Tasks.**

1. `--json` output schema + docs; stdin scripting example.
2. Trace/verbose presentation; hidden Prolog logs.
3. Write `REPL.md`; update `DML_REFERENCE.md`; add the authoring note.
4. Optional pi embedding behind a flag; keep `.pi/deepclause/` rules.
5. Self-hosting demo: build a tool with an embedded script, export, clean the
   workspace, reload with `-l -f`, run it.

**Acceptance.** Documented, demoed, and reproducible from a clean checkout.

---

## 4. Test commands

```bash
npm test                                   # all vitest
npx vitest run tests/repl-goal.test.ts     # one file
npm run build                              # must be clean before each commit
```

Manual smoke (keep in the plan as the end-to-end check):

```bash
npm run cli -- repl -l harness.dml -f -g "explain_factorial"
cat prompts.txt | npm run cli -- repl -l seed.dml --export out.dml --no-ask
```

## 5. Decisions to lock before starting

Resolve these from proposal §19 (recommended values in parentheses):

1. Commit semantics: transactional default, optional `:direct` (§19.1).
2. Every prompt runs an entry only if declared; definitions-only is valid
   (§19.2).
3. `-g` semantics: pick "repeatable, run in order in one session" or "single
   goal" and document it (§19.13).
4. One-shot prompt mode: decide whether `repl` gets a `--prompt <text>` flag
   (long form, to avoid the root `-p` collision) (§19.14).
5. Meta-tool serialization strategy: queue vs per-frame result slots (§20 #9).
6. Export determinism: sort by `name/arity`, normalize timestamps (§19.10).
7. Embedded-script convention: `script_body/2` + `*_source/2` allowlist
   (§19.12).

Record each decision at the top of the milestone that depends on it.

## 6. Traceability

| Proposal | Milestone | Primary files |
|---|---|---|
| §8 frames | M0 | `src/runner.ts`, `deepclause_mi.pl` |
| §9.1 classifier | M1 | `src/cli/repl.ts` |
| §11 goal mode, `-g` | M1 | `deepclause_mi.pl`, `src/repl/session.ts` |
| §12 freeze/export | M2 | `deepclause_mi.pl`, `src/repl/export.ts` |
| §9.2–9.6 prompt mode | M3 | `src/repl/prompt.ts`, `src/repl/tools.ts` |
| §15 streaming/render | M1, M3 | `src/repl/render.ts`, `src/agent.ts`, `src/runner.ts` |
| §7.2/§10 memory & recursion | M4 | `deepclause_mi.pl`, `src/repl/frames.ts` |
| §13.5/§14.4 backend | M5 | `src/repl/backend.ts`, `src/cli/set-backend.ts` |
| §14.5 host tools | M5 | `src/repl/toolset.ts` |
| §9.4/§13.6 ask_user | M6 | `src/repl/tools.ts`, `src/cli/repl.ts` |
| §14.3 pi embedding | M7 | `deepclause-pi/src/index.ts` |

## 7. Definition of done (feature)

* `deepclause repl`, `deepclause repl -g`, `deepclause repl -l`, `-f`,
  `--export`, and `deepclause set-backend pi` all work.
* All invariants in §2 hold and are covered by tests.
* `npm run build` and `npm test` are green; `runDML` regression passes.
* `docs/REPL.md` documents the classifier, both memory levels, `export`/
  `freeze`, `ask_user`, self-containment, and the backend.
* A fresh checkout can reproduce the self-hosting demo from the plan.
