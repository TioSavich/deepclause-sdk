# The DML REPL

`deepclause repl` is an interactive session that starts with a blank in-memory
DML module and lets you grow a *living harness* — either by running DML goals
directly or by describing what you want in plain English and letting the model
write the DML.

Design reference: [`docs/DML_REPL_PROPOSAL.md`](./DML_REPL_PROPOSAL.md).
Implementation plan: [`docs/DML_REPL_IMPLEMENTATION_PLAN.md`](./DML_REPL_IMPLEMENTATION_PLAN.md).

## Quick start

```bash
# One-shot goal (like `swipl -g`)
deepclause repl -g "member(X, [1,2,3])"

# Load a harness, freeze it, run one entry, exit
deepclause repl -l harness.dml -f -g "explain_factorial"

# Scripted session over stdin
printf 'goal: fact(5, F).\nlisting.\nhalt.\n' | deepclause repl -l fact.dml --no-ask

# Interactive
deepclause repl
```

`deepclause-repl` is a thin alias for `deepclause repl`.

## Two input modes

The classifier is intentionally trivial and unambiguous:

| Input | Mode |
|---|---|
| `goal: member(X, [a,b,c]).` | **goal mode** — run the DML goal |
| `goal: fact(5, F).` | goal mode |
| `add a rule that computes factorial` | **prompt mode** — English → DML |
| anything else | prompt mode |

DML input always carries the explicit `goal:` marker. A `goal:` line whose
payload fails to parse is reported as a syntax error — it is never silently
treated as a prompt.

A small set of whole-line commands is matched before the classifier:

| Command | Effect |
|---|---|
| `halt.` | exit |
| `help.` | help |
| `listing.` / `listing(Name/Arity).` | list the living module |
| `reset.` | empty the harness (refused when frozen) |
| `rollback.` | undo the last harness change (requires history) |
| `model.` / `model <provider/id>.` | show / set the default model |
| `export <file>.` | write a self-contained `.dml` harness |
| `freeze.` / `unfreeze.` | read-only lock |
| `trace.` / `notrace.` | toggle verbose logging |
| `params.` | show session parameters |

## What a harness is

A harness is a **living library of reusable DML skills** for the workspace, not
a single program. A skill is a predicate; the ones a user should call are
named descriptively and run with the meta task's `execute` tool or `goal:`. Skills compose:

- **helper predicates** (plain Prolog/CLP),
- **semantic judgments** (`choose`/`rate`/`verify`/`probability`),
- **host tools** via `exec/2`, and
- **model calls** via `task/N` — a bounded agentic turn that may itself invoke
  other skills.

Because the module is a live Prolog program, **data = code**: small/medium
structured data belongs in it as facts (`country(ch, "Switzerland").`),
inspected and queried exactly like predicates via `listing`, `goal:`, and
`execute`. Keep large datasets in a file or a linked script rather than bloating
the module.

A harness may also carry **test predicates** that pin the intended behavior of a
skill (for example `test_<name>`, or a small `check/2` runner). When a skill is
changed, its test is updated or added and run, so the change is verified rather
than assumed.

The meta task therefore treats the module like a codebase: it **reuses and
composes** existing skills rather than duplicating them, and it **changes the
harness only when the request asks for it**. On a fresh workspace it creates
what was requested; on an existing harness it changes only what the request
requires (a plain question changes nothing). A frozen harness is a live agent
that simply cannot be modified.

## Goal mode

```text
dml> goal: member(X, [a, b, c]).
X = a ;
X = b ;
X = c.
```

Each solution is rendered as `Name = value`; unbound variables show as `_`.
The pager accepts `;` (next), `.` (stop), and `a` (all). Use `--first` to print
only the first solution.

## Prompt mode

```text
dml> add a rule that computes factorial and a tool that formats integers

meta │ Let me list the harness first.
meta │   ⚙ listing(filter=all)
meta │ I'll test it with execute, then commit fact/2.
120
committed fact/2, demo/0
```

A prompt is an **edit transaction**:

1. the living module, tool bookkeeping, and harness memory are snapshotted;
2. a `task_named/3` **meta task** runs in a `meta` frame, restricted to exactly
   the host meta tools (`listing`, `assert`, `retract`, `execute`, `ask_user`);
