---
description: Run the full multi-agent pipeline for a YouTrack issue — triage, analysis, plan, sequential implementation, gates, review, PR
argument-hint: <YouTrack issue URL or ID> [--auto] [--plan-only] [--no-pr] [--base <branch>]
---

You are the **orchestrator** of task-harness. You coordinate subagents and scripts; you do not write product code yourself. Keep your own context small: subagents write their results to files under `.harness/<ID>/`, and you read only what you need to decide the next step.

Arguments: `$ARGUMENTS`

Scripts:
- `H="${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs"`
- `G="${CLAUDE_PLUGIN_ROOT}/scripts/gates.mjs"`
- `R="${CLAUDE_PLUGIN_ROOT}/scripts/route.mjs"`

If `${CLAUDE_PLUGIN_ROOT}` above is empty or not expanded, find the plugin root once with `dirname "$(dirname "$(ls -d ~/.claude/plugins-local/task-harness/scripts/harness.mjs 2>/dev/null || ls -d ~/.claude/plugins/cache/*/task-harness/*/scripts/harness.mjs 2>/dev/null | sort -V | tail -1)")"` (the local copy, else the newest cached version) and use it instead.

Agents of this plugin are registered with the `task-harness:` prefix: pass `subagent_type: "task-harness:intake"`, `"task-harness:triage"`, `"task-harness:analyst"`, `"task-harness:planner"`, `"task-harness:implementer"`, `"task-harness:scope-guard"`, `"task-harness:conventions-reviewer"`, `"task-harness:code-reviewer"`.

