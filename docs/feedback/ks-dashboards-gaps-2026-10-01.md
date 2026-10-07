# KS dashboards: ten Sterling gaps measured on 2026-10-01

Feedback from a consumer project to the Sterling maintainer. Each gap says what happened, the evidence, whether it is still present in the current clone, and a suggested fix.

| Stamp | Value |
|---|---|
| Consumer project | KS dashboards (work mode, WSL2 on /mnt/c, Node v24.14.0) |
| Date | 2026-10-01 |
| Sterling version the consumer ran | 0.18.44, commit `8965c63` |
| Sterling clone re-checked for this report | 0.18.46 (`.claude-plugin/plugin.json`), HEAD `ed513fa` (14 commits after `8965c63`) |
| Session-start banner | no AGENT CURRENCY warning this session |

How the re-check was done: the clone was read only (grep and file reads, nothing run except `node -e "require('node:sqlite')"` for gap 7). `git diff --stat 8965c63..HEAD` over every source file cited below is empty, so the code the consumer ran at 0.18.44 is the code at 0.18.46. Line numbers are in the source files under `scripts/` and `hooks/`, not in the bundled copies under `bin/` (the bundles carry the same text at other line numbers).

Status summary:

| # | Gap | Status at 0.18.46 |
|---|---|---|
| 1 | direct-merge refuses in a git worktree | STILL PRESENT (`scripts/direct-merge.mjs:62`, `scripts/lib/project.mjs:137`) |
| 2 | PR create via `gh api` fails on WSL | STILL PRESENT (`scripts/lib/work-pr.mjs:296`) |
| 3 | pr-loop.json stuck on an old PR | NOT RE-MEASURED (not seen this session) |
| 4 | `handoff-projection.mjs --help` read as a run | STILL PRESENT by code reading (`scripts/handoff-projection.mjs:35`); not run |
| 5 | Copilot re-request after a push | Solved on the consumer side; Sterling does not do it (`skills/pr-review-loop/SKILL.md:22`) |
| 6 | H10 article demand covers generated projections | STILL PRESENT (`scripts/hooks/h10-direct-capture.mjs:683`, `:1238`, `:1798`, `:2015`) |
| 7 | `/sterling:update` fails on Node 24.14.0 | STILL PRESENT (`scripts/tests/dispatch-state-hooks.test.mjs:103`, `:879`) |
| 8 | `pr-review-wait.mjs --head <short sha>` never matches | STILL PRESENT, new (`scripts/pr-review-wait.mjs:211`) |
| 9 | "SETTLEMENT HISTORY REWRITTEN" on sibling-branch checkout | STILL PRESENT, new (`scripts/hooks/h10-direct-capture.mjs:601`) |
| 10 | Copilot "Previously missed" findings not surfaced | STILL PRESENT, new (`scripts/pr-review-wait.mjs:231`) |

---

## 1. direct-merge refuses to run inside a git worktree

What happened: `direct-merge.mjs` run from an agent's git worktree stopped with "no Sterling store". The conductor detached the agent worktree and checked the branch out in the main checkout to run it.

Evidence:
- `scripts/direct-merge.mjs:62` calls `openProject(target).store.close()` as the pre-merge preflight.
- `scripts/lib/project.mjs:119-137` (`resolveProject`) looks only at `<cwd>/.sterling/sterling.db` and fails with `no Sterling store at <path> — not an initialized project`.
- `.sterling/` is git-ignored, so a worktree checkout never contains it. No worktree handling exists: `grep -n worktree` finds nothing in `direct-merge.mjs`, `project.mjs`, `store-path.mjs` or `work-pr.mjs`, and nothing uses `git rev-parse --git-common-dir`.

Status at 0.18.46: still present.

Suggested fix: when `<cwd>/.sterling/sterling.db` is absent and the cwd is a linked worktree, resolve the main checkout from `git rev-parse --git-common-dir` and open the store there. Alternatively refuse with a message that names the worktree case and says to run it from the main checkout. The current text ("not an initialized project") points at the wrong cause.

## 2. The PR create fails on WSL even with GH_TOKEN and WSLENV set

What happened: in work mode `direct-merge.mjs` pushed the branch, then the PR create failed with `gh api said: /home/cuj/.local/bin/gh: Invalid argument`. This happened with `GH_TOKEN` set and `WSLENV` exporting it. The push landed. The PR was then created over the REST API with curl, and a rerun of direct-merge reused it and armed the review loop.

Evidence:
- `scripts/lib/work-pr.mjs:290-296` creates the PR with `gh api --hostname <host> --method POST repos/<o>/<r>/pulls`. The comment above it records that `gh pr create` was dropped because the Windows `gh.exe` that WSL resolves "cannot find" a git binary (error text "unable to find git executable in PATH"). `gh api` needs no git, but on this machine the same binary still fails, now with `Invalid argument`.
- The failure is reported correctly and the recovery path (rerun reuses the open PR) works: the error text built at `scripts/lib/work-pr.mjs` after the create says to open the PR by hand and rerun.

Status at 0.18.46: still present. No WSL-specific gh handling was found.