3. the scratch edits are discarded (a failed prompt leaves the harness
   unchanged);
4. the returned DML source is validated and committed **replace-by-predicate**
   (every predicate it defines is replaced);
5. the declared entry is run; if none is declared, the commit is load-only.

If the model returns invalid DML, the REPL makes one repair attempt with the
parse error, then aborts without touching the harness.

### Cancelling a turn

Press **Ctrl-C** while a turn is running to abort it. The turn stays
transactional: the harness is restored to its last committed state, and the
*current* module (including any scratch `assert`/`execute` edits) is written to
a temp `.dml` file so nothing is lost:

```text
^C
(cancelling current turn… press Ctrl-C again to exit)
ERROR: turn aborted; current harness saved to /tmp/deepclause-repl-<id>-<ts>.dml
```

Load that file with `deepclause repl -l <file>` to resume. The same applies to
`goal:` queries and `-g` runs.

### Saving on exit

When you leave the REPL — `halt.`, **Ctrl-D**, or **Ctrl-C** while idle — the
harness (module + linked scripts, as a `.zip` bundle) is written to a temp file
and the path is printed, so the work is preserved:

```text
dml> halt.
harness saved to /tmp/deepclause-repl-<id>-<ts>.zip
```

It is skipped when the harness has no predicates, when `--export <file>` was
given, or with `--no-save-on-exit`. Reload a bundle with
`deepclause repl -l <file>.zip`.

A meta task that ends **without producing DML** — iteration cap, exhausted
model-call budget, or a model error — is treated the same way: the transaction
is discarded, the scratch module + linked scripts are written to a temp bundle,
and the error reports the path, e.g.
`ERROR: the meta task returned no DML source or answer (current harness saved to /tmp/deepclause-repl-….zip)`.
So a long debugging turn is never lost even when the turn itself fails.

### Authoring agent (default)

`repl.authoring` selects how plain-English requests are authored:

* **`agent`** (default): a normal TypeScript agent with a system prompt and
  harness tools. It edits the live harness through `listing` / `define` /
  `assert` / `assert_many` / `retract` / `delete`, tests with `execute`, and
  commits with `end_turn` (or discards with `rollback`). The host snapshots at
  the start of each request and auto-commits if the run ends without an explicit
  `end_turn`. It can run several committed turns in one request.
* **`meta`** (legacy): the DML `task_named/3` meta frame described below.

Set it in `.deepclause/config.json` under `repl` or with `--authoring <kind>`:

```bash
deepclause repl --authoring agent   # default
deepclause repl --authoring meta    # legacy
```

#### Steering a running turn

While a turn is running you can keep typing. Submitting a line **steers** the
running agent (pi-style): the message is injected before the next model call,
and an in-flight model call is interrupted so the agent sees it immediately. The
status bar shows `running (type to steer)`, and the message is echoed as a
magenta `» …` line. (While an `ask_user`/`input/2` prompt is open, submitting
answers that prompt instead.)

#### Workspace `AGENTS.md`

If the working directory contains an `AGENTS.md`, its contents are appended to
the agent's system prompt under `PROJECT INSTRUCTIONS (AGENTS.md)`, so
repo-specific rules apply automatically. The startup banner shows
`project context AGENTS.md (N bytes)` when one is loaded.

#### Customizing the system prompt

The agent's system prompt is assembled from the bundled
`src/system/assets/docs/AGENT_PROMPT.md` plus generated sections:
`{{CATALOG}}` (the host tool catalog), `{{TOOLS}}` (the tool schemas),
`{{MANIFEST}}` (the live harness manifest), and — by default — `{{REFERENCE}}`
and `{{AUTHORING}}` (the DML language reference and authoring guide).

`repl.agentDocs` controls the last two:

* **`embed`** (default) injects the full DML reference and authoring guide into the
  system prompt, so the agent always has them.
* **`tool`** leaves them out and relies on the `reference(topic)` tool; the prompt
  is much smaller but the agent only sees the docs if it asks for them.

Set it with `--agent-docs embed|tool` or under `repl` in the config.

