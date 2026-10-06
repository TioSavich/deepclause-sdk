# DML authoring patterns (REPL)

Idiomatic shapes for a REPL harness. Keep harnesses small and concrete.

## 1. Only use tools from the catalog

The HOST TOOL CATALOG above is the complete set of `exec(...)` capability tools.
Do not invent names — there is no `calculator`, `fetch_url`, `web_search`, or
`vm_exec` unless the catalog lists it. By default the only capability tool is
**`bash`**. File I/O is language, not a tool (`write_file/2`, `read_file/2`, …).

## 2. A bash-backed tool, a task chain, and an entry

The common shape: define a `tool/2` the model can call during `task(...)`, give
it a description, and wrap a host `exec(...)` in it.

```prolog
tool(run_python(Script, Output), "Run a Python snippet and return stdout.") :-
    write_file(".dc-tmp/snippet.py", Script),
    exec(bash(command: "python3 .dc-tmp/snippet.py"), Result),
    get_dict(stdout, Result, Output).

repl_entry(summarize).
summarize :-
    task("Write Python that prints the first 10 Fibonacci numbers.", Script),
    run_python(Script, Output),
    format(string(Desc), "Summarize this output in one sentence: ~w", [Output]),
    task(Desc, Summary),
    output(Summary).
```

## 3. Self-contained tools: embed the script as a fact

The harness must carry everything it needs. Store the program as a
`script_body/2` fact and materialize it at run time with `write_file/2`; never
leave the code only as a side file.

```prolog
script_body(word_count, "import sys\nprint(len(open(sys.argv[1]).read().split()))").

tool(count_words(File, Count), "Count words in a workspace file (embedded script).") :-
    script_body(word_count, Script),
    write_file(".dc-tmp/word_count.py", Script),
    format(atom(Cmd), "python3 .dc-tmp/word_count.py '~w'", [File]),
    exec(bash(command: Cmd), Result),
    get_dict(stdout, Result, Count).
```

Untrusted data (URLs, file contents, user text) goes through a file or
`stdin`, never interpolated into the shell command string.

## 4. A multi-step pipeline: task -> task -> output/answer

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

## 5. Guard rails

- Read first: call `listing`.
- Clause order matters: base case before a recursive rule; assert a whole
  predicate with `assert_many`.
- Verify after changing a predicate: `listing(Name/Arity)`.
- Bounded iteration only: finite recursion, CLP(FD)/CLP(Q), or an explicit
  bound. `execute` is gas-limited.
- Declare entries with `repl_entry/1`. Do **not** use `agent_main` unless the
  user asks for a `deepclause run` / `/dc-run` skill.
