# DeepClause SDK

DeepClause is a neuro-symbolic runtime: DML (a Prolog dialect with LLM calls)
merged with the DeepSeek/agent tooling. It gives you a **REPL** for growing a
living DML harness, a one-shot **`run`** for executing a DML file, and a
**TypeScript SDK** for embedding the runtime.

Three things only: **repl**, **run**, **TS SDK**.

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
deepclause init                 # writes .deepclause/config.json
deepclause login                # sign in via pi, then pick a default model
deepclause repl                 # interactive
deepclause run skill.dml "arg"  # one-shot
```

### Backends

`pi` is the default backend; it reuses pi's model catalog and credential store.
`env` uses the SDK's own provider/API keys.

```bash
deepclause login [--provider <id>] [--api-key <key>|--oauth] [--model provider/model]
deepclause logout [provider]
deepclause set-backend status
deepclause set-backend env       # switch to provider API keys
```

Credentials live in pi's agent dir (`~/.pi/agent`) unless `backend.agentDir`
overrides it.

## REPL

A persistent "living module". Two input modes:

```
dml> goal: member(X, [a, b, c]).          # run a goal
dml> add a rule that computes factorial   # English -> DML -> commit -> run
```

Out-of-band commands: `halt.`, `help.`, `listing.`, `reset.`, `rollback.`,
`export <file>.`, `freeze.`/`unfreeze.`, `model.`/`model <provider/id>.`,
`trace.`/`notrace.`, `params.`.

A prompt is an **edit transaction**: the module is snapshotted, a meta task
writes DML, the result is committed replace-by-predicate, and the declared entry
runs. File writes land on disk immediately so `bash` can run scripts in the same
turn.

### History

Sessions, traces, and harness versions are recorded under `.deepclause/repl/`
(`repl.history`) and exposed to DML as `harness_*` facts, so a harness can query
what happened before:

- `harness_session/5`, `harness_session_end/2`
- `harness_turn/5`, `harness_trace/3`
- `harness_change/6`, `harness_changed/4`, `harness_head/4`, `harness_rollback/5`

`rollback.` restores the previous harness version (step by step). See
[`docs/DML_REPL_SESSION_HISTORY.md`](docs/DML_REPL_SESSION_HISTORY.md).

## run

```bash
deepclause run <file.dml> [args...] [--param key=value] [--backend pi|env]
deepclause run <file.dml> --dry-run
deepclause run <file.dml> --trace trace.json --usage usage.json [--json]
```

`run` executes a DML file once using the same backend resolver and the same
event renderer as the REPL.

## TypeScript SDK

```ts
import { createDeepClause } from 'deepclause-sdk';

const dc = await createDeepClause({ model: 'gpt-4o', provider: 'openai' });

for await (const event of dc.runDML(dmlSource, { args: ['topic'] })) {
  if (event.type === 'answer') console.log(event.answer ?? event.content);
}

await dc.dispose();
```

To reuse pi's model/credentials from a host, pass an injected `LLMBackend`
(`createPiBackend`) and judgment backends (`createLLMJudgeBackend`,
`createJevJudgeBackend`); `createDeepClause` accepts both.

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

`deepclause-sdk/compiler` remains as a thin alias exporting `validateWithProlog`
(the Markdown→DML compiler was removed).

## Configuration

`.deepclause/config.json` (created by `init`):

```json
{
  "backend": { "kind": "pi", "model": "anthropic/claude-sonnet-4" },
  "models": { "gateway": "...", "run": "..." },
  "temperatures": { "gateway": 0.2, "run": 0.7 },
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

```
src/
├── repl/         # the living-module REPL (session, frames, renderer, auth, history)
├── cli/          # init, run, repl, login, set-backend
├── system/       # runtime (shell, AgentVM, compactors), config, bundled docs
├── judge/        # semantic judgment backends (llm, jev, mock)
├── prolog/       # SWI-Prolog-WASM loader/bridge
├── prolog-src/   # deepclause_mi.pl, deepclause_analysis.pl, …
├── agent.ts      # task/agent loop
├── runner.ts     # DML execution
├── sdk.ts        # createDeepClause
└── validate.ts   # DML validation/linting
```

Bundled docs (also seeded into `.deepclause/docs/`): `DML_REFERENCE.md`,
`DML_AUTHORING.md`, and the task-loop prompt.

## Development

```bash
npm run build     # tsc + copy prolog + assets
npm test          # vitest
npm run repl      # deepclause repl via tsx
```

See [`docs/`](docs/) for the design docs:
[`REPL.md`](docs/REPL.md),
[`DML_REPL_PROPOSAL.md`](docs/DML_REPL_PROPOSAL.md),
[`DML_REPL_SESSION_HISTORY.md`](docs/DML_REPL_SESSION_HISTORY.md),
[`REFACTOR_CLEANUP.md`](docs/REFACTOR_CLEANUP.md).

## License

MIT