To override the prompt itself **without rebuilding the SDK**, create
`.deepclause/system/AGENT_PROMPT.md` in the workspace; the runtime prefers it
over the bundled file. It is an opt-in override (it is never seeded), so
upgrading the SDK keeps the bundled prompt current for everyone who has not
created one. The override must contain the same `{{CATALOG}}`, `{{TOOLS}}`, and
`{{MANIFEST}}` placeholders for those sections to appear.

To change the built-in prompt itself, edit
`src/system/assets/docs/AGENT_PROMPT.md` and run `npm run build`.

### Meta tools and guard rails

The code-writing meta task is restricted to `listing`, `assert`, `assert_many`,
`retract`, `execute`, `read_file`, `write_file`, `list_files`, `delete_file`,
`ask_user`, plus the capability host tools (**`bash`** by default). The meta
prompt embeds the full bundled `DML_REFERENCE.md`, a curated set of **idiomatic
harness patterns** (a `tool/2` wrapping `exec(bash(...))` + a `task(...)` chain
+ a script file linked with `script_file/2`; a
`task → task → output/answer` pipeline), the live host tool catalog, and the
current harness manifest. It also states the catalog pairing rule explicitly:
**only the `exec(...)` names in the catalog exist — by default just `bash`** —
so it never invents `calculator`/`fetch_url`/`web_search`/`vm_exec`. The rules
that matter most:

* **Read before writing** — call `listing` first.
* **Clause order matters** — a base case must precede a recursive rule. Define a
  predicate with `assert_many`, which asserts a whole block in the written
  order, rather than one clause at a time.
* **Verify** — call `listing(Name/Arity)` after changing a predicate.
* **Bounded iteration** — no unbounded loops/assert/execute; use finite
  recursion, CLP(FD)/CLP(Q), or an explicit bound. `execute` is gas-limited and
  the turn has a model-call budget.

`ask_user` / `input/2` prompt on a clearly separated pane and read through the
REPL's own input line (no second readline, so no character echo and no lost
input):

```text
dml> ask me for my name
meta │ ⠋ meta task (writing the harness)
? What is your name?
> Andreas
meta │   ✔ ask_user(prompt=What is your name?) — Andreas
```

### Direct questions

For a simple question that can be answered directly — "what did we just do?",
"what can you do?", "how do I …?" — the meta task answers **without touching
the harness**: instead of returning DML, it sets the `Answer` output to its
reply. The reply is rendered as an `output` line and the living module is left
byte-identical. Build/commit only happens when the request asks you to create,
change, or run logic.

```text
dml> what can you do?
I'm the DeepClause REPL harness author. I grow and maintain a living DML module …
dml> listing.
% (empty harness)
```

### Entry points

There is **no `agent_main` requirement** in the REPL. Name predicates
descriptively and run any of them directly with `goal: <name>(…)`:

```prolog
weekly_report :-
    gather_data(Rows),
    summarize(Rows, Summary),
    answer(Summary).
```

Running is the meta task's job: while authoring a turn it calls the `execute`
tool to run and verify a goal; a commit only changes the module (nothing is
auto-run). If the same file should also run with `deepclause run` / `/dc-run`,
define `agent_main` in the harness.

### Self-containment and bundles

The harness is the `.dml` **plus the files it links**. Write each program to a
file (the meta task has `write_file`/`read_file` tools), link it with a
`script_file/2` fact, and run it with `exec(bash(...))`:

```prolog
script_file(url_reader, ".dc-repl/scripts/url_reader.py").

tool(url_text(Url, Text), "Fetch a URL and strip HTML.") :-
    script_file(url_reader, Script),
    write_file(".dc-tmp/url.txt", Url),
    format(atom(Cmd), "python3 '~w' '.dc-tmp/url.txt'", [Script]),
    exec(bash(command: Cmd), Result),
    get_dict(stdout, Result, Text).
```

The untrusted URL is passed through a file rather than interpolated into the
shell command. `script_file/2` has no runtime semantics — it tells the exporter
which files belong to the harness. `write_file` lands on disk immediately, so
the meta task can run a script with `bash` in the same turn.

`export harness.zip` writes the self-contained bundle (`harness.dml` + every
linked file + a manifest); `-l harness.zip` extracts and loads it.
`export harness.dml` auto-inlines the linked files as `embedded_file/2` facts so
a single file stays portable. See
[`DML_REPL_SCRIPT_BUNDLES.md`](./DML_REPL_SCRIPT_BUNDLES.md).

