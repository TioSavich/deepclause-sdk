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
└── imported/             # extracted bundles
```

The pi extension uses the same design rooted at `.pi/deepclause/`
(`.pi/deepclause/scripts/`).

Any file is allowed. There is no fixed extension and no script-name registry:
scripts are ordinary files.

## 2. Linking scripts from DML

A plain user predicate links a name to a workspace-relative path:

```prolog
script_file(fetch_text, ".dc-repl/scripts/fetch_text.py").

tool(fetch_text(Url, Result), "Fetch a URL as text.") :-
    script_file(fetch_text, ScriptPath),
    write_file(".dc-tmp/url.txt", Url),
    format(atom(Cmd), "python3 '~w' '.dc-tmp/url.txt'", [ScriptPath]),
    exec(bash(command: Cmd), R),
    get_dict(stdout, R, Result).
```

`script_file/2` has **no runtime semantics** — the DML runs against `/workspace`,
so a workspace-relative path just works. It exists so the exporter knows which
files belong to the harness. `script_body/2` is removed; a fact by that name is
now an ordinary user predicate with no special handling.

## 3. How scripts are materialized (no file tools)

The authoring agent has **no file tools**. A script is written to the workspace
by running a DML goal through the `execute` tool:

```prolog
make_directory_path(".dc-repl/scripts"),
write_file(".dc-repl/scripts/url_reader.py", "...").
```

Rules:

* paths are workspace-relative; traversal (`..`, absolute) is rejected;
* the capability host tool — by default **`bash`** — is available to `exec/2`, so
  the author can probe the environment (`python3 --version`, `which curl`, …)
  and test commands directly. Harness `tool/2` predicates stay hidden.

There are deliberately **no** `write_script`/`list_scripts` tools: scripts are
just files.

## 4. File writes

File writes are **not** buffered. DML `write_file/2`/`delete_file/1` (run through
`execute`) land on disk immediately, so the author can write a script and run it
with `bash` in the same turn. `write_file/2` does not create parent directories —
call `make_directory_path/1` first. (The earlier in-memory staging overlay made
`bash` see a stale view, so the author would fight the filesystem instead of the
problem.)

The prompt turn is still a transaction for the **module**: the living module is
snapshotted before the meta task and restored on failure/abort, and the commit
is replace-by-predicate. On commit, harness script files no longer referenced by
a `script_file/2` fact are garbage-collected. The abort safety net writes a
**bundle zip** (module + scripts) to a temp file, so a long debugging turn is
recoverable — workspace file edits simply stay on disk.

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

Frozen: the module is immutable (edits are refused) and a loaded bundle's scripts
are made read-only on disk. Queries, `execute`, `bash`, and nested `task` calls
keep working. DML file predicates are language-level and are not gated by freeze,
so freeze is an integrity lock on the *module*, not a sandbox (see the proposal
§16).

## 8. Authoring contract changes

The authoring prompt's self-containment rule becomes:

> The harness is the `.dml` **plus** the files it links with `script_file/2`.
> You have no file tools: materialize a script by running a DML goal with
> `execute` (`make_directory_path("scripts"), write_file("scripts/x.py", "…")`),
> link it with `script_file(Name, Path)`, and run it with `exec(bash(...))`. Pass
> untrusted data through files or stdin, never interpolated into the shell
> command. `export` bundles the linked files, so they travel with the harness.

The `DML_REFERENCE.md` and `DML_AUTHORING.md` examples move from `script_body/2`
to files.

## 9. Tests

* DML `write_file/2` writes immediately and `bash` can run the script in the
  same turn; export zip; reload in a clean workspace; run again.
* `.dml` auto-inline round-trips (embedded file materialized on load).
* A failing turn/abort restores the module and writes a bundle zip (workspace
  file edits stay on disk).
* Frozen: module edits refused; bundle scripts read-only; queries/runs still work.
* Traversal (`../x`, absolute paths) rejected for DML file predicates and bundle
  entries.
* The meta frame offers `bash`; harness `tool/2` predicates are not exposed.

## 10. Out of scope

* Per-file raw-source retention (reconstructed clauses still lose comments).
* Incremental/patch script editing beyond rewriting a whole file.
