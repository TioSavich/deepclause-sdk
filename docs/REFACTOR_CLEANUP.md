# SDK refactor / cleanup plan

Status: done (P0–P6). Goal: reduce the SDK to **REPL + run + TS SDK**, remove
the TUI, the Markdown→DML compiler, and the old coding-harness DMLs, unify the
runtime backend (pi/env), harmonize `run`/REPL rendering, and simplify docs.

Outcome: the compiler, TUI, conductor/planner/skill-creator DMLs, recipes,
skill catalog, and `list-tools`/`list-commands` are gone; `run` and the REPL
share `resolveLlmBackend` and `ReplRenderer`; `validateWithProlog` moved to
`deepclause-sdk/validate` (with a `./compiler` alias); the README was rewritten.

Note: the sibling apps (`deepclause-pi`, `sop2harness`) still import
`deepclause-sdk/compiler` because `sop2harness` uses the *published* SDK, which
has no `./validate` yet. Migrate them to `deepclause-sdk/validate` after the
next SDK publish (one import each).

## Decisions

1. **Compaction**: keep (`runner`/`createDeepClause` use it); it is runtime
   context management, not a coding harness. Default stays as-is.
2. **No-args `deepclause`**: print help; `deepclause repl` is the interactive
   entry.
3. **`run --prompt`**: drop (the REPL `prompt` replaces NL→DML).
4. **Sibling compat**: add `deepclause-sdk/validate`; migrate `deepclause-pi`
   and `sop2harness` to it; keep `deepclause-sdk/compiler` as a thin
   `validateWithProlog`-only re-export during the transition.
5. **Nested skill catalog** (`.deepclause/tools` + `catalog-skills`): drop.
6. **Tests**: delete tests for deleted code; keep the pre-existing unrelated
   failures out of scope.
7. **`createHarnessRepl`** stays exported publicly.

## Target surfaces

**CLI**: `init`, `run`, `repl`, `login`, `logout`, `set-backend`, `set-model`,
`show-model`, `list-models`. Nothing else.

**Library** (`package.json` exports):
- `"."` — `createDeepClause` + types, judge backends, the REPL facade, the pi/env
  backend helpers.
- `"./validate"` — `validateWithProlog` + syntax/lint helpers.
- `"./compiler"` — deprecated alias exporting `validateWithProlog` only.

**Assets kept**: `docs/DML_REFERENCE.md`, `docs/DML_AUTHORING.md`,
`model-database.json`, `compactors/*.dml`.

## Phases

### P0 — document (this file)
Commit the plan.

### P1 — validation extraction + compiler removal
- New `src/validate.ts`: move `validateWithProlog`, `checkBalancedDelimiters`,
  `lintDML`, `validateDMLSyntaxBasic` out of `compiler.ts`.
- `package.json`: add `"./validate"`; `"./compiler"` re-exports `validateWithProlog`.
- Delete `src/compiler.ts`, `src/compiler_prompt.ts`, `src/cli/compile.ts`,
  `src/cli/prompt.ts`; remove the `compile`/`compile-all`/`plan` commands.
- `sdk.ts`: drop `compileToDML`; `tools.ts`: drop `getBuiltInCompileTools`.
- Migrate `../deepclause-pi/src/planner.ts` and
  `../sop2harness/src/harness/validate.ts` to `deepclause-sdk/validate`.
- Delete compiler tests.

### P2 — TUI removal
- Delete `src/cli/tui.ts`, `src/system/runtime/conductor.ts`,
  `src/cli/interactive.ts` (replace `promptUser` with a small stdin helper in
  `run`), `assets/docs/{TUI,CONDUCTOR_PROMPT,TASK_PROMPT}.md`,
  `runtime/catalog-recipes.ts`.
- `cli/index.ts`: no-args → help; remove root `-p/--prompt`, `startTui`,
  `runPromptHeadless`, `readRootPrompt`, `hasRootSandbox`.
- Delete TUI/conductor tests.

### P3 — backend unification for `run`
- Extract `resolveLlmBackend(config, options) → { backend, modelId, provider }`
  in `repl/backend.ts`; use it in `createReplRuntime` and `run`.
- `system/runtime/dml-executor.ts`: take the backend descriptor, pass
  `llmBackend` to `createDeepClause`; delete `applyResolvedModelConfig`'s
  `process.env` mutation and the env-only preflight.
- `run` gains `--backend pi|env`.

### P4 — renderer unification
- `run`/`dml-executor` render events with `repl/render.ts` (`ReplRenderer`);
  drop `--headless`, add `--plain`/`--json`; fold `cli/tool-args.ts` in.

### P5 — old harness assets/runtime removal
- Delete `assets/skills/*`, `assets/recipes/`, `src/cli/default-skills.ts`,
  `runtime/{catalog-skills,skill-creator}.ts`, `cli/{tools,commands,mcp,search}.ts`,
  `*.bak`.
- Prune `assets/index.ts`, `package.json` `files`, `initConfig` seeding.
- Simplify `runtime/dml-params.ts` (positional args + `--param`).

### P6 — docs + tests
- Rewrite `README.md` (REPL + run + TS SDK only); prune docs.
- Delete dead tests; keep the build and the remaining suite green.

## Guardrails
- Each phase: `npm run build` and `npm test` with no *new* failures.
- Keep `validateWithProlog` importable for the siblings.
- Add a sibling gate note: build/test `deepclause-pi` against the local SDK after
  SDK changes.
- `deepclause-pi` uses the local SDK via a symlink; its used surface is
  `createDeepClause`, judge backends, types, and `validateWithProlog` — all
  preserved.
