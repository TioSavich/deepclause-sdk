# Changelog

## 0.1.0

A ground-up simplification. The SDK is now three surfaces: **repl**, **run**,
and the **TypeScript SDK**.

### Added

- **Living-module REPL** (`deepclause repl`): a persistent DML/Prolog harness.
  Plain English is the authoring mode — a meta task writes, tests, and commits
  DML — while `goal: <dml>.` queries it directly.
- **Edit transactions**: every turn snapshots the module and commits
  replace-by-predicate, so a failed turn leaves the harness unchanged.
- **Auditability**: sessions, turns, traces, and versions are recorded under
  `.deepclause/repl/` and exposed to DML as `harness_*` facts; `rollback.`
  restores a previous version.
- **Session resume** (`deepclause repl --session <id|last>`): reopen an earlier
  session with its harness, conversation memory, and turn numbering restored. A
  durable `sessions/<id>/harness.json` snapshot is written on every change and
  again at session end, so the harness survives process exit; a module+scripts
  hash flags any drift since the session was saved.
- **pi backend by default** (`backend.kind: "pi"`): reuses pi's model catalog,
  credentials, streaming, cancellation, and usage accounting. `deepclause
  login`/`logout` port pi's OAuth/API-key flow. `env` remains an opt-in backend.
- **`run` uses the REPL engine**: load a `.dml`/`.zip` harness, call
  `agent_main/N` or `--goal`, and stream through the REPL renderer.
- **Media input** (`read_media/2` + `attach_media/1`): attach a workspace image
  to the next `task/N`, reference-only (no bytes in clauses). See
  [`docs/DML_MEDIA.md`](docs/DML_MEDIA.md).
- **`deepclause visualize`**: draw a harness skill as a Mermaid diagram
  (`--presentation` or `--spec`) from its `listing` + docs, rendering a PNG via
  `@mermaid-js/mermaid-cli` when available.
- **Tool-call rendering**: full bash scripts and `execute` goals (wrapped,
  colour-coded panels), a live model-call spinner, and a short bash output preview.
- `--no-stream` / `--no-events` REPL and run flags; harness auto-save on exit.

### Changed

- **Host tools reduced to `bash`** (plus the human-in-the-loop channel).
  Built-in `web_search`, `vm_exec`, `url_fetch`, and `validate_dml` runtime
  tools are gone; non-Prolog steps go through `bash` or a linked `script_file/2`.
- README rewritten around the REPL; docs updated. Authoring guidance now favours
  short `task/N`/`prompt/N` compositions with thin Prolog guards, the shell for
  file I/O, and CLP only for bounded constraint problems.

### Fixed

- `once/1`, `ignore/1`, `call/2..4`, and `not/1` now route through the
  meta-interpreter — previously a wrapped `task/N`/`prompt/N` ran in raw Prolog and
  failed with `task_named/3` undefined.
- Ctrl-C terminates a running `bash`: the turn's abort signal reaches
  `tool.execute` (the shell managers already honoured a signal; nothing passed one).
- `listing`/`export` show `task/N`/`prompt/N`; the internal `task_named/3` rewrite
  and hoisted `format/3` are reversed for display (export round-trip is stable).
- `deepclause run --trace <file>` enables the engine trace and writes the file (the
  CLI previously printed “Trace saved” without writing anything).

### Removed

- The Markdown→DML **compiler** (use `deepclause-sdk/validate` for validation).
- The **TUI**, conductor/planner/skill-creator DMLs, recipes, the skill catalog,
  MCP tooling, and the old examples/benchmarks.

## 0.0.89 - 2026-09-20

- Include the meta-interpreter correctness fixes: `assertz/1`, `asserta/1`,
  `retract/1`, and `retractall/1` now operate on the session module, and
  user-defined predicates backtrack through every solution again (previously
  an if-then-else committed to the first).
- Add generic semantic judgment predicates: `judge/2` (batch), `choose/4`,
  `rate/4`, `verify/3`, `probability/3`, `holds/2,3`, `with_judgment/2`, and
  `require_judgment/2`. Answers are constrained to the supplied options and
  levels, and `verify` is three-valued (`yes` / `no` / `unknown`).
- Add a `JudgeBackend` extension point next to `LLMBackend`, with `llm`, `jev`
  (TypeSafe System One), and `mock` implementations. `llm` is the default, so
  judgment predicates work without new credentials; Jev is opt-in and
  calibrated.
- Memoize judgments per run by backend, model, state, and questions, so
  backtracking reuses an answer instead of re-querying the model.
- Emit judge activity (`task_activity`) and usage (`usageSource: "judge"`)
  events; support `with_judgment/2` scoping, per-run backend overrides, and
  `require_judgment/2` capability gating.

## 0.0.87 - 2026-08-19

- Add an injectable `LLMBackend` for host-managed models, credentials, cancellation, tool calls, streaming callbacks, and usage.
- Preserve opaque provider-native assistant data across multi-step task loops.
- Route `llm/2`, token sampling, `task/N`, `prompt/N`, and nested execution through the injected backend.
- Support structured typed task results through injected backend tool calls.
- Keep DML-defined tool predicates visible inside task loops while enforcing runtime policy on their nested `exec/2` calls.
- Export backend, usage, and memory types from the package entry point.
