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
| `export <file>.` | write a self-contained `.dml` harness |
| `freeze.` / `unfreeze.` | read-only lock |
| `trace.` / `notrace.` | toggle verbose logging |
| `params.` | show session parameters |

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
meta │ I'll commit fact/2 and repl_entry/1.
committed … and ran the declared entry
120
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

Load that file with `deepclause repl -l <file>` to resume. Ctrl-C while idle
exits the REPL. The same applies to `goal:` queries and `-g` runs.

### Meta tools and guard rails

The code-writing meta task is restricted to `listing`, `assert`, `assert_many`,
`retract`, `execute`, and `ask_user`. The meta prompt embeds the full bundled
`DML_REFERENCE.md`, the live host tool catalog, and the current harness manifest,
and it states the rules that matter most:

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
descriptively and declare the default entry with `repl_entry/1`:

```prolog
repl_entry(weekly_report).
weekly_report :-
    gather_data(Rows),
    summarize(Rows, Summary),
    answer(Summary).
```

The meta task may also return an `EntryGoal`. Users can always call any
predicate directly with `goal: <name>(…)`. `export --skill` adds a thin
`agent_main/0` wrapper when you need to run the same file with
`deepclause run` / `/dc-run`.

### Self-containment

The harness is the `.dml` file. If a generated tool needs Python, JavaScript,
shell, or SQL, the **entire program** is stored in the harness as a string fact
(`script_body/2`, `python_source/2`, `js_source/2`, `shell_source/2`) and
materialized at run time with the MI's `write_file/2`. Never leave it only as a
side file: `export` captures the module, not stray files.

```prolog
script_body(url_reader, "\
import sys, urllib.request, re\n\
url = open(sys.argv[1]).read().strip()\n\
html = urllib.request.urlopen(url).read().decode('utf-8', 'replace')\n\
print(re.sub(r'<[^>]+>', ' ', html))\n").

tool(url_text(Url, Text), "Fetch a URL and strip HTML.") :-
    script_body(url_reader, Script),
    write_file(".deepclause.tmp/url_reader.py", Script),
    write_file(".deepclause.tmp/url.txt", Url),
    exec(bash(command: "python3 .deepclause.tmp/url_reader.py .deepclause.tmp/url.txt"), Result),
    get_dict(stdout, Result, Text).
```

Two details are deliberate: the script is materialized with `write_file/2` (a
DML/Prolog predicate, not a host tool), and the untrusted URL is passed through
a file rather than interpolated into the shell command.

## Memory: two levels

| Memory | Used by | Contents |
|---|---|---|
| **Harness memory** | object-level `task` predicates and the committed entry run | the harness's runtime conversation |
| **Meta memory** | the code-writing meta task | recent prompts and outcomes |

Keeping them apart is a core design decision: the model writing code does not
accumulate the harness's runtime conversation, and the harness runtime never
contains code-review chatter. `execute` gets a copy of harness memory so it can
test with realistic context; those writes are discarded at commit. The entry run
is the only place harness memory advances.

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

The `pi` backend does not run an LLM of its own: it borrows pi's **model
catalog and credential store** (`@earendil-works/pi-coding-agent`). You do not
need the `pi` CLI or a pre-existing pi session — the SDK discovers an existing
install, or you can ask it to install the package.

```bash
# Full setup: discover/install pi, list its catalog, pick a model, log in.
deepclause set-backend pi

# Non-interactive / scripted:
deepclause set-backend pi --list                    # providers + chat models (no change)
deepclause set-backend pi --list --json             # machine-readable catalog
deepclause set-backend pi --model anthropic/claude-sonnet-4   # pin a model
deepclause set-backend pi --provider openai         # restrict the picker
deepclause set-backend pi --api-key sk-…            # store a key via pi credentials
deepclause set-backend pi --install                 # npm install the pi package first
deepclause set-backend pi --no-login                # never start an interactive login

# Inspect / revert:
deepclause set-backend status
deepclause set-backend status --json
deepclause set-backend env                          # SDK provider/API-key backend
```

Setup flow:

1. **Discover or install.** The SDK looks for the pi package next to itself, in
   the current project's `node_modules`, on `PATH` (`which pi`), and in common
   global locations (`~/.local/share/pi-node/*`, `/usr/local/lib/node_modules`,
   `$PI_PACKAGE_DIR`). `--install` runs `npm install
   @earendil-works/pi-coding-agent` if it is missing.
2. **Choose a model.** The picker lists pi's chat models with reasoning flags;
   `--model`/`--provider` skip the prompt.
3. **Authenticate.** If pi has no credentials for the chosen provider, the CLI
   runs pi's own login flow (API key or OAuth/subscription) and stores the
   credential through pi. In non-interactive runs it fails with guidance
   instead of hanging.
4. **Persist.** The choice is written to `.deepclause/config.json` under
   `backend` (`kind`, `model`, `agentDir`, `modelsPath`, `authPath`).

With `backend = pi`, the REPL never asks for API keys, never writes provider
environment variables, and never guesses a provider. Resolution order: explicit
CLI/config paths → `<cwd>/.pi` → `~/.pi/agent`.

## Host tools

The default capability host tool is exactly **`bash`**, registered through the
SDK's shell manager with the configured sandbox. `--tools a,b` or
`--no-tools` change the set; MCP servers contribute their own tools when
configured. **File reading and writing are DML language, not host tools** — use
`open/3`, `close/1`, `read_string/3`, `write/2`, `write_file/2`, `read_file/2`,
`append_file/2` (paths resolve under the workspace).

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
  "render": "rich",
  "showReasoning": "summary",
  "showToolArgs": true,
  "maxToolResultChars": 2000,
  "color": true,
  "tools": null
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
```

The SDK also exports `DMLSession`, `createPiBackend`/`createPiAdapter`,
`createReplToolset`/`buildToolCatalog`, and the export helpers for embedding.

## Self-hosting demo

A harness whose only tooling is an embedded script survives a clean workspace,
because the script is part of the `.dml`:

```bash
# 1. Build a harness that embeds its script as a fact and materializes it.
cat > seed.dml <<'DML'
script_body(writer, "the embedded script ran").
materialize(Out) :-
    script_body(writer, Script),
    write_file("materialized.txt", Script),
    read_file("materialized.txt", Out).
repl_entry(materialize_demo).
materialize_demo :- materialize(X), output(X).
DML

# 2. Export a self-contained harness.
deepclause repl -l seed.dml --export harness.dml --no-ask -g "true"

# 3. Delete the side files / start from a clean directory, then run it immutably.
deepclause repl -l harness.dml -f -g "materialize(X)"
```

The second run prints the embedded script's contents even though
`seed.dml`/`materialized.txt` are gone: `export` captured the `script_body/2`
fact, and `freeze` guarantees the loaded harness cannot rewrite itself.

The equivalent automated round-trip lives in
`tests/repl-freeze-export.test.ts`
("keeps an embedded script fact inside the exported harness and runs it after
workspace cleanup").
