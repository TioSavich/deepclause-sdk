# DML authoring patterns (REPL)

Idiomatic shapes for a REPL harness. Keep harnesses small and concrete.

## 0. What a harness is

A harness is a **living library of reusable DML skills** for the workspace —
not a single program. A skill is a predicate; the ones a user should call are
declared as entry points with `repl_entry/1`. Skills are built from:

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
script in the same turn; no DML string escaping is involved.

```prolog
script_file(count_words, ".dc-repl/scripts/count_words.py").

tool(count_words(File, Count), "Count words in a workspace file.") :-
    script_file(count_words, Script),
    format(atom(Cmd), "python3 '~w' '~w'", [Script, File]),
    exec(bash(command: Cmd), Result),
    get_dict(stdout, Result, Count).

repl_entry(report).
report :-
    task("Suggest a short sentence to count. Store it in Sentence.", Sentence),
    write_file(".dc-tmp/sentence.txt", Sentence),
    count_words(".dc-tmp/sentence.txt", Count),
    format(string(Msg), "That sentence has ~w words.", [Count]),
    answer(Msg).
```

`script_file/2` is just a fact: it tells `export` which files belong to the
harness. Use a literal workspace-relative path and one fact per name.
`export harness.zip` bundles the `.dml` plus every linked file;
`export harness.dml` inlines them so the single file stays portable.

Other files are ordinary workspace paths. There is no fixed extension.

```prolog
tool(list_files(Dir, Listing), "List files in a directory.") :-
    format(atom(Cmd), "ls -la '~w' 2>/dev/null || echo empty", [Dir]),
    exec(bash(command: Cmd), Result),
    get_dict(stdout, Result, Listing).
```

Untrusted data (URLs, file contents, user text) goes through a file or `stdin`,
never interpolated into the shell command string.

## 3. A multi-step pipeline: task -> task -> output/answer

Sequence model calls and symbolic steps; use `task/2` for each reasoning step.

```prolog
repl_entry(report).
report :-
    task("List three risks of using an LLM for arithmetic. Store them in Risks.", Risks),
    format(string(Desc), "Rank these risks by severity and explain the top one: ~w", [Risks]),
    task(Desc, Top),
    format(string(Msg), "Top risk: ~w", [Top]),
    answer(Msg).
```

## 4. Guard rails

- Read first: call `listing`.
- Clause order matters: base case before a recursive rule; assert a whole
  predicate with `assert_many`.
- Verify after changing a predicate: `listing(Name/Arity)`.
- Bounded iteration only: finite recursion, CLP(FD)/CLP(Q), or an explicit
  bound. `execute` is gas-limited.
- `bash` runs in a sandbox. Explore it (`python3 --version`, `pip list`,
  `which jq`) and install a dependency when a skill genuinely needs one;
  installs are sandbox/session-local and do not travel with an exported harness,
  so prefer the standard library.
- Declare entries with `repl_entry/1`. Do **not** use `agent_main` unless the
  user asks for a `deepclause run` / `/dc-run` skill.
