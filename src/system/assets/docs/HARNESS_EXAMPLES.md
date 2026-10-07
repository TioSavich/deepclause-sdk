# Idiomatic harness examples

Copy-paste shapes for REPL harnesses. Keep each skill small and compose them.
(The snippets are tested against the bundled SWI-Prolog.)

Every skill carries a `doc(Name/Arity, Text)` annotation and the harness a
`module_doc(Text)` line (`DML_AUTHORING.md` §3) — they appear in the manifest
and `listing`, so the harness stays self-describing. Keep them terse.

```prolog
module_doc("Example harness: a few small skills used as patterns.").
```

## 1. Wrap a workspace script as a tool

Write the program to a file, link it with `script_file/2`, expose it as a
`tool/2`. Untrusted data goes through files/stdin, never interpolated into the
shell command:

```prolog
script_file(count_words, ".dc-repl/scripts/count_words.py").

tool(count_words(File, Count), "Count words in a workspace file.") :-
    script_file(count_words, Script),
    format(atom(Cmd), "python3 '~w' '~w'", [Script, File]),
    exec(bash(command: Cmd), Result),
    get_dict(stdout, Result, Count).
```

`script_file/2` is just a fact (the exporter bundles the file); the write lands
on disk immediately, so `bash` can run the script in the same turn.

## 2. A skill that calls the model

`task/N` runs a bounded agentic turn. Name each output variable in the
description so the model fills it:

```prolog
doc(classify/2, "Route a support message. classify(+Message, -Team). Example: goal: classify(\"I was charged twice\", T).").

classify(Message, Team) :-
    task("Route this support message to exactly one of billing, orders, or account. Message: {Message}. Store the choice in Team.", Team).

demo :-
    classify("I was charged twice for the same order", Team),
    format(string(Out), "Routed to ~w", [Team]),
    answer(Out).
```

## 3. Multi-step pipeline: task -> task -> answer

```prolog
report(Topic, Result) :-
    task("List three risks of using an LLM for arithmetic. Store them in Risks.", Risks),
    format(string(Desc), "Rank these risks and explain the top one: ~w", [Risks]),
    task(Desc, Top),
    format(string(Result), "Top risk: ~w", [Top]).
```

## 4. Data as facts (data = code)

Small/medium data belongs in the module and is queried exactly like code:

```prolog
parent(alice, bob).
parent(alice, carol).
parent(bob, dave).
parent(carol, eve).

doc(ancestor/2, "Transitive parent. ancestor(+A, -B) enumerates descendants. Example: goal: ancestor(alice, X).").

ancestor(A, B) :- parent(A, B).
ancestor(A, B) :- parent(A, C), ancestor(C, B).
```

```text
goal: ancestor(alice, X).
X = bob ; X = carol ; X = dave ; X = eve
```

## 5. Pure logic + a test predicate

```prolog
doc(tally/2, "Count occurrences of each item. tally(+List, -Counts) yields Key-N pairs. Example: goal: tally([a,b,a,c,a], C).").

tally(List, Counts) :-
    list_to_set(List, Items),
    findall(Item-N, (member(Item, Items), aggregate_all(count, member(Item, List), N)), Counts).

test_tally :-
    tally([a,b,a,c,a], C),
    C == [a-3, b-1, c-1].
```

`goal: test_tally.` succeeds when the behavior is correct. When a skill changes,
update or add its test and run it (`execute` during a turn, or `goal:`).

## 6. Semantic judgments (the model decides, Prolog enforces)

```prolog
route(Message, Team) :-
    choose(Message, "Which team should handle this?", [billing, orders, account], Team).

urgent(Message) :-
    holds(Message, "Is this urgent?").
```

`choose/4` always returns one of your options; `verify/3` is three-valued
(`yes`/`no`/`unknown`); `holds/2` is the semidet wrapper.

## 7. Constraints with CLP(FD)

```prolog
:- use_module(library(clpfd)).

doc(solve/3, "X+Y=Total with X<Y over 0..100. solve(+Total, -X, -Y). Example: goal: solve(10, X, Y).").

solve(Total, X, Y) :-
    [X, Y] ins 0..100,
    X + Y #= Total,
    X #< Y,
    label([X, Y]).
```

The `:- use_module(...)` directive must be **top-level** (an inline
`use_module` inside a body is not run at read time, so `#=`/`ins` are unknown).
