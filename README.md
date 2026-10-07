# DeepClause SDK

DeepClause is a **Prolog-based runtime for self-modifying agent harnesses**. A
harness is a living **DML** module. DML (DeepClause Meta Language) is a Prolog DSL with added functionality for LLM model calls, semantic
judgments (Jev-type models), and constraints. An LLM agent embedded in the runtime reads, extends, and tests code in a living module a turn by
turn. You drive it from an interactive **REPL**.

DML runs on **SWI-Prolog compiled to WebAssembly** — the whole language runtime
is in-process and portable, with no native Prolog to install.

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
`.zip` bundle.

### Saving and re-loading a harness

A harness is a normal `.dml` file you can check in, diff, and re-open.

```text
dml> add a tally(List, Counts) skill and a demo
dml> goal: tally([a,b,a,c,a], C).
C = [a-3, b-1, c-1]

dml> export tally.dml.
exported 3 clauses, 0 tools, 0 scripts → tally.dml

dml> halt.
```

```bash
deepclause run tally.dml --goal 'tally([a,b,a], C)'   # run a goal from the file
deepclause repl -l tally.dml                           # or re-open it and keep building
dml> goal: tally([x,y,x], C).
C = [x-2, y-1]
```

`export <file>.` writes a portable `.dml`; use a `.zip` target to bundle linked
`script_file/2` scripts. `--export <file>` exports on exit, and exiting without
an export auto-saves the harness to a temp `.zip` bundle.

## Install

```bash
npm install deepclause-sdk
```

## Quick start

```bash
deepclause init                 # write .deepclause/config.json
deepclause login                # sign in to provider, then pick a model
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
overrides it. Existing pi installations stay untouched.

## run

`run` uses the **same engine as the REPL**: it opens a module, loads the
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

## Runtime and sandboxing

**Engine.** DML is executed by **SWI-Prolog compiled to WebAssembly**
(`vendor/swipl-wasm`, loaded through `src/prolog/`). It runs in-process — no
native Prolog install, no external server — with the standard SWI libraries
available (constraint solving via `clpfd`, `clpq`, `clpr`; plus regex, dicts,
and DCGs). Validation runs on the same engine.

**Workspace confinement.** DML file predicates and `bash` all run against the
active **workspace** (`.` or `--workspace <path>`) using workspace-relative
paths; harness paths cannot escape it.

**Shell execution.** `bash` is the only capability tool, with two backends:

| Backend | When | Notes |
|---|---|---|
| host shell | default | isolated by a wrapper: `clean-room`, `bwrap` (bubblewrap), or `sandbox-exec` (macOS); `auto` picks the best available |
| AgentVM | `--sandbox` | WASM micro-VM; network disabled by default |

Network access is **off by default** (`agentvm.network: false`), and `bwrap`
with `shell.strictIsolation: true` also disables it. `--no-tools` registers no
capability tool at all; `ask_user` / `input/2` remain the human-in-the-loop
channel.

```bash
deepclause repl --sandbox      # run bash inside the AgentVM micro-VM
deepclause repl --no-tools     # no capability host tools
```

```json
{
  "agentvm": { "network": false },
  "shell": { "wrapper": "auto", "strictIsolation": false }
}
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
  "shell": { "wrapper": "auto", "strictIsolation": false },
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

vendor/
└── swipl-wasm/   # SWI-Prolog compiled to WebAssembly (the DML engine)
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