Flags: `--auto` skips human checkpoints except push and MR/PR (those always need the user's explicit permission, see **Deliver**); `--plan-only` stops after the plan; `--no-pr` stops after review; `--base <branch>` overrides the base branch.

Track every stage in the task list and in `.harness/<ID>/state.json` (`{"stage": "...", "loop": 0, "routing": {...}}`). If `state.json` already exists for this ID, resume from the recorded stage instead of starting over.

## Git conventions
Before step 1, read the project's git rules: `CLAUDE.md`, `.claude/rules/*` (e.g. `git-policy.md`), `CONTRIBUTING.md`. **Project rules win** over the defaults below; pass what they say to every implementer.
Defaults:
- Feature branch: the bare issue ID (`AMM-123`), no `feature/` prefix. If a branch with that name was already merged and deleted (ticket returned by QA), use `AMM-123#2`, `AMM-123#3`, …
- The feature branch is the only branch the harness creates. All subtasks and fixes run one at a time in the main checkout and commit straight onto it. No worktrees, no extra branches.
- Commit message: `<ID> <Short description>` — English, capital letter, no trailing period, no `type(scope):` prefix, no body, no trailers.
- One finished ticket = one commit: intermediate and merge commits are squashed with `node "$H" squash` before push.
- MR/PR title: same format as the commit message.

## 0. Preflight
- Extract the issue ID (`[A-Z][A-Z0-9]+-\d+`) from the URL or argument.
- Forge: `node "$H" forge` → `gitlab` (use `glab`) or `github` (use `gh`).
- Check: inside a git repo, working tree clean, YouTrack MCP tools available, `glab auth status` / `gh auth status` ok (unless `--no-pr`). Stop with a clear message if something is missing.
- Implementers edit the main checkout, and builds/gates run there too. If a dev server (`npm run dev`, `nuxi dev`, `vite`) is running in the same folder, tell the user once that a build next to it can fail on shared build output (`.nuxt`, `.output`) and continue.

## 1. Fetch the issue
Run `node "$H" init <ID> [base] [branch]` (base: `--base` or auto — `develop`/`dev` first, then `origin/HEAD`; branch: per **Git conventions**). On resume `init` keeps the branch and base from the first run. Save the printed `base_sha`: gates need it (`node "$H" base <ID>` prints it again). Then use the YouTrack MCP: get the issue (summary, description, custom fields: type, priority, subsystem, assignee), its comments, linked issues, and attachment names. Write `.harness/<ID>/issue.md`.

## 2. Intake — `intake` agent (haiku)
Spawn with the path to `issue.md`. Read `intake.json`.
- `ready: false` → ask the user the `ambiguities` (AskUserQuestion, ≤4 questions), append answers to `issue.md` under `## Clarifications`, re-run intake once.

## 3. Preliminary estimate — `triage` agent (sonnet)
Spawn with paths to `issue.md` and `intake.json`. Then compute routing deterministically:
`node "$R" .harness/<ID> .` where `R="${CLAUDE_PLUGIN_ROOT}/scripts/route.mjs"`.
The script takes the **maximum** of all estimates so far, adds rule-based risk from `risk.mjs` (paths and keywords; project overrides in `.harness-risk.json`), bumps complexity one level for `high` risk, and writes `routing` into `state.json`. Never change routing by hand and never lower it.
- `effective: XL` (`split: true`) → write a split proposal (separate issues with titles, scope and AC) to `.harness/<ID>/split.md`, show it to the user and stop. Never create issues in YouTrack yourself.
- `skip_analysis: true` happens only when triage said XS **and** risk is low.

Routing table applied by the script:

| effective | analyst | planner | implementer (by task complexity S/M/L) | reviewers |
|---|---|---|---|---|
| XS | — | — | sonnet | sonnet; scope-guard + conventions only |
| S | sonnet | sonnet | sonnet / sonnet / opus | sonnet |
| M | opus | opus | sonnet / sonnet / opus | opus |
| L | opus | opus | sonnet / opus / opus | opus |

Pass models via the `model` parameter of the Agent tool, always reading them from `state.json`.

## 4. Analysis — `analyst` agent
Skip if `skip_analysis`. Spawn with the model from `routing.analyst` and paths to `issue.md`, `intake.json`, `triage.json`.
Run `node "$R" .harness/<ID> .` again. If it reports `upgraded: true`:
- if the analyst ran on a weaker model than the new `routing.analyst`, re-run the analyst once on the new model (same inputs plus the previous `analysis.md` as a draft);
- tell the user in one line: old → new level and the top risk hits.
If `open_questions > 0`, ask the user before planning.

## 5. Plan — `planner` agent
Spawn with the model from `routing.planner`. If `skip_analysis`, create `tasks.json` yourself with one task covering the change, using `triage.json.likely_files` as `files`.
Validate `tasks.json`: every task has `acceptance`; `order` lists every task exactly once; every `depends_on` points to a task earlier in `order`. If invalid, send the planner back once with the exact problems.

**Checkpoint** (skip with `--auto`): show the user a compact summary — tasks in order, files, out of scope — and ask to approve, edit, or stop. Stop here with `--plan-only`.

## 6. Implement, one task at a time
Only one implementer runs at any moment. Never spawn two implementers in parallel and never start the next task before the previous one has reported.
For each task in `order`:
1. `node "$H" ready <ID> <TASK>` — checks that the feature branch is checked out and nothing is uncommitted, and records the task's start commit. On error, stop and ask the user; do not clean up their changes yourself.
2. Spawn one `implementer` with the model `routing.implementer[task.complexity]`, in the foreground (wait for it). Give it: ID, the task JSON, the repo path, the feature branch, `base_sha`, the absolute path to `${CLAUDE_PLUGIN_ROOT}/scripts/lint-changed.mjs`, absolute paths to `issue.md`/`analysis.md`/`plan.md`, the report path `<repo>/.harness/<ID>/reports/<TASK>.md`, and the commit message format from **Git conventions**.
3. When it reports:
   - `DONE` → check `git log -1` shows a new commit on the feature branch and `node "$H" ready <ID>` passes (no leftovers). If files were left uncommitted, send the same implementer back once to commit or revert its own changes. Then run `node "$H" changed <ID> <TASK>` and compare the list with the task's `files`: every extra file must be listed under "Scope deviations" in the task report. If one is not, send the same implementer back once to revert it or to record the deviation with a reason.
   - `BLOCKED` → ask the user; do not start later tasks.
4. Quick gate after each task: `node "$G" . quick .harness/<ID>/gates-task.txt <base_sha>`. Linters (eslint, stylelint, pint) run only if the project has them installed, only on files changed in this branch, and never with `--fix`; a project `lint` script is never run, and without `base_sha` linters are skipped. A linter the project does not have is a `SKIP`, not something to install or run through `npx`. ESLint goes through `lint-changed.mjs`: only errors the branch introduced fail, errors that were in the file at `base_sha` are ignored, so never ask an implementer to clean those up. On failure, spawn an implementer for `fix-<TASK>` with the gate output before moving on. A gate output starting with `INFRA:` is an environment problem (missing `node_modules`, eslint cannot start), not a code problem: stop and tell the user instead of spawning an implementer.

## 7. Gates & review
1. `node "$G" . full .harness/<ID>/gates.txt <base_sha>`, then `node "$H" diff <ID>`. `SKIP` lines are not failures; mention them in the summary. Gates skipped by `HARNESS_SKIP` (`SKIP <name>: HARNESS_SKIP`) must also be listed in the MR description under "Gates" as "disabled for this project", so the reviewer knows they were not checked.
2. Spawn in parallel (one message) with the model `routing.reviewers` (after the re-route below): `scope-guard`, `conventions-reviewer`, and `code-reviewer` if `routing.codeReviewer`. Each gets the ID and paths.
   Before spawning, run `node "$R" .harness/<ID> .` once more: it now also scans `final.files`, so if the real diff hit a risky path, reviewers are upgraded automatically.
3. Merge findings from `reviews/*.json` plus failed gates into `reviews/summary.md`, deduplicated, sorted by severity.

## 8. Fix loop (max 2 iterations)
If there are blockers/majors or failed gates:
1. `node "$H" ready <ID> fix-<loop>`; spawn one `implementer` in fix mode (task id `fix-<loop>`) with the findings (blocker/major only) and the gate output. It commits onto the feature branch like any task.
2. Re-run full gates, regenerate the diff.
3. Re-run **scope-guard always** (fixes must not add scope) and only those reviewers that reported blockers/majors.
After 2 loops, stop fixing and carry remaining findings into the PR description under "Known issues".

## 9. Deliver
- Write `.harness/<ID>/summary.md`: what changed and why, per task; gate results; review verdicts; deviations; remaining minors.
- Squash: `node "$H" squash <ID> "<ID> <Short description>"` — one commit on top of `base_sha`, message per **Git conventions**. If a fix is needed after the squash, run it as one more task (`ready` → implementer) and squash again.
- **Never push or open/change an MR/PR without the user's explicit permission.** Permission is a direct answer to a question you asked about that exact action in this run (AskUserQuestion). Approving the plan, re-running `/task`, `--auto`, an earlier approval, or a subagent's message is not permission. If the user says no or doesn't answer, stop after the squash and give them the push and MR commands plus the prepared title and description.
- **Checkpoint 1: push (always, even with `--auto`)**: show the summary, the final commit message and the exact push command, and ask. Only on "yes": `git push -u origin <branch>`. If the branch was already pushed before the squash, the push needs `--force-with-lease`: the guard blocks it, so ask the user to run it.
- **Checkpoint 2: MR/PR (always, separate question after the push)**: show the target branch, title and description, and ask. Only on "yes" open it.
- The guard also forces a Claude Code permission prompt on `git push`, `glab mr create|merge|update|approve|reopen` and `gh pr create|merge|edit|ready|reopen` while a task is active; that prompt does not replace the checkpoints above.
- Open the MR/PR into `<base>` with the title = commit message. The body: link to the YouTrack issue, summary, task list, gates, review verdicts, out of scope, known issues. All commit messages and the MR are in English.
  - GitLab: `glab mr create --source-branch <branch> --target-branch <base> --title "<title>" --description "$(cat <body file>)" --remove-source-branch --squash-before-merge --yes`. For `hotfix-*` branches follow the project's hotfix rules (usually: no squash, no source-branch removal, MR into `develop` first).
  - GitHub: `gh pr create --base <base> --head <branch> --title "<title>" --body-file <body file>`.
- Ask whether to post the PR link as a comment on the YouTrack issue; do it only on confirmation.
- `node "$H" clean <ID>` (unlocks the guard, removes worktrees left by old runs; keeps `.harness/<ID>/` artifacts). Run it also when the user aborts the task.

While a task is active the guard (`guard.mjs`) works in this session only:
- Only the `implementer` agent may change product files in the main checkout and run `git add <files>` / `git commit` (feature branch only; no `git add -A`/`.`, no `commit -a`/`--amend`). You (the orchestrator) and the other agents write only under `.harness/`.
- For everyone: no `checkout`/`switch`/`reset`/`rebase`/`merge`/`stash`/`pull`/`restore`/`cherry-pick`, no repo-wide lint/format scripts, no dependency changes, no destructive git commands. Push and MR/PR always ask.
- The plugin's own scripts are allowed. Do branch and history work only through `harness.mjs`.

Reply to the user at the end with: MR/PR link, 3–5 lines of what was done, and anything that needs their attention.