Suggested fix: the push in the same file already falls back to `git.exe` when the Linux git fails (`work-pr.mjs:177`). Give the PR create the same kind of fallback: on a non-zero `gh api`, create the PR with a direct HTTPS POST to the REST endpoint using the token from the environment or the git credential helper. Failing that, document in the merge skill that on WSL with a Windows `gh.exe` the supported path is create-by-hand then rerun.

## 3. pr-loop.json stuck on an old PR

What happened (earlier measurement): `.sterling/transient/pr-loop.json` stayed armed for old PR #33, so `--settle` refused for newer PRs.

Evidence: not seen this session. Settling worked for PRs #53 to #56.

Code read, not measured: `armPrLoop` (`scripts/lib/work-pr.mjs:376`) overwrites the file on every arm, and `settlePrLoop` (`:418-440`) refuses a PR number that differs from the armed one by design. So the stuck state needs a PR that never went through an arm. A reachable path is gap 2: the push lands, the PR create fails, and the PR is made by hand without rerunning direct-merge. That is a guess, not something this project reproduced.

Status at 0.18.46: NOT RE-MEASURED.

Suggested fix: none proposed without a reproduction. If it recurs, the refusal text could print the armed PR and the exact `rm` or re-arm command.

## 4. `handoff-projection.mjs --help` is read as a run

What happened (earlier measurement): `--help` printed a refusal that mentions "hobby" instead of usage.

Evidence from code: `scripts/handoff-projection.mjs:35` is `const target = resolve(process.argv[2] ?? process.cwd());`, so `--help` becomes a path called `--help` under the cwd. No flag parsing exists in the file (`grep -n "help"` finds no help handling). The script then reads the project mode and refuses in hobby mode (`bin/handoff-projection.mjs:7745`, `HOBBY_SKIP_DETAIL`: "project mode is hobby ..."). The script's own cwd decides which message appears.

The script was NOT run for this report. The code shows `--help` is not handled, so running it would be a real invocation, not a read-only help call.

Status at 0.18.46: still present by code reading; the exact output was not re-measured.

Suggested fix: handle `--help` and `-h` before resolving the target, and reject any unknown `--flag` as an error rather than treating it as a directory.

## 5. pr-review-wait gets no review after a push until Copilot is re-requested

What happened: after a fix push, `pr-review-wait.mjs` timed out because Copilot did not review the new head until it was re-requested. The REST re-request for the bot returns an empty list.

Consumer-side solution: the GraphQL mutation `requestReviewsByLogin(input:{pullRequestId, botLogins:["copilot-pull-request-reviewer[bot]"], union:true})` works. It is recorded in the store as finding `request-copilot-review-programmatically-requestreviewsbylogin` (sterling domain).

Evidence for Sterling's side: `grep` for `requestReviews`, `requested_reviewers`, `re-request` and `rerequest` in `scripts/pr-review-wait.mjs`, `scripts/lib/work-pr.mjs` and `skills/pr-review-loop/SKILL.md` finds nothing. The skill only says to "ask the user whether Copilot needs a re-request" after repeated timeouts (`SKILL.md:22`) and lists it as an open question at `SKILL.md:49`.

Status at 0.18.46: not solved in Sterling; solved for this project by hand.

