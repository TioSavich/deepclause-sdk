# DeepClause SDK

DeepClause is a **neuro-symbolic runtime for self-modifying agent harnesses**. A
harness is a living **DML** module — Prolog with model calls, semantic
judgments, and constraints — that an LLM agent reads, extends, and tests turn by
turn. You drive it from an interactive **REPL**; `run` executes a harness
one-shot; a small **TypeScript SDK** embeds the runtime.

Three surfaces: **repl**, **run**, **SDK**.

## The REPL: a living, self-modifying harness

The REPL keeps a persistent DML module ("the harness"). You talk to it in two ways:

| Input | Mode |
|---|---|
| `<plain English>` (default) | **author** — a meta task writes, tests, and commits DML |
| `goal: <dml>.` | **run** — query the current harness |

```text
dml> add a research(Question, Answer) skill that answers with task/2 and cites sources
dml> run research on "why is the sky blue?"
A = "Rayleigh scattering scatters short wavelengths more strongly..."

dml> goal: research("why is the sky blue?", A).   % the same skill, run directly
```

The default mode is the interesting one: describe what you want and the meta
task edits the module for you. Ask for anything — add a skill, add a tool,
change existing logic, run or test code in the living module, or just ask a
question about the harness.

### Why Prolog/DML for a self-modifying harness

An RLM-style harness works best when the harness *is* the program the model
edits. DML makes that literal:

- **The harness is data = code.** Skills are predicates, data is facts
  (`city(ch, "Zürich").`). The model reads it (`listing`), queries it
  (`goal:`), extends it, and reuses it — no separate plugin format and no
  recompile step.
- **One language for logic and language.** Recursion, backtracking, and CLP
  constraints sit next to LLM calls (`task/N`) and typed semantic judgments
  (`choose`, `verify`, `rate`, `probability`) in the same clause.
- **Composable skills.** A `task/N` call runs a bounded agentic turn that may
  itself call other skills, so the library grows by composition and reuse.
- **Small and inspectable.** Everything a harness can do is visible in the
  module and the host tool catalog (by default `bash`, plus the human-in-the-loop
  `ask_user` / `input/2`).

### Transactions

A prompt turn is an **edit transaction**:

1. the living module is snapshotted;
2. a meta task writes DML and tests it with `execute`;
3. the returned source is committed **replace-by-predicate**;
4. a failed turn leaves the harness unchanged.

So the model can experiment aggressively and you never end up with a
half-written predicate set.

### Auditability

Every session, turn, event trace, and harness version is written under
`.deepclause/repl/` and exposed to DML as queryable `harness_*` facts
(`harness_session/5`, `harness_turn/5`, `harness_change/5`, `harness_changed/4`,
`harness_head/4`, `harness_trace/3`). `rollback.` restores the previous version,
step by step, and a harness can query its own past:

```prolog
recent_changes(N, Changes) :-
    findall(Version-Timestamp, harness_change(Version, Timestamp, commit, _, _), All),
    last_n(All, N, Changes).
```

See [`docs/REPL.md`](docs/REPL.md) and
[`docs/DML_REPL_SESSION_HISTORY.md`](docs/DML_REPL_SESSION_HISTORY.md).

### Commands

`goal:`, `help.`, `listing.`, `listing(Name/Arity).`, `reset.`, `rollback.`,
`export <file>.`, `freeze.`/`unfreeze.`, `model.`/`model <provider/id>.`,
`trace.`/`notrace.`, `params.`, `halt.`

When you leave (`halt.`, Ctrl-D, or Ctrl-C), the harness is saved to a temp
`.zip` bundle. `export research.dml.` writes a portable file; reload it with
`deepclause repl -l research.dml`.

## Install

```bash
npm install deepclause-sdk
```