## Memory: two levels

| Memory | Used by | Contents |
|---|---|---|
| **Harness memory** | object-level `task` predicates and the committed entry run | the harness's runtime conversation |
| **Meta memory** | the code-writing meta task | recent prompts and outcomes |

Keeping them apart is a core design decision: the model writing code does not
accumulate the harness's runtime conversation, and the harness runtime never
contains code-review chatter. The agent loop passes the meta memory as the
model's conversation history, so the author sees its own previous requests and
outcomes.

Meta memory is a **clean `messages[]`**: each successful turn records exactly
`user: <your raw request>` and `assistant: <outcome + the predicates that were
committed>`. The assembled meta prompt (authoring contract, reference, catalog,
manifest) is **ephemeral** — it is the agent loop's current task text, not
persisted. `execute` sees a snapshot of harness memory so it can test with
realistic context; those writes are discarded at commit. The entry run is the
only place harness memory advances.

## History

Every session, turn, event trace, and harness version is persisted under
`.deepclause/repl/` (configurable via `repl.history`). The durable links live in
the harness itself as `harness_*` facts, so a skill can query what happened
before:

```prolog
recent(N, Cs) :-
    findall(V-Ts-E, harness_change(V, Ts, commit, _, _, E), All),
    last_n(All, N, Cs).
```

`harness_session/5`, `harness_session_end/2`, `harness_turn/5`,
`harness_change/6`, `harness_changed/4`, `harness_head/4`,
`harness_rollback/5`, and `harness_trace/3` are system-owned: queryable from
DML, but never committed, exported, or listed as harness predicates
(`listing(history)` shows a tail). A new session loads the persisted
`history.dml` at startup. See
[`DML_REPL_SESSION_HISTORY.md`](./DML_REPL_SESSION_HISTORY.md). Set
`repl.history.enabled: false` (or omit `history` when embedding) to disable it.

`rollback.` restores the previous version (moving `harness_head` back one), so
repeating it walks the harness history backwards; it is refused when frozen and
reports `no harness changes to roll back` when there is nothing to undo.

## Export, freeze, and `-l`

**`export`** serializes the living module into a self-contained, human-readable
`.dml` file: directives first, then tools, then embedded scripts, then user
predicates sorted by `name/arity`. Exported files are deterministic
(variables number as `A`, `B`, …) so `export → load → export` is byte-stable.

**`freeze`** is a runtime read-only lock, not a serializer. When frozen:

* `assert`/`retract`, `consult`/`[file]`, prompt commits, and `reset` are
  refused;
* read-only goals and `execute` (including nested `task` calls) keep working, so
  a frozen harness is still a live agent — just immutable.

`-f`/`--freeze` starts frozen; `--locked` additionally forbids `unfreeze.`.
`-l file` loads a DML file (repeatable) before the loop or `-g`.

Freeze is an **integrity lock, not a sandbox**. It prevents mutation of the
in-memory module; it does not stop `bash` from writing files in the workspace.

## Asking the human

Both levels share one input channel:

* the meta task may call `ask_user` to resolve an ambiguity before writing;
* the harness may call `input/2` or `exec(ask_user(prompt: …))` while running.

In an interactive TTY the question is prompted. In non-interactive runs (`-g`,
piped stdin, CI) the meta `ask_user` returns `cancelled` and `input/2` fails
instead of blocking; `--no-ask` fails immediately, and `--answer "…"` supplies a
canned reply. `ask_user` is exempt from the capability tool policy: it only
relays a question to the human.

## Backends

