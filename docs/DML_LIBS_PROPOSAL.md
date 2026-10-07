# Proposal: reusable DML libraries via `.deepclause/lib/`

Status: **proposal only — not implemented.** No code or assets for this exist yet.

Goal: let a harness reuse DML from files instead of re-deriving it, while
preventing the failure modes (silent clobbering, name clashes, duplicate loading,
path escapes). The meta task gets a **careful `consult`** operation; libraries
live in a conventional folder seeded with good defaults.

## 1. Where libraries live

- Default `lib.dir = ".deepclause/lib"`, **configurable** (so the pi extension
  can use `.pi/deepclause/lib` under its "never create `.deepclause/`" rule).
- Seeded lazily on first `init`/load (like `.deepclause/docs`), **never
  overwritten** unless the file is missing; user files are preserved.
- A seeded `stdlib.dml` plus a short `README.md` explaining the convention.

## 2. How a harness references a library

Two surfaces, on purpose:

- **Runtime (committed DML):** `:- consult("<libdir>/stdlib.dml").` — already
  supported by `process_directive(consult/1)`, so it works when the harness
  loads / `run`s.
- **Author-time (meta task):** a new **`consult(path)` meta tool** — the
  "careful" path (checks below).

## 3. What "careful" means (the core of the proposal)

`consult` parses the file **before** asserting anything and applies this policy:

| Situation | Action |
|---|---|
| Path absolute or with `..`, or not `.dml` | **error** (refuse) |
| Path outside `lib.dir` | **warning**, allowed (convention) |
| Lib defines a reserved name (`repl_*` / `meta_*` / MI builtin) | **error** |
| Lib defines a predicate the **harness** already defines | **error**, listing `name/arity` clashes |
| Lib defines a predicate **another consulted lib** already defines | **error**, listing clashes |
| Re-consult of the **same** file (already loaded) | **warning** + no-op (idempotent) |
| Lib defines nothing | **warning** |
| Success | load, record it, return `loaded` names |

Result shape returned to the meta task:
`{ status: ok|already|error, loaded: [name/arity], warnings: [...], error?: string }`.
The meta task must surface an error and not continue as if it succeeded.

Clash detection must consider only predicates the **harness/libs actually
define** (via `repl_user_predicate` / tracked lib names), not predicates
*imported* from SWI libraries (e.g. `atom_json_dict/3`), so importing
`library(http/json)` in two libs does not false-positive.

## 4. Bookkeeping & lifecycle

- Track loaded libs as a **module fact** (`session_lib(SessionId, RelPath, Defs)`)
  so it participates in `repl_snapshot_save/restore`, `rollback`, and `reset` —
  a failed/aborted turn does not leave phantom "loaded" state.
- Frozen harness → `consult` refused (same as other writes).
- **Export:** loaded lib predicates are currently part of the module, so
  `export` **inlines** them (self-contained single file). Alternative (reference
  + bundle the lib) is more work; keep inlining for v1 and document it.
- Commit safety: during a prompt turn `consult` runs on the scratch module; if
  the turn fails, `repl_snapshot_restore` discards the lib load (correct).

## 5. Discoverability

- Manifest shows consulted libs (and the lib dir).
- `listing(libs)` lists `.dml` files available under `lib.dir`.
- The default `stdlib.dml` is a `module_doc`/`doc`-annotated example of the
  convention.

## 6. Default library content (draft, for review)

`.deepclause/lib/stdlib.dml` — deliberately tiny and general, aligned with the
"thin Prolog, orchestrate" philosophy:

- `json_task/2`, `json_prompt/2` — model call whose reply is parsed as JSON
  (`atom_json_dict`, verified available in the bundled engine).
- `json_value/2` — parse a JSON string/atom.
- `or_default/3` — first solution of a goal, else a default.

Rationale: JSON-structured model output and a small guard are broadly reused;
file I/O and heavy logic are deliberately excluded (shell / task-first).

**Open question:** is that the right default, or would a *stub* (just
`module_doc` + a commented example) or a different set (web/HTTP tool, dates,
…) be better?

## 7. Proposed changes (files)

- `src/system/assets/lib/stdlib.dml` (+ maybe `README.md`) — bundled assets;
  `assets/index.ts` + `copy:assets` to ship them.
- `src/cli/config.ts` — `lib.dir` config + `ensureWorkspaceLibSeeds`
  (seed/backfill); `getLibDir`.
- `src/prolog-src/deepclause_mi.pl` — `session_lib/3`, `repl_consult_lib/6`
  (parse → clash-check → load → record), clear/rollback/destroy hooks, export.
- `src/repl/tools.ts` — `consult(path)` meta tool; catalog/manifest entry.
- Docs: `META_PROMPT.md` + `DML_AUTHORING.md` (reuse libs; consult carefully;
  never clash; do not copy lib code into the harness).
- Tests: seed; consult ok; clash → error; re-consult → warning; traversal →
  error; harness loads a lib via `:- consult(...)`.

## 8. Open decisions

1. **Config key:** `repl.lib.dir` vs a top-level `lib: { dir }`. Leaning
   `repl.lib.dir`; a top-level key if `run` needs it independently (it does need
   lib resolution for `:- consult`).
2. **Path policy:** allow any workspace-relative `.dml` (warn off-lib) or
   hard-restrict to `lib.dir`? Leaning allow + warn.
3. **Clash severity:** hard **error** (refuse) vs **warning** and load anyway.
   Leaning error, per "very careful".
4. **Export:** inline lib predicates (v1) vs reference + bundle (later).
5. **Default content:** small stdlib (above), stub, or something else.
6. **Scope:** add a `lib` concept at all, or just harden the existing
   `consult` / `:- consult(...)` with conflict checks and a documented
   convention (no new config/seed)?

## 9. Risks

- SWI `current_predicate/1` includes imports → false clashes; must compare
  against *defined* user predicates only.
- Clauses are asserted with `assertz` (append); consulting a lib twice without
  the re-consult guard would duplicate. The idempotency check is essential.
- Export inlining can surprise users who later edit the lib (the change will not
  propagate to an already-exported harness). Documented.