The `pi` model/credential libraries (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`) are regular dependencies, so **no global `pi` install is
needed** — a globally installed `pi` is deliberately ignored so versions are
deterministic.

## Quick start

```bash
deepclause init                 # write .deepclause/config.json
deepclause login                # sign in via pi, then pick a default model
deepclause repl                 # interactive
deepclause run skill.dml "arg"  # one-shot
```

### Backends

`pi` is the default: it reuses pi's model catalog and credential store. `env`
uses the SDK's own provider/API keys.

```bash
deepclause login [--provider <id>] [--api-key <key>|--oauth] [--model provider/model]
deepclause logout [provider]
deepclause set-backend status
deepclause set-backend env       # switch to provider API keys
```

Credentials live in pi's agent dir (`~/.pi/agent`) unless `backend.agentDir`
overrides it.

## run

`run` uses the **same engine as the REPL**: it opens a living module, loads the
DML file (`.dml` or a `.zip` bundle), runs one entry, and renders events through
the REPL renderer. The entry is `agent_main/N` (chosen by the number of
positional arguments) or an explicit `--goal`.

```bash
deepclause run <file.dml> [args...]                  # call agent_main/N
deepclause run <file.dml> --goal '<dml>'             # explicit entry goal
deepclause run <file.dml> --dry-run                  # print the resolved entry
deepclause run <file.dml> --trace t.json --usage u.json
deepclause run <file.dml> --no-stream --no-events    # only outputs/answers
```

## TypeScript SDK

```ts
import { createDeepClause } from 'deepclause-sdk';

const dc = await createDeepClause({ model: 'gpt-4o', provider: 'openai' });
for await (const event of dc.runDML(dmlSource, { args: ['topic'] })) {
  if (event.type === 'answer') console.log(event.answer ?? event.content);
}
await dc.dispose();
```

To reuse pi's model and credentials from a host, pass an injected `LLMBackend`
(`createPiBackend`) and judgment backends (`createLLMJudgeBackend`,
`createJevJudgeBackend`).

The REPL is embeddable too:

```ts
import { createHarnessRepl } from 'deepclause-sdk';

const repl = await createHarnessRepl({ model: 'gpt-4o', provider: 'openai' });
for await (const event of repl.query('fact(5, F)')) {
  if (event.type === 'solution') console.log(event.solution?.bindings);
}
await repl.dispose();
```

## Validation

```ts
import { validateWithProlog } from 'deepclause-sdk/validate';

const { valid, errors, warnings } = await validateWithProlog(dmlSource);
```

## Configuration

`.deepclause/config.json` (created by `init`):

```json
{
  "backend": { "kind": "pi", "model": "anthropic/claude-sonnet-4" },
  "temperatures": { "run": 0.7 },
  "providers": { "openai": { "apiKey": "..." } },
  "agentvm": { "network": false },
  "repl": {
    "maxModelCalls": 100,
    "history": { "enabled": true, "dir": ".deepclause/repl", "trace": "summary" }
  },
  "judgment": { "default": "llm", "jev": { "enabled": false } }
}
```

## Repository layout

```text
src/
├── repl/         # the living-module REPL (session, frames, renderer, auth, history)
├── cli/          # init, run, repl, login, set-backend
├── system/       # shell/AgentVM, config, bundled docs
├── judge/        # semantic judgment backends (llm, jev, mock)
├── prolog/       # SWI-Prolog-WASM loader/bridge
├── prolog-src/   # deepclause_mi.pl, deepclause_analysis.pl, …
├── agent.ts      # task/agent loop
├── runner.ts     # DML execution
├── sdk.ts        # createDeepClause
└── validate.ts   # DML validation/linting
```

Bundled prompt assets: `META_PROMPT.md` (the meta task contract),
`DML_REFERENCE.md` (language), `DML_AUTHORING.md` (guide),
`HARNESS_EXAMPLES.md` (idiomatic shapes), `PROLOG_SNIPPETS.md` (tested building
blocks).

## Development

```bash
npm run build     # tsc + copy prolog + assets
npm test          # vitest
npm run repl      # deepclause repl via tsx
```

See [`docs/`](docs/): [`REPL.md`](docs/REPL.md),
[`DML_REPL_PROPOSAL.md`](docs/DML_REPL_PROPOSAL.md),
[`DML_REPL_SESSION_HISTORY.md`](docs/DML_REPL_SESSION_HISTORY.md),
[`JUDGMENT_BACKENDS.md`](docs/JUDGMENT_BACKENDS.md).

## License

MIT
