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

**Generalize, don't specialize.** Prefer a few small, composable primitives over
a predicate per request, and express one-off requests by composing them (or a
direct `goal:`) instead of naming a predicate for every phrasing. A hard-coded
"latest image in `~/Downloads`" is wrong; even `find_latest(Dir, Pattern, Path)`
is fairly narrow — the reusable parts (list a directory, filter, pick a
best/latest element) are shared by many tasks. Ask whether another caller would
plausibly reuse the predicate with different arguments; if only this request
would, do not add it. A harness of many task-shaped helpers is as bad as one
hard-coded script.

## 1. Skills vs one-shot work

A harness is a library of reusable **capabilities**, not a record of what you
did. Most requests mix two things, and you must separate them:

- **A reusable capability** — worth a named, documented, tested predicate. It
  takes its inputs as arguments and works for any caller (`describe_image(Path,
  Text)`, `tally(List, Counts)`).
- **A one-off action** — the concrete step for *this* request. Run it now with
  an `execute` goal or `bash`; do not commit it as a predicate.

Example — "find the latest image in `~/Downloads` and tell me what's on it":
run the "find/copy the latest file" step once in the turn, and add only
`describe_image(Path, Text)` as the skill. Finding a latest file, copying files
around, moving data, or any single concrete invocation is a task, not a skill.

Never bake environment-specific values into a predicate: no host paths
(`/home/...`), machine-specific directories, or fixed filenames — a skill takes
them as arguments. A predicate that exists only to be called once, with literals
frozen in, is a script in disguise.

## 2. Only use tools from the catalog

The HOST TOOL CATALOG above is the complete set of `exec(...)` capability tools.
Do not invent names — there is no `calculator`, `fetch_url`, `web_search`, or
`vm_exec` unless the catalog lists it. By default the only capability tool is
**`bash`**. File I/O is language, not a tool (`write_file/2`, `read_file/2`, …),
and you also have the `read_file`/`write_file`/`list_files`/`delete_file` and
`bash` tools directly.

## 3. Scripts are files, linked from the harness

Write each program to a file with `write_file`, link it with `script_file/2`,
and run it with `bash`. The write lands on disk immediately, so you can run the
script in the same turn; no DML string escaping is involved. `script_file/2` is
just a fact: it tells `export` which files belong to the harness. Use a literal
workspace-relative path and one fact per name. `export harness.zip` bundles the
`.dml` plus every linked file; `export harness.dml` inlines them so the single
file stays portable.

Untrusted data (URLs, file contents, user text) goes through a file or `stdin`,
never interpolated into the shell command string. See `HARNESS_EXAMPLES.md` §1.

A linked script is for a genuinely external capability (a library, `ffmpeg`, an
API) — not for glue that Prolog already does (`directory_files/2`, `findall/3`,
`msort/2`, `sort/4`, regex, string predicates) and not one script per request.
Even a necessary script is a component: parameterize it and document it with
`doc/2`.

## 4. Annotate the harness (self-describing)

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

## 5. Media (images)

Images are **workspace files**, referenced by `media(Path, Mime)`; the bytes
never enter Prolog or conversation memory. Read a reference with `read_media/2`
and put it in context with `attach_media/1`; the next `task/N` sends it to the
model as an image block:

```prolog
describe_image(Path, Text) :-
    read_media(Path, Image),
    attach_media(Image),
    task("Describe the attached image in one sentence.", Text).
```

Only PNG/JPEG/GIF/WebP are accepted. This needs a vision-capable model; keep a
textual description in memory when it does not. Semantic judgments stay
text-only — never attach media to them.

## 6. Guard rails

- Read first: call `listing`.
- **Paths are workspace-relative and workspace-confined.** Never write
  `/workspace/...` or any absolute path in DML — they are rejected. `size_file/2`,
  `time_file/2`, `read_file/2`, `open/3`, `directory_files/2`, and `read_media/2`
  all take a relative path, and `directory_files/2` returns **bare names**, so
  build one (`atom_concat('images/', Name, Path)`). `bash` sees more of the
  sandbox than DML can — keep that in `bash` and hand DML only relative paths.
- **Side-effecting skills must be deterministic.** Any skill that calls
  `task/N`, `prompt/N`, `exec/2`, `read_media/2`, `attach_media/1`, or writes a
  file must yield exactly one solution with no choicepoint left across the side
  effect (`once/1`, `->`, or a cut). Otherwise backtracking re-runs the model
  call: slow, costly, and a different answer each time.
- Replace a predicate with `define(head, clauses)` (or `retract` then
  `assert_many`). `assert` appends, so asserting a clause twice duplicates the
  predicate; never patch it clause by clause.
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
- Media: reference images with `media(Path, Mime)` (`read_media/2` +
  `attach_media/1`); never inline bytes.
