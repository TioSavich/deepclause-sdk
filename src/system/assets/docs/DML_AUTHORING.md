# DML authoring patterns (REPL)

Idiomatic shapes for a REPL harness. Keep harnesses small and concrete.

## 1. Only use tools from the catalog

The HOST TOOL CATALOG above is the complete set of `exec(...)` capability tools.
Do not invent names — there is no `calculator`, `fetch_url`, `web_search`, or
`vm_exec` unless the catalog lists it. By default the only capability tool is
**`bash`**. File I/O is language, not a tool (`write_file/2`, `read_file/2`, …),
and you also have the `read_file`/`write_file`/`list_files`/`delete_file` and
`bash` tools directly.

## 2. Scripts are files, linked from the harness

Write each program to a file with `write_file`, link it with `script_file/2`,
and run it with `bash`. The file is **staged** and committed with the turn; no
DML string escaping is involved.

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
harness. `export harness.zip` bundles the `.dml` plus every linked file;
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
- Use `bash` to probe the environment before relying on a program (`python3
  --version`, `which curl`, …).
- Declare entries with `repl_entry/1`. Do **not** use `agent_main` unless the
  user asks for a `deepclause run` / `/dc-run` skill.
