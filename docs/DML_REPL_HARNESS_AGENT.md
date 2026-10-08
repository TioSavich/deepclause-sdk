# Plan — move the REPL authoring agent out of DML

Status: **implemented (P1)** · Scope: `deepclause-sdk` REPL

> P1 is implemented and P2 is complete: the TypeScript agent is the only
> authoring path and the DML meta-frame implementation has been removed.
> New files: `src/repl/agent.ts`, `src/repl/harness-tools.ts`,
> `src/system/assets/docs/AGENT_PROMPT.md`.
> Tests: `tests/repl-agent.test.ts`, `tests/repl-agent-session.test.ts`.

## Motivation

Today the REPL's main agent is a DML `task_named/3` running in a `meta` frame.
That buys transactionality, memory isolation, and tool containment, but it also
forces the authoring agent through the Prolog meta-interpreter, the frame stack,
the `META_PROMPT.md` placeholder assembly, `repl_run_meta`/`repl_meta_solve`,
`session_meta_memory`, and a typed `DMLCode`/`Answer` output contract. All of
that machinery has exactly one consumer: the authoring agent.

The proposal is to make the authoring agent a **normal TypeScript agent** with a
system prompt and harness tools, and let it run multiple turns in a loop until a
goal is reached. This also converges the SDK REPL with the direction in the
top-level `AGENTS.md` ("Pi authors and edits DML using its normal coding
abilities", "no Markdown→DML compiler").

## Goals

- The authoring agent is a regular `LLMBackend` agent loop with a system prompt.
- It works on the harness through tools (`begin_turn`, `end_turn`, `rollback`,
  `listing`, `define`, `assert`, `retract`, `delete`, `execute`, `ask_user`,
  `reference`). It has no file or shell tools: file I/O goes through DML or `bash`.
- It can run several committed turns in one request until the goal is met.
- The DML runtime is unchanged: DML-internal `task/N` still uses frames and the
  meta-interpreter.
- The existing meta path stays available (`authoring: 'meta'`) during migration.

## Non-goals

- Removing the DML `task/N` agent loop or the frame stack.
- Changing export, freeze, rollback, or history formats beyond adding fields.

## Architecture

```
CLI / config (repl.authoring)                    src/cli/repl.ts, src/cli/config.ts
        │
        ▼
HarnessRepl.prompt  ──►  DMLSession.prompt        src/repl/index.ts, session.ts
        │                 authoring === 'agent' ?
        │ yes
        ▼
HarnessAgent.run(request)                        src/repl/agent.ts
        │   runAgentLoop-style loop over LLMBackend
        │   system prompt + tools
        ▼
HarnessToolController (implemented by DMLSession) src/repl/harness-tools.ts
        │
        ▼
repl_snapshot_* / repl_assert / repl_define / repl_commit / repl_execute_frame
```

### System prompt

Built in `src/repl/agent.ts` from a new `AGENT_PROMPT.md` asset (derived from
`META_PROMPT.md`, with the output contract replaced by the tool workflow) plus:
`{{TOOLS}}` (generated from the tool schemas), `{{MANIFEST}}` (dynamic), and the
DML reference/authoring/examples/snippets (or behind a `reference(topic)` tool
later). The user request is the user message, so `{{MEMORY}}` is not needed —
the agent's own conversation is the history.

### Turn / transaction semantics

- `DMLSession` snapshots at the start of each `agentPrompt` run.
- Edit tools mutate the live (scratch) module.
- `end_turn` commits: validate the touched predicates, record a history version,
  and clear the open transaction. It returns `{ committed, changed }`.
- `rollback` restores the start-of-run snapshot and discards edits.
- `begin_turn` starts a fresh transaction (snapshot again) so several committed
  turns can happen in one run.
- If the run ends with uncommitted edits and no `rollback`, the host nudges the
  agent to `end_turn`/`rollback`; if it still doesn't, the host commits as a
  last resort.
- A failed run rolls back.

### Tools

`finish` (agent loop) plus:

| Tool | Purpose |
|---|---|
| `begin_turn` | snapshot and open a transaction |
| `end_turn` | validate + commit the transaction, record a version |
| `rollback` | restore the last snapshot |
| `listing` | read the harness (`all` / `Name/Arity` / `tools`) |
| `define` | replace a predicate (retractall + assert) |
| `assert` / `assert_many` | add clauses (assert is new-predicate-only) |
| `retract` | remove a clause/predicate |
| `delete` | delete a predicate by `Name/Arity` |
| `execute` | run a DML goal against the scratch harness (also how files are written) |
| `ask_user` | ask the human |
| `reference` | DML reference / authoring / patterns / examples / snippets |

## Files

- **new** `src/repl/harness-tools.ts` — `HarnessToolController` interface and
  `createHarnessTools`.
- **new** `src/repl/agent.ts` — `HarnessAgent`, `buildAgentSystemPrompt`, the
  agent loop (reuses `LLMBackend`, `compaction`, media resolution).
- **new** `src/system/assets/docs/AGENT_PROMPT.md` — agent system prompt.
- `src/system/assets/index.ts` — `getAgentPromptAssetPath`.
- `src/repl/session.ts` — implement `HarnessToolController`; `agentMessages`;
  `agentPrompt`; history/persistence fields; `authoring` selection.
- `src/repl/index.ts` — `HarnessReplOptions.authoring`.
- `src/cli/repl.ts` — pass `authoring`; `--authoring` flag.
- `src/repl/history.ts` — `SessionHarnessSnapshot.memory.agent`.
- Tests: `tests/repl-agent-tools.test.ts`, `tests/repl-agent.test.ts`, plus a
  session-level transactional test.

## Migration

- **P1** — implement `agent` behind `authoring` (default `meta` in the library,
  `agent` via CLI config). All existing tests stay green.
- **P2** — make `agent` the library default; keep `meta` for one release.
- **P3** — delete the meta-frame authoring path and add the goal-loop command.

## Risks

1. **Resume fidelity** — the agent's conversation must be persisted/restored.
2. **Runaway loops** — outer turn/model-call budgets and a stopping condition.
3. **Drift** — `end_turn` validation + `execute` tests replace the "return the
   complete corrected program" constraint.
4. **Duplicate clauses** — predicate-level `define`/`delete`; `assert` only for
   new predicates.
5. **Two authoring paths** — a config flag, covered by tests for both.
