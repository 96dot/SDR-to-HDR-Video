# Rigorous checks for any project

For any chat and any project. Two parts: a script that runs what a machine can check, and a procedure for what it cannot. It was worked out on a browser extension (Headroom HDR, `tests/CHECKS.md` there is the specific version), but nothing here depends on that.

Use it for a **major update**: substantial new work or a new feature. Small fixes and doc changes only need the script and a test of the change.

## How to use it in a new chat

Put `check-project.mjs` somewhere (the project's `tools/` folder, or anywhere: it takes `--dir`), then paste this at the start of the chat:

> Before you hand me any major update, do the rigorous checks. Run `node check-project.mjs --dir <my project>` (Node 18+, nothing to install), fix what FAILs, and look at what WARNs. Then spawn three independent read-only review agents (security, logic, readability), verify every finding yourself and tell me which were false alarms, run the thing for real where you can, and tell me once, at the end, in plain words: what you checked, what you found, what you fixed, what you could not test, and exactly what I should try. Do not claim it works where you did not run it.

If the project keeps a `CLAUDE.md` (or similar notes file the chat reads), put the same paragraph in it so that every new chat does this without being told.

## 1. The script

```
node check-project.mjs [--dir <project>] [--quick] [--build] [--json] [--only a,b] [--skip a,b]
```

It works out what the project is and runs what applies. Anything it cannot run says `SKIP` and why, so a check never passes by not running.

| Group | What it does |
|---|---|
| `git` | uncommitted or unpushed work (a warning) |
| `syntax` | JavaScript (`node --check`), JSON, Python (`py_compile`), shell (`bash -n`), TypeScript (`tsc --noEmit`) |
| `lint` | eslint (if the project has a config and eslint), ruff or flake8 for Python |
| `scripts` | the `lint`, `typecheck` and `test` scripts of a `package.json` (and `build` with `--build`), with npm, pnpm or yarn as the lockfile says |
| `tests` | pytest or unittest, `go vet` and `go test`, `cargo check` and `cargo test` |
| `manifest` | a browser extension's `manifest.json`: every file it names exists; the version matches the newest `CHANGELOG.md` heading |
| `docs` | links between Markdown files point at files that exist (a warning) |
| `secrets` | private keys, cloud and API tokens, and passwords in URLs left in files |
| `size` | files over 5 MB (a warning) |
| `yours` | what the project puts in `.checks.json` |

`PASS`, `FAIL` (the exit code is 1), `WARN` (a person should look), `SKIP` (not run, with the reason). `--quick` leaves out the slow tests. `--json` is for other tools.

### Adding the project's own checks: `.checks.json`

Whatever is special about a project goes in one file at its top:

```json
{
  "mustExist": ["LICENSE", "README.md"],
  "commands": [
    { "name": "end to end", "run": "node tests/e2e.mjs", "slow": true, "timeoutMin": 10 },
    { "name": "nice to have", "run": "make lint", "optional": true }
  ],
  "inStep": [
    { "name": "settings match",
      "a": { "file": "ui/settings.js", "regex": "DEFAULTS = (\\{[^}]*\\})" },
      "b": { "file": "core/config.js", "regex": "DEFAULTS = (\\{[^}]*\\})" } }
  ]
}
```

- `commands`: run through the shell; a non-zero exit fails (or warns if `optional`); `slow` ones are skipped by `--quick`.
- `inStep`: two places kept the same by hand (two copies of a table, a version string in two files, defaults in the UI and in the engine). It takes the first capture group of each regex and compares them with whitespace ignored. If a project has such pairs, **add them**: they drift silently, and this is the only thing that notices.

Good things to put in `commands`: the project's end-to-end test, a build, a size or height limit that must not be crossed, a check that a generated file is up to date.

### Prove the checks can fail

A check that has never failed may not check anything. For each one you add, break the thing on purpose (change one of the paired values, rename a file the manifest names, add a syntax error), confirm it goes red, and put it back.

## 2. The three reviews

Spawn **three independent read-only agents** in one message, each told **not to edit anything**, each reading the changed code **and what it touches in full** (`git diff <base>`, then the files). Paste-ready prompts: change what is in angle brackets.

**Security**

> Read-only review (do NOT edit files). Project at `<path>`. Run `git diff <base>` to see the change: `<one sentence>`. Read the changed code in full plus what it touches. SECURITY focus: injection (SQL, shell, HTML, paths); anything an outside party (a web page, a user, another process, a file someone sends) can forge, trigger or read; authentication and who is allowed to do what; handling of secrets and private data (what ends up in logs, files, URLs, error messages); input validation at every boundary; what is read from disk or the network and trusted; dependencies and downloads; anything that leaves the machine; resource exhaustion (memory, files, repeated requests). Report concrete findings only: file:line, how it is reachable, severity. Say plainly where it is clean.

**Logic**

> Read-only review (do NOT edit files). Project at `<path>`. Run `git diff <base>` … `<one sentence>`. Read the changed code and the code it depends on in full. LOGIC focus: control flow; races and the order of asynchronous work; resources that are opened and never released (files, connections, timers, memory); state that can be left half-changed when something fails; settings written but never read, or read but never written; constants and tables kept in step by hand; units (seconds against milliseconds, bytes against characters, fractions against percentages, time zones); off-by-one and empty, first, last and huge cases; what happens on retry or when called twice. Report concrete reachable bugs only: file:line, the scenario, severity. Say plainly where it is clean.

**Readability and consistency**

> Read-only review (do NOT edit files). Project at `<path>`. Run `git diff <base>` … `<one sentence>`. READABILITY/CONSISTENCY focus: naming and comment density against the surrounding code; comments that overclaim or no longer match the code; dead code and unused names; duplicated logic that should be shared; magic numbers with no explanation; things kept in step by hand; which of the README, changelog, privacy notes, and any notes for contributors now need updating, and whether what they say is true of the code; whether the tests test what they claim. Report concrete findings with file:line and a suggested fix. Say plainly where it is clean.

Tell the security reviewer what the change touches (files, downloads, pixels, personal data, the network, permissions), and the logic reviewer what it depends on and what is asynchronous.

## 3. Verify every finding yourself

Reviewers are wrong sometimes, and sound confident when they are. For each finding, **read the code it names and show it is reachable** (run it, write a test, or trace it) before acting on it or reporting it. Drop what cannot be shown, and say in the report which were false alarms. If a suggested fix changes behaviour, **measure it**: try it, and keep it only if it is better. (On Headroom, two review suggestions scored worse on real data and were left out, with the numbers in the changelog.) Fix what belongs to the change; list small unrelated findings as "found and not changed".

## 4. Run it for real

A passing script and clean reviews are not the same as it working. Run the thing the way a user would: start it, press the keys, open the page, call the API, feed it real data. Where you cannot (another machine, a GPU, a phone, real traffic, a paid service), **say so, and say exactly what the person should try**. "Not checked on real data" is a useful sentence; "it works" without it is a risk.

- **For a fix, reproduce the bug on the old code first, then show it gone on the new.**
- When the cause is unclear, measure before guessing: add a diagnostic, have the owner run it once, and read what it says. Ranking candidate signals against real data found in an hour what days of eyeballing had not.
- Look at the output, not just the numbers: an average can hide the one place that is badly wrong.
- Do not change how it looks or behaves for the user without asking, unless that was the request. Show before and after.

## 5. The report

Short, in plain words, the finding first. Tell the person **once, when everything is done** (not after each step), in this order:

1. What was checked (the script, the three reviews, the run for real).
2. What was found, and **which findings were false alarms**.
3. What was fixed.
4. **What could not be tested**, and why.
5. **Exactly what to try**, step by step, and what to send back.
6. The changelog text, if the project keeps one, with a "tested, and not" section.

Housekeeping: a changelog entry and a version bump if the project keeps them; commit and push to a branch (not straight to the main branch; merge only when asked); no stray files left behind; a build the person can run if they need one.
