# mend: one patch tool for every AI edit format

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AryFlows/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AryFlows/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and mend reads them all: a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Each format is read exactly as `SPEC.md` says, and every file is
changed or nothing is: a failed edit changes nothing, the edits after it still
run, and when any edit failed no file is written.

Matching is forgiving where models are sloppy and strict where it matters. Old
lines are found at the first of three tiers where they occur: exactly, ignoring
trailing spaces and tabs, or ignoring leading and trailing spaces and tabs (with
added lines re-indented to the file's own indent at that tier). Unified hunks take
the occurrence nearest their stated line number, so drifted numbers still land;
SEARCH/REPLACE blocks refuse when the old text occurs more than once; V4A chunks
follow an anchor and a cursor. Line breaks stay the file's own (CRLF files stay
CRLF), a final line break is preserved unless a hunk says otherwise, and moves
print as `R <old> -> <new>`.

## Run it

Node 22 and its standard library alone — no dependencies to install:

```
node main.ts [options] [PATCH]
```

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.

Exit 0 lists every changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move)
and ends with `ok: <n> files`. Exit 1 lists every failed edit in patch order
and ends with `failed: <k> of <n> edits`. Exit 2 is one line: a usage error,
an unreadable patch file, an undetected format, or a parse error with its
patch line number.

## The files

- `main.ts`: the CLI. Implements all of `SPEC.md`: the command line, output
  and exit codes, safe paths, format detection, three-tier line matching,
  unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, and the
  all-or-nothing write. Its last lines hand a trial over to `runner.ts` when
  `MAKEFUN_ENV_URL` is set.
- `runner.ts`: in a trial it reads the checks from the env, runs
  `node main.ts` on each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine:

```
node check.ts <practice.json>
node check.ts <practice.json> u-offset s-basic
```

  It prints every check `main.ts` gets wrong, with what differed, and the
  practice score. Practice score here: **1000** (100 of 100 checks).
- `SPEC.md`: the specification. Every sentence in it is a requirement.
- `LICENSE`: MIT.
