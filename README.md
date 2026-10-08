# DeepClause SDK

DeepClause is a **Prolog-based runtime for self-modifying agent harnesses**. A
harness created with DeepClause is a self contained library in the form of a **DML** module. DML (DeepClause Meta Language) is a Prolog DSL with added functionality for LLM model calls, semantic
judgments (Jev-type models), and constraints. An LLM agent embedded in the runtime reads, extends, and tests code in a live module a turn by
turn. You drive it from an interactive **REPL**. Using the REPL once can successively build a custom harness that is optimized for a specific use case.

DML runs on **SWI-Prolog compiled to WebAssembly** — the whole language runtime
is in-process and portable, with no native Prolog to install.

Most agent stacks contain a lot of separate moving parts: tools in one place,
prompts in another, memory in a third, and the workflow as a graph or a chain
somewhere else. DML folds them into one idea — a **predicate**. A skill is a
clause, a tool is a clause, memory and state are clauses, control flow and
retries are clause order and backtracking, and a workflow is simply predicates
calling predicates. Because it is one language in one self-contained file, the
parts can read, reuse, and extend one another, and a whole harness can be
inspected, versioned, and moved as a unit.

## Dependencies and acknowledgements

DeepClause stands on other people's work, and is grateful for it:

- **[Pi](https://pi.dev)** (`@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-ai`) — the `pi` backend reuses Pi's model catalog,
  credential store, streaming, cancellation, and usage accounting, and the
  interactive REPL TUI is built on Pi's terminal UI library
  (`@earendil-works/pi-tui`). Thanks to the **Pi developers** for building and
  sharing it.
- **[SWI-Prolog](https://www.swi-prolog.org/)** — the Prolog engine that DML
  runs on, compiled to WebAssembly so the whole runtime is in-process and
  portable. SWI-Prolog is created and maintained by **Jan Wielemaker** and the
  SWI-Prolog community.
- **[Markus Triska](https://www.metalevel.at/)** — his work on
  meta-interpreters, constraint logic programming, and the
  `library(clpfd)`/`library(clpq)` libraries underpins DML's executable
  meta-interpreter and constraint layer.

DML, the REPL, and the SDK are original work; these projects are used as
dependencies and as conceptual foundations.

## Why would I use this?

- **Reproducibility.** Control flow, retries, and validation are Prolog clauses
  you can read and re-run, so a DML harness tends to produce the same result shape
  across sessions and machines. The model is consulted only at the points you
  choose, and its outputs are typed where that helps.
- **Auditability.** Each turn is a transaction: the module is snapshotted, the
  change is committed replace-by-predicate, and the session, event trace, and
  harness versions are recorded and remain queryable. It is possible to see what
  changed, when, and in response to what.
- **Regulated and high-stakes settings.** Where a workflow has to be reviewed,
  versioned, and reproduced — and where it helps to keep deterministic logic
  separate from model judgment — a small, inspectable harness is easier to
  scrutinise than a prompt. The transaction record and `rollback.` are meant to
  support that kind of review, not replace it.
- **Research in neurosymbolic AI.** DML offers a concrete substrate for
  combining symbolic reasoning (Prolog, CLP, backtracking) with LLM calls and
  semantic judgments in one program, and for studying how such a system behaves
  as an agent edits it over time (transactions, history, rollback).

It is likely not worth it when a single prompt or a short script is enough, or
when there is no structure you would want to reuse, review, or reproduce.

## The REPL: a living, self-modifying harness

The REPL keeps a persistent DML module ("the harness"). You talk to it in two ways:

| Input | Mode |
|---|---|
| `<plain English>` (default) | **author** — the agent writes, tests, and commits DML |
| `/goal <dml>` | **run** — query the current harness |

```text
dml> add a research(Question, Answer) skill that answers with task/2 and cites sources
dml> run research on "why is the sky blue?"
A = "Rayleigh scattering scatters short wavelengths more strongly..."

dml> /goal research("why is the sky blue?", A).   % the same skill, run directly
```

The default mode is the interesting one: describe what you want and the
authoring agent edits the module for you through tools, testing as it goes. Ask
for anything — add a skill, add a tool, change existing logic, run or test code
in the living module, or just ask a question about the harness.

### Saving and re-loading a harness

Once you are happy with what your harness can do, you can save it for later re-use. A harness is a normal `.dml` file you can check in, diff, and re-open.

```text
dml> add a tally(List, Counts) skill and a demo
dml> /goal tally([a,b,a,c,a], C).
C = [a-3, b-1, c-1]

dml> /export tally.dml
exported 3 clauses, 0 tools, 0 scripts → tally.dml

dml> /halt
```

```bash
deepclause run tally.dml --goal 'tally([a,b,a], C)'   # run a goal from the file
deepclause repl -l tally.dml                          # or re-open it and keep building
dml> /goal tally([x,y,x], C).
C = [x-2, y-1]
```

`/export <file>` writes a portable `.dml`; use a `.zip` target to bundle linked
`script_file/2` scripts. `--export <file>` exports on exit, and exiting without
an export auto-saves the harness to a temp `.zip` bundle.

The REPL also records sessions, turns, and harness versions under
`.deepclause/repl/`, so you can pick a session back up later. Its harness,
conversation memory, and turn count are restored:

```bash
deepclause repl --session last          # resume the most recent session
deepclause repl --session repl_m9x1_1   # …or one by id
```

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
2. the authoring agent edits predicates with tools (`define`/`assert`/`assert_many`/
   `retract`/`delete`) and tests them with `execute`;
3. `end_turn` validates and commits the change, recording a version;
4. `rollback` — or a failed turn — restores the harness unchanged.

For anything larger than a couple of predicates the agent is instructed to commit
working pieces as it goes (`execute` → `end_turn` → `begin_turn`), so a late
failure does not lose earlier progress.

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

`/goal <dml>`, `/listing [filter]`, `/help`, `/reset`, `/rollback`,
`/compact [notes]`, `/export [file]`, `/model [id]`, `/freeze`/`/unfreeze`,
`/params`, `/trace`/`/notrace`, `/halt` (aliases `/exit`, `/quit`). The legacy
`goal:`/`listing.` dotted forms still work.

## Install

```bash
npm install deepclause-sdk
```

## Quick start

```bash
deepclause init                 # write .deepclause/config.json
deepclause login                # sign in to provider, then pick a model
deepclause repl                 # interactive
deepclause repl --session last  # resume the most recent session
deepclause run skill.dml "arg"  # one-shot
```

### Backends

`pi` is the default: it reuses pi's model catalog and credential store. `env`
uses the SDK's own provider/API keys.

```bash
deepclause login [--provider <id>] [--api-key <key>|--oauth] [--model provider/model] [--thinking <level>]
deepclause logout [provider]
deepclause set-backend status
deepclause set-backend env       # switch to provider API keys
```

For reasoning-capable models, `deepclause login`/`set-backend`/`set-model` prompt
for a thinking level (`off|minimal|low|medium|high|xhigh|max`); pass `--thinking`
to skip the picker. It is stored as `backend.thinkingLevel` and forwarded to pi
only for models that support it.

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

## visualize

Turn a harness into a diagram: `visualize` reads the harness `listing`
(source + `doc/2` annotations) and asks the active model for a Mermaid chart of
one entry, then renders it.

```bash
deepclause visualize skill.dml -g router/2 --presentation -o router.png
deepclause visualize skill.dml -g router/2 --spec -o router.spec.png
```

`-g/--goal` names the entry predicate to document. `--presentation` (default) is
an audience-facing overview (inputs, steps, answer); `--spec` shows engineering
detail (decisions, `task`/`exec` calls, branches, fallbacks). A `.mmd` output
writes the Mermaid source; a `.png`/`.svg` output renders it via
`@mermaid-js/mermaid-cli` (fetched with `npx` on first use) and always writes the
`.mmd` beside the image.

## Media (images)

Images are workspace files referenced by a `media(Path, Mime)` term; the bytes
never enter Prolog or conversation memory. Read a reference and attach it, and the
next `task/N` sends it to a vision-capable model:

```prolog
agent_main :-
    read_media("photos/fox.png", Image),
    attach_media(Image),
    task("Describe the image in one sentence.", Description),
    answer(Description).
```

Only PNG/JPEG/GIF/WebP are accepted, and judgments stay text-only. Image
generation and video are not implemented — see [`docs/DML_MEDIA.md`](docs/DML_MEDIA.md).

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
    "tui": "auto",
    "authoring": "agent",
    "agentDocs": "embed",
    "maxModelCalls": 100,
    "compaction": { "enabled": true, "auto": true },
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

Bundled prompt assets: `AGENT_PROMPT.md` (the authoring agent's contract),
`META_PROMPT.md` (the legacy meta task contract), `DML_REFERENCE.md` (language),
`DML_AUTHORING.md` (guide), `HARNESS_EXAMPLES.md` (idiomatic shapes),
`PROLOG_SNIPPETS.md` (tested building blocks).

## Development

```bash
npm run build     # tsc + copy prolog + assets
npm test          # vitest
npm run repl      # deepclause repl via tsx
```

See [`docs/`](docs/): [`STATUS.md`](docs/STATUS.md) (current state),
[`REPL.md`](docs/REPL.md),
[`DML_REPL_PROPOSAL.md`](docs/DML_REPL_PROPOSAL.md),
[`DML_REPL_SESSION_HISTORY.md`](docs/DML_REPL_SESSION_HISTORY.md),
[`JUDGMENT_BACKENDS.md`](docs/JUDGMENT_BACKENDS.md).

## License

MIT
