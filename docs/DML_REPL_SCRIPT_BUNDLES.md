# Script files and harness bundles

Design for M8: generated programs live as **files**, linked from the DML, and
are exported together with the harness as a **zip bundle**. This replaces the
`script_body/2` string-fact convention, which forced multi-line code through DML
string escaping (the source of the flaky authoring: `assert_many` parse errors,
partial asserts, empty commits).

Canonical reference: [`DML_REPL_PROPOSAL.md`](./DML_REPL_PROPOSAL.md). This
document supersedes the "self-contained `script_body/2`" rule there.

## 1. Layout

A session-owned harness directory, configurable as `repl.dir` (default
`.dc-repl/`, deliberately not `.deepclause/`):

```text
<workspace>/.dc-repl/
├── scripts/              # linked script files
├── .staging/             # per-turn staging (discarded on failure/abort)
└── imported/             # extracted bundles
```

The pi extension uses the same design rooted at `.pi/deepclause/`
(`.pi/deepclause/scripts/`).

Any file is allowed. There is no fixed extension and no script-name registry:
scripts are ordinary files.

## 2. Linking scripts from DML

A plain user predicate links a name to a workspace-relative path:

```prolog
script_file(web_search, ".dc-repl/scripts/web_search.py").

tool(web_search(Query, Result), "Search the web.") :-
    script_file(web_search, ScriptPath),
    write_file(".dc-tmp/query.txt", Query),
    format(atom(Cmd), "python3 '~w' '.dc-tmp/query.txt'", [ScriptPath]),
    exec(bash(command: Cmd), R),
    get_dict(stdout, R, Result).
```

`script_file/2` has **no runtime semantics** — the DML runs against `/workspace`,
so a workspace-relative path just works. It exists so the exporter knows which
files belong to the harness. `script_body/2` is removed; a fact by that name is
now an ordinary user predicate with no special handling.

## 3. Meta tools: the author edits files directly

The meta task gains generic, workspace-scoped file tools. Content travels as a
plain string argument, never as escaped DML:

| Tool | Behavior |
|---|---|
| `read_file(path)` | reads a workspace file (staging overlay first) |
| `write_file(path, content)` | writes into the turn's staging area |
| `list_files(path?)` | lists a workspace directory (staging overlay) |
| `delete_file(path)` | stages a deletion |

Rules:

* paths are workspace-relative; traversal (`..`, absolute) is rejected;
* reads are allowed when frozen; writes/deletes are refused when frozen;
* the meta frame also gets the capability host tools — by default **`bash`** —
  so the author can probe the environment (`python3 --version`, `which curl`, …)
  and test commands directly. Harness `tool/2` predicates stay hidden.

There are deliberately **no** `write_script`/`list_scripts` tools: scripts are
just files.

## 4. Transaction

File writes participate in the prompt transaction:

1. At turn start, a staging dir is created and the harness manifests
   (module + scripts) are snapshotted.
2. `write_file`/`delete_file` operate on staging; `read_file`/`list_files` see
   staging overlaid on the harness.
3. On commit, the committed source is authoritative: staged files are promoted
   into the harness, and harness script files no longer referenced by a
   `script_file/2` fact in the committed module are garbage-collected.
4. On failure/abort, staging is discarded and the previous harness is intact.
   The abort safety net writes a **bundle zip** (module + scripts) to a temp
   file instead of a lone `.dml`.

## 5. Export

`export <file>`:

* **`<file>.zip`** — the canonical self-contained artifact:
  ```text
  harness.dml          # the living module (with script_file/2 linkage)
  .dc-repl/scripts/…   # every file referenced by script_file/2, at its path
  manifest.json        # provenance: version, model/backend, timestamp, hashes
  ```
* **`<file>.dml`** — a single file for portability. Because one file cannot carry
  others, the referenced scripts are **auto-inlined**: for each
  `script_file(Name, Path)`, an
  `embedded_file("<path>", "<content>")` fact is emitted ahead of the module
  source. On load those facts are materialized back into the workspace, so the
  `script_file` paths resolve.

`export --skill` still appends the `agent_main/0` wrapper.

Zip is produced with `fflate`.

## 6. Load

* `-l harness.zip` — entries are validated (workspace-relative, no traversal),
  extracted into the workspace, and `harness.dml` is loaded.
* `-l harness.dml` — loaded normally; any `embedded_file/2` facts are
  materialized to their paths before the entry runs.
* `[file].` / `load` follow the same rules.

## 7. Freeze

Frozen: the module is immutable, `write_file`/`delete_file` are refused, and a
loaded bundle's scripts are made read-only on disk. `read_file`, queries,
`execute`, `bash`, and nested `task` calls keep working. Freeze remains an
integrity lock, not a sandbox (see the proposal §16).

## 8. Authoring contract changes

The meta prompt's self-containment rule becomes:

> The harness is the `.dml` **plus** the files it links with `script_file/2`.
> Write each program to a file with `write_file`, link it with
> `script_file(Name, Path)`, and run it with `exec(bash(...))`. Pass untrusted
> data through files or stdin, never interpolated into the shell command.
> `export` bundles the linked files, so they travel with the harness.

The `DML_REFERENCE.md` and `DML_AUTHORING.md` examples move from `script_body/2`
to files.

## 9. Tests

* `write_file` stages; commit promotes; the script runs; export zip; reload in a
  clean workspace; run again.
* `.dml` auto-inline round-trips (embedded file materialized on load).
* A failing turn/abort leaves the previous scripts intact; abort writes a zip.
* Frozen: `write_file`/`delete_file` refused, reads and runs still work.
* Traversal (`../x`, absolute paths) rejected for both file tools and bundle
  entries.
* The meta frame offers `bash`; harness `tool/2` predicates are not exposed.

## 10. Out of scope

* Per-file raw-source retention (reconstructed clauses still lose comments).
* Incremental/patch script editing beyond `read_file`/`write_file`.