Suggested fix: after `/sterling:merge` pushes a fix head, have `pr-review-wait.mjs` (or the skill's step 3) fire the GraphQL mutation above once, using the PR's node id from `gh api repos/<o>/<r>/pulls/<n> --jq .node_id`. Then the "ask the user" step is only needed when the mutation itself fails.

## 6. H10 article demand includes generated projections; carried items ignore ignore_globs

What happened: `architecture.md`, `rulings.md` and `docs/sterling/**` were flagged as `article_missing`. The local workaround, applied 2026-10-01, was `article_demand.ignore_globs = [architecture.md, rulings.md, docs/sterling/**, .opencode/agents/**]`.

Evidence (`scripts/hooks/h10-direct-capture.mjs`):
- `:1479-1493`: the capture-duty set `activeTouches` drops paths in `config.generated_projections` through `isReleaseMechanics`.
- `:683` builds `touchedExisting` and `:1238` builds `paths = touchedExisting.filter(!isDeferred)`. Neither removes generated projections.
- `:1797-1798` builds the demand list as `paths.filter(not in ignore_globs).filter(isUnowned)`. Only `ignore_globs` is applied. `generatedProjections` is not.
- `:2015-2016`: when an open `article_missing` item is healed, `stillOwed = !prunable.has(p) && isUnowned(p)` is applied to the item's carried `file_keys`. `ignore_globs` is not applied, so an item minted before a glob was added keeps the matching path.

Status at 0.18.46: still present. The same file already treats `generated_projections` as exempt for capture, so the article lane is the odd one out.

Suggested fix: add `!generatedProjections.has(p)` to the filter at `:1798`, and add the `ignore_globs` test to `stillOwed` at `:2015` so a carried item drops a path a glob now covers.

## 7. `/sterling:update` fails on Node v24.14.0 because of a SQLite ExperimentalWarning

What happened: at 0.18.44 `/sterling:update` reported a red test battery. Store migration and the completion marker were skipped, per the update decision for a red battery.

Evidence:
- Test `DSH-14 CONTROL` (`scripts/tests/dispatch-state-hooks.test.mjs:867`) asserts `r.stderr.trim() === ''` at `:879`.
- The `runHook` helper (`:102-110`) spawns the hook with `process.execPath` and `env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' }`. It passes no `--disable-warning=ExperimentalWarning`.
- The production hook command in `hooks/hooks.json` does pass `--disable-warning=ExperimentalWarning`, so the real hooks are quiet and only the test harness is not.
- On this machine `node -e "require('node:sqlite')"` prints `ExperimentalWarning: SQLite is an experimental feature and might change at any time` (Node v24.14.0). The hook loads `node:sqlite`, so the warning reaches the test's stderr.
- `scripts/lib/update.mjs:1085` runs `npm test` as a step, and a red battery sets `testFailed` (`:1086-1090`), which skips migration.

The test itself was not run for this report. The failure is inferred from the code above plus the warning printed by the one-line `node -e` check.

Status at 0.18.46: still present.

Suggested fix: pass `execArgv: ['--disable-warning=ExperimentalWarning']` (or add the flag to the argument list) in `runHook`, the same way `hooks/hooks.json` does. Other tests that assert an empty stderr after spawning hooks should be checked for the same cause.

## 8. `pr-review-wait.mjs --head <short sha>` never matches a review

What happened: the wait timed out twice while Copilot reviews of that head already existed. The `--head` value was a short sha.

Evidence: `scripts/pr-review-wait.mjs:132` reads `--head` as a plain string, and `:211` compares it with `===` to the full 40-character `pull.head.sha`:

    const current = expectedHead === null || expectedHead === head ? fresh.filter((r) => r.commit_id === head) : [];

A short sha never equals the full one, so `current` is always empty and the helper keeps polling until the timeout. Nothing is printed to say the value was the cause. The skill (`SKILL.md:22`) says `--head <pushed sha>` without saying it must be the full sha.

Status at 0.18.46: still present. New, not on the earlier board item.

Suggested fix: validate `--head` at parse time. Accept 7 to 40 hex characters and resolve it by prefix match against `head` (a short sha that is a prefix of the current head counts as equal), and refuse anything else with an error that names the value. Also state in the skill that a full sha is preferred.

## 9. H10 prints "SETTLEMENT HISTORY REWRITTEN" when the main checkout moves between sibling branches

What happened: switching the main checkout from one PR branch to another branch cut from main made H10 print `SETTLEMENT HISTORY REWRITTEN`. No history was rewritten. The same switch minted `capture_owed` items that were already paid.

Evidence:
- `scripts/hooks/lib/settlement.mjs:465-466` sets `base = null` when the persisted settled sha is not an ancestor of HEAD (`git merge-base --is-ancestor base head` is non-zero), and `:483` returns `base_lost: Boolean(settled.sha && !base)`.
- `scripts/hooks/h10-direct-capture.mjs:598-601` turns `base_lost` into the message "persisted SHA ... is unreachable from HEAD ...". A tip on a sibling branch is not an ancestor of the other branch's HEAD, even though both commits still exist.
- The release-mechanics skip at `h10-direct-capture.mjs:1490` (`releaseBase`) also stops trusting its base when `base_lost` is true, so paths that would have been exempt count again.

The `capture_owed` detail comes from the consumer's observation; the code path above explains why the base is dropped but the minting step was not traced.

Status at 0.18.46: still present. New.

Suggested fix: separate "the snapshot commit does not exist" (`cat-file -e` fails, a real rewrite) from "the snapshot commit exists but is on another branch". For the second case, fall back to a merge-base of the settled sha and HEAD, and print a different, quieter message or none. Do not mint capture duties for paths whose captures were already recorded.

## 10. Copilot's "Previously missed" findings are not surfaced as data

What happened: Copilot's review body can carry a "Previously missed" section. It lists findings in code the push did not change, with "Findings: None" for the new diff and no inline comments. The helper's JSON does not mark this, and the loop only handles `comments`. This project caught the section only through a CLAUDE.md rule telling the conductor to read the review body.

Evidence:
- `scripts/pr-review-wait.mjs:231` returns `review.body` as one raw string, and `:220` returns only comments that carry `pull_request_review_id` of that review. A section that lives in the body only has no entry in `comments`.
- `skills/pr-review-loop/SKILL.md:22` says the helper keeps only the current head's review and tells the conductor to disposition each comment. It does not mention the body.
- A loop that dispositions `comments` and sees an empty list can read a review as clean while the body lists findings.

Status at 0.18.46: still present. New. The raw text is passed through, so the data is reachable; it is not extracted or flagged.

Suggested fix: add a `previously_missed` field to the helper's JSON, parsed from the review body (the section heading and its list items, `[]` when absent). In the skill, say that a review with empty `comments` and non-empty `previously_missed` is not clean. Since the section's format is Copilot's and may change, the fallback should be to flag any non-empty body that has no inline comments.