The **`pi` backend is the default**. It does not run an LLM of its own: it
borrows pi's **model catalog and credential store**.
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are regular
dependencies of the SDK, so **no global `pi` install is needed** — a globally
installed `pi` is deliberately ignored so the version is deterministic. The
`env` backend (the SDK's own provider/API-key path) is still supported.

```bash
# Sign in (the terminal port of pi's /login) and pick a default model.
deepclause login
deepclause login --provider anthropic                 # skip the provider picker
deepclause login --provider openai --api-key sk-…      # non-interactive API key
deepclause login --model anthropic/claude-sonnet-4     # skip the model picker
deepclause login --no-model                            # authenticate only

deepclause logout [provider]                           # pi's /logout

# Inspect / switch:
deepclause set-backend status
deepclause set-backend pi --list [--json]              # providers + chat models
deepclause set-backend env                             # SDK provider/API-key backend
```

Login flow (`deepclause login`, `set-backend pi`):

1. **Provider picker.** The readline picker filters instead of listing the whole
   catalog; entries show the auth method (API key / OAuth/subscription) and
   whether the provider is already configured.
2. **Auth method.** Chosen automatically when a provider offers only one; a
   short prompt picks between API key and OAuth/subscription otherwise.
3. **pi login.** pi's own flow runs (API-key prompt, OAuth URL, or device code)
   and stores the credential through pi (`~/.pi/agent/auth.json` by default;
   `backend.agentDir` overrides it).
4. **Model picker.** Always shown (unless `--model`/`--no-model`), filtered by
   the picker; the choice is written to `.deepclause/config.json` under
   `backend` (`kind`, `model`, `agentDir`, `modelsPath`, `authPath`).

With `backend = pi`, the REPL never asks for API keys, never writes provider
environment variables, and never guesses a provider. `deepclause login --json`
is available for scripted use.

### Judgment backends

Semantic judgments (`judge/2`, `choose/4`, `rate/4`, `verify/3`,
`probability/3`, `holds/2,3`) answer bounded, typed questions about an explicit
state and never read or write conversation memory. The REPL registers two
backends:

- **`llm`** (default): reuses the active model and backend — the pi model and
  credentials when `backend = pi`, otherwise the configured provider.
- **`jev`** (TypeSafe System One): opt-in, because it is a separate service.
  Enable it and provide its key:

```json
"judgment": {
  "default": "llm",
  "jev": { "enabled": false, "model": "jev-latest", "apiKeyEnv": "TYPESAFE_API_KEY" }
}
```

`--judge <name>` (or `judgment.default`) selects the default backend. If the
chosen backend is not registered the REPL fails at startup with a clear error;
if `jev` is enabled but its key is missing the REPL warns and uses `llm`.
`require_judgment(Capability, Goal)` gates a goal on backend capabilities
(`calibrated`, `probability`, `confidence`, `independentQuestions`).

## Host tools

The default capability host tool is exactly **`bash`**, registered through the
SDK's shell manager with the configured sandbox. `--tools a,b` or
`--no-tools` change the set; MCP servers contribute their own tools when
configured. **File reading and writing are DML language, not host tools** — use
`open/3`, `close/1`, `read_string/3`, `write/2`, `write_file/2`, `read_file/2`,
`append_file/2` (paths resolve under the workspace).

`bash` runs in the workspace shell, or a sandbox (`--sandbox` uses the AgentVM;
`agentvm.network` controls networking). The meta task may explore that
environment and install a dependency when a skill genuinely needs one — installs
are sandbox/session-local and do **not** travel with an exported harness, so
prefer the standard library.

The meta prompt carries the live host tool catalog, and `listing(tools)`
returns it, so generated `exec(...)` calls use real names and argument shapes.

## CLI reference

```text
deepclause repl [options]

  -g, --goal <goal>        run one goal and exit (repeatable)
  -l, --load <file>        load a DML file before starting (repeatable)
  -f, --freeze             start frozen (read-only lock)
      --locked             like -f, but forbid unfreeze.
      --export <file>      export the harness on exit
      --first              with -g, print only the first solution
      --plain              no TUI formatting (auto when stdout is not a TTY)
      --json               emit results as JSON lines
      --workspace <path>   workspace root (default ./)
      --backend <kind>     override the configured backend (env|pi)
      --judge <name>       default judgment backend (llm|jev)
      --model <model>      override the configured run model
      --provider <provider>
      --temperature <n>
      --sandbox            run shell tools in AgentVM
      --tools <list>       capability host tools (default: bash)
      --no-tools           register no capability host tools
      --no-ask             make ask_user / input/2 fail instead of prompting
      --answer <text>      canned answer for any input request
      --interactive-input  allow input requests in non-TTY/--json mode
      --gas-limit <n>      per-frame step limit
      --depth <n>          maximum nested frame depth (default 3)
      --max-model-calls <n> maximum model calls per turn (default 100; 0 = unlimited)
      --param key=value    session parameter (repeatable)
      --verbose / --debug
      --no-color
```

### `--json`

In JSON mode each runtime event is emitted as one JSON object:

```json
{"type":"stream","content":"Let me look at the harness."}
{"type":"tool_call","toolName":"listing","toolArgs":{"filter":"all"}}
{"type":"solution","solution":{"bindings":[{"name":"F","value":"120"}],"deterministic":false}}
{"type":"answer","content":"120"}
```

### Budgets

A prompt turn is bounded by `--max-model-calls` (default 100) and `--depth`
(default 3 nested frames). When the model-call budget is exhausted the turn
aborts with `ERROR: model-call budget exhausted for this turn`, the harness is
left unchanged, and the counter resets on the next prompt.

```bash
deepclause repl --max-model-calls 100        # raise it for a turn
deepclause repl --max-model-calls 0          # unlimited
```

Or persistently in `.deepclause/config.json` (`0` = unlimited):

```json
"repl": { "maxModelCalls": 100 }
```

### Scripted sessions

```bash
cat prompts.txt | deepclause repl -l seed.dml --export out.dml --no-ask
```

In non-TTY mode input is read line by line until EOF; `ask_user`/`input` never
block.

## Configuration

```json
"repl": {
  "exportOnExit": false,
  "exportPath": "harness.dml",
  "frozen": false,
  "locked": false,
  "editMode": "transactional",
  "maxDepth": 3,
  "maxModelCalls": 100,
  "writeDepth": 20,
  "repairRounds": 1,
  "promptPrefix": "dml> ",
  "tui": "auto",
  "authoring": "agent",
  "agentDocs": "embed",
  "render": "rich",
  "showReasoning": "summary",
  "showToolArgs": true,
  "maxToolResultChars": 2000,
  "color": true,
  "tools": null,
  "compaction": {
    "enabled": true,
    "auto": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "history": {
    "enabled": true,
    "dir": ".deepclause/repl",
    "trace": "summary",
    "maxEventBytes": 8192,
    "maxSessions": 50,
    "maxVersions": 200,
    "includeInExport": false
  }
},
"judgment": {
  "default": "llm",
  "jev": { "enabled": false, "model": "jev-latest", "apiKeyEnv": "TYPESAFE_API_KEY" }
}
```

## Embedding

```ts
import { createHarnessRepl } from 'deepclause-sdk';

const repl = await createHarnessRepl({ model: 'gpt-4o', provider: 'openai' });
for await (const event of repl.query('fact(5, F)')) {
  if (event.type === 'solution') console.log(event.solution?.bindings);
}
await repl.dispose();

// Judgment: an `llm` backend is built from the injected LLMBackend; pass
// `judgeSelection` to register custom/`jev` backends, or `jev: { enabled, apiKey }`.
```

The SDK also exports `DMLSession`, `createPiBackend`/`createPiAdapter`,
`createReplToolset`/`buildToolCatalog`, and the export helpers for embedding.

## Self-hosting demo

A harness whose only tooling is a linked script file survives a clean
workspace, because the file travels inside the bundle:

```bash
# 1. Author a harness whose program is a linked file.
mkdir -p .dc-repl/scripts
printf 'the script file ran\n' > .dc-repl/scripts/writer.sh
cat > seed.dml <<'DML'
script_file(writer, ".dc-repl/scripts/writer.sh").
run_writer :-
    script_file(writer, Script),
    format(atom(Cmd), "sh '~w'", [Script]),
    exec(bash(command: Cmd), R),
    get_dict(stdout, R, Out),
    output(Out).
DML

# 2. Export the self-contained bundle.
deepclause repl -l seed.dml --export harness.zip --no-ask -g "true"

# 3. Clean the workspace and run from the bundle.
rm -rf .dc-repl seed.dml
deepclause repl -l harness.zip -f -g "run_writer"
```

The second run prints the script's output even though `.dc-repl/` and `seed.dml`
are gone: `export` bundled the linked file, and `freeze` guarantees the loaded
harness cannot rewrite itself.

The equivalent automated round-trip lives in
`tests/repl-freeze-export.test.ts` (script-file bundle round-trip).
