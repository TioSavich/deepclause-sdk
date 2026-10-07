# DML authoring guide (REPL)

How to think about a REPL harness. For code, see `HARNESS_EXAMPLES.md` (idiomatic
harness shapes) and `PROLOG_SNIPPETS.md` (tested building blocks).

## 0. What a harness is

A harness is a **living library of reusable DML skills** for the workspace —
not a single program. A skill is a predicate; name them descriptively and run
them with `execute` (during a turn) or `goal:`. Skills are built from:

- **helper predicates** (plain Prolog/CLP),
- **semantic judgments** (`choose`/`rate`/`verify`/`probability`),
- **host tools** via `exec/2`, and
- **model calls** via `task/N` — a bounded agentic turn that may itself call
  other skills.

The module is **data = code**: small/medium structured data belongs in it as
facts (`country(ch, "Switzerland").`), inspected and queried exactly like
predicates (`listing`, `goal:`, `execute`). Add data as facts when it is small
enough to reason over; keep large datasets in a file or a linked script rather
than bloating the module.

A harness may also carry **test predicates** that pin the intended behavior of a
skill — for example `test_<name>`, or a small `check/2` runner over
input/expected pairs. When you change a skill, update or add its test and run it
so the change is verified, not assumed.

So a harness evolves like a codebase through **composition and reuse**: prefer
an existing predicate over a near-duplicate. Change it **only when the user
asks** — create on a fresh workspace, and afterwards touch only what the request
requires; never refactor or extend it on your own initiative.

## 1. Only use tools from the catalog

The HOST TOOL CATALOG above is the complete set of `exec(...)` capability tools.
Do not invent names — there is no `calculator`, `fetch_url`, `web_search`, or
`vm_exec` unless the catalog lists it. By default the only capability tool is
**`bash`**. File I/O is language, not a tool (`write_file/2`, `read_file/2`, …),
and you also have the `read_file`/`write_file`/`list_files`/`delete_file` and
`bash` tools directly.

## 2. Scripts are files, linked from the harness

Write each program to a file with `write_file`, link it with `script_file/2`,
and run it with `bash`. The write lands on disk immediately, so you can run the
script in the same turn; no DML string escaping is involved. `script_file/2` is
just a fact: it tells `export` which files belong to the harness. Use a literal
workspace-relative path and one fact per name. `export harness.zip` bundles the
`.dml` plus every linked file; `export harness.dml` inlines them so the single
file stays portable.

Untrusted data (URLs, file contents, user text) goes through a file or `stdin`,
never interpolated into the shell command string. See `HARNESS_EXAMPLES.md` §1.

## 3. Annotate the harness (self-describing)

Keep the harness self-describing with a small set of facts:

```prolog
module_doc("Support triage: classify a message and route it to a team.").

doc(classify/2, "Route a support message to a team. classify(+Message, -Team). Example: goal: classify(\"I was charged twice\", T).").
doc(tally/2, "Count occurrences of each item. tally(+List, -Counts) yields Key-N pairs. Example: tally([a,b,a], C).").
```

- `doc(Name/Arity, Text)` — one fact per skill, helper, or tool; terse, with
  arguments (`+in` / `-out`) and an example goal.
- `module_doc(Text)` — one fact summarising the whole harness.

They are shown in the manifest (so the next turn sees them), in `listing`, and
survive `export`. When you change a predicate, update its `doc/2` too.

## 4. Guard rails

- Read first: call `listing`.
- Clause order matters: base case before a recursive rule; define a whole
  predicate with `assert_many` (clauses in the order written).
- Verify after changing a predicate: `listing(Name/Arity)`.
- Bounded iteration only: finite recursion, CLP(FD)/CLP(Q), or an explicit
  bound. `execute` is gas-limited and the turn has a model-call budget.
- `bash` runs in a sandbox. Explore it (`python3 --version`, `pip list`,
  `which jq`) and install a dependency when a skill genuinely needs one;
  installs are sandbox/session-local and do not travel with an exported harness,
  so prefer the standard library.
- Do **not** use `agent_main` unless the user asks for a `deepclause run` /
  `/dc-run` skill.
