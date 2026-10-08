# Current state

A snapshot of what DeepClause SDK is today. Branch `feat/dml-repl` (not merged).

## Surfaces

- **`deepclause repl`** — a living-module REPL: plain English authors DML, `goal:`
  queries it.
- **`deepclause run <file>`** — one-shot execution of a `.dml`/`.zip` harness via
  `agent_main/N` or `--goal`.
- **`deepclause visualize <file> -g P/A`** — a Mermaid diagram of a harness skill.
- **TypeScript SDK** — `createDeepClause` (embed the runtime), `createHarnessRepl`
  (embed the REPL), judge backends, the pi/env backend helpers.

CLI commands: `init`, `login`, `logout`, `set-backend`, `set-model`, `show-model`,
`list-models`, `run`, `repl`, `visualize`.

## Runtime

- **Engine**: SWI-Prolog compiled to WebAssembly (`vendor/swipl-wasm`, loaded via
  `src/prolog/`). In-process, no native Prolog.
- **Backend**: `pi` by default (reuses pi's model catalog/credentials/streaming/
  cancellation/usage); `env` (provider API keys) is opt-in.
- **Host tools**: `bash` only, plus the human channel (`ask_user` / `input/2`).
  Everything else is DML, a script run through `bash`, or a model call.
- **Paths**: workspace-relative and confined; `bash` sees more, DML does not.
- **Sandboxing**: default host shell with a wrapper (`clean-room`/`bwrap`/
  `sandbox-exec`); `--sandbox` uses the AgentVM WASM micro-VM; network off in the
  VM by default.

## REPL

- **Author mode** (plain English): a TypeScript authoring agent (`repl.authoring:
  agent`, the default) writes/tests/commits DML through harness tools
  (`begin_turn`/`end_turn`/`rollback`/`listing`/`define`/`assert`/`retract`/
  `delete`/`execute`/file tools/`ask_user`), and can run several committed turns
  in one request. The legacy DML meta frame is still available
  (`repl.authoring: meta`).
- **Transactions**: each turn snapshots the module and commits
  replace-by-predicate; a failed turn leaves the harness unchanged.
- **Auditability**: `.deepclause/repl/` holds `history.dml` (append-only
  `harness_*` facts), `harness/HEAD.json`, `harness/changes.jsonl`,
  `harness/versions/*.json`, and `sessions/<id>/{session.json,harness.json,
  turns.jsonl,events.jsonl}`. `rollback.` restores the previous version.
- **Resume**: `deepclause repl --session <id|last>` restores the harness, memory,
  and turn numbering from the durable `sessions/<id>/harness.json`.
- **Media**: `read_media/2` + `attach_media/1` attach a workspace image to the next
  `task/N` (reference-only; no bytes in clauses). Vision-capable models only.
- **Commands**: `goal:`, `help.`, `listing.`, `reset.`, `rollback.`, `export`,
  `freeze.`/`unfreeze.`, `model.`, `trace.`, `params.`, `halt.`
- **UI**: on a TTY the default is a pi-style TUI (`repl.tui`): a scrolling
transcript, a fixed status bar, and a fixed editor. The status bar shows
cumulative tokens in/out (plus cache and hit rate), context usage for the active
frame slot (`meta` while authoring, `run` while a child frame runs), and the
current model with its reasoning level. `ask_user`/`input/2` reuse the same
editor, so input prompts never fight the main prompt. `--plain`/`--no-tui` fall
back to the line renderer, which tints tool calls (green for shell, blue for
`execute`), shows a model-call spinner, previews a few lines of bash output, and
shows the full bash script / `execute` goal wrapped. `--no-stream`,
`--no-events`, `--json`.
- **Reasoning models**: `backend.thinkingLevel` (off|minimal|low|medium|high|xhigh|max)
is selectable in `deepclause login`, `set-backend`, `set-model`, and `repl`/`run`
(`--thinking`) and is forwarded to pi's provider only for reasoning-capable
models. The bundled catalog marks `[reasoning]` models in every picker.
- **Compaction**: TypeScript compaction ported from pi (no DML compactor). It
sizes context with the chars/4 estimate, cuts on user boundaries, and summarizes
with the structured pi prompt through the active pi backend. Session (meta)
memory compacts before a turn and in-loop memory compacts before a model call;
`compact.` compacts on demand. `memory_compaction` events drive the status bar.
- **Cancellation**: Ctrl-C aborts the current turn and terminates a running `bash`.

## Authoring model

The bundled guides (`META_PROMPT.md`, `DML_AUTHORING.md`, `HARNESS_EXAMPLES.md`,
`PROLOG_SNIPPETS.md`, `DML_REFERENCE.md`) encode the current philosophy:

- Skills are **short sequences of `task/N`/`prompt/N` calls** with thin Prolog
  guards; no hand-rolled algorithms, and CLP only for genuine constraint problems
  (bounded domains — an unsatisfiable model can search forever, and there is no
  per-goal timeout).
- **Generalize, don't specialize**; distinguish reusable capabilities from one-off
  actions; never hardcode host paths or other environment-specific values.
- **Prefer the shell** for file I/O; use DML file predicates only for content that
  must be reasoned over inside Prolog.
- **Determinism**: a skill that calls `task/N`, `exec/2`, `read_media/2`, or writes
  a file must be deterministic (`once/1`, `->`, `!`).
- `listing`/`export` show `task/N`/`prompt/N` (the internal `task_named/3` rewrite
  is reversed for display).

## Tests

`npm test`: **353 passed / 25 skipped / 0 failed**. The skipped 25 are the
`llm-integration` suite, gated behind real provider API keys.

## Not implemented / known gaps

- **`.deepclause/lib/` libraries** — designed but not built; see
  [`DML_LIBS_PROPOSAL.md`](./DML_LIBS_PROPOSAL.md).
- **Media generation and video** — image *input* works; `gen_image` and video
  (frame sampling) are not built; see [`DML_MEDIA.md`](./DML_MEDIA.md).
- **No per-goal wall-clock timeout** — a runaway goal (e.g. unbounded CLP) hangs.
- **`visualize` images** need `@mermaid-js/mermaid-cli` + a browser (fetched with
  `npx`); a `.mmd` output always works.
- **`deepclause-sdk/compiler`** is retained as a thin `validateWithProlog` alias
  for the sibling apps until the next publish, then remove it.
- **`dist/`** is untracked build output (gitignored).
- The pi extension (`dc_run`, slash commands) lives in a separate repo.

## Docs map

- Language/runtime: `DML_REFERENCE.md`, `DML_AUTHORING.md`, `HARNESS_EXAMPLES.md`,
  `PROLOG_SNIPPETS.md` (bundled; also seeded to `.deepclause/docs/`).
- REPL: `REPL.md`, `DML_REPL_PROPOSAL.md`, `DML_REPL_IMPLEMENTATION_PLAN.md`,
  `DML_REPL_SESSION_HISTORY.md`, `DML_REPL_SCRIPT_BUNDLES.md`.
- Other: `JUDGMENT_BACKENDS.md`, `JUDGE_EXAMPLES.md`, `DML_MEDIA.md`,
  `DML_LIBS_PROPOSAL.md`, `REFACTOR_CLEANUP.md`, this file.
