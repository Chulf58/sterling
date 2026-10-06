// POST-UPDATE SYNC, shared by H1 (Claude Code) and the Sterling OpenCode server
// plugin (packages/opencode-plugin/src/sync.mjs). An installed Sterling copy
// that is NEWER than a project's sync marker (<project>/.sterling/synced-version)
// runs that project's post-update steps: sync-agents --target <project>, then
// stamp-contract --apply-inserts scoped to it, which writes tracked text that is entirely
// absent from the project's AGENTS.md/CLAUDE.md and only reports wording that is old
// (user-ruled 2026-10-04, "Auto-insert, new text only"). What it inserted is said in the
// banner and the context. An OLDER copy refuses with one loud line
// telling the user to update that host's Sterling; an equal one does nothing
// (decision dual-host-post-update-sync-newest-copy-wins). The marker is per
// project and both hosts write it, so an inequality trigger would downgrade and
// re-upgrade the project on alternate sessions; the version order makes it
// monotonic.
//
// postUpdateSync is for INSTALLED COPIES ONLY (isInstalledCopy). The marker is
// written only after both steps succeed, so a failure retries. Host 'claude' prints
// the bytes H1 printed before this extraction (scripts/tests/post-update-sync.test.mjs
// pins them). A git clone has no version trigger: H1 runs cloneAgentSync (below) when
// its agent-currency check finds installed agents behind the clone's templates, and
// that path never writes the marker. It runs only while the clone has its base branch
// checked out (cloneBranchState). The OpenCode plugin does not call it.
//
// Builtins only: hooks and the OpenCode server bundle vendor this module.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isInstalledCopy } from './installed-copy.mjs';
import { compareSterlingVersions, installHostOf, parseSterlingVersion, sterlingUpdateRemedy } from './sterling-roots.mjs';

// Each step is bounded well inside H1's hooks.json timeout (180s): two steps at
// 60s leave room for the rest of SessionStart.
export const POST_UPDATE_STEP_TIMEOUT_MS = 60_000;

export const SYNC_MARKER_REL = join('.sterling', 'synced-version');

const HOST_TEXT = {
  claude: {
    label: 'H1',
    restartShort: 'agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough)',
    restartLong: 'RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.',
    retry: 'retries at the next session start',
    rerun: 're-runs every session',
  },
  opencode: {
    label: 'OpenCode plugin',
    restartShort: 'agents synced — RESTART to load them (EXIT AND RELAUNCH OpenCode; a /new is NOT enough)',
    restartLong: 'RESTART REQUIRED — agents load when OpenCode starts: EXIT AND RELAUNCH OpenCode before dispatching any agent.',
    retry: 'retries the next time OpenCode starts',
    rerun: 're-runs at every OpenCode start',
  },
};

// How to update an installed copy, by the host that INSTALLED it (installHostOf), not the
// host asking: on a dual-host machine OpenCode can run a Claude-cache copy and H1 an npm
// copy. The OpenCode copy updates through `opencode plugin update` (decision
// sterling-on-opencode-installs-from-a-git-release-branch-v2).
const UPDATE_ROUTE = {
  'claude-code': () => 'update it through /plugin (Installed tab → Update)',
  opencode: (env, home, root) => `update it with ${sterlingUpdateRemedy('opencode', { env, home, root })}`,
};
// A copy under neither install root (installed, so not a git clone, but somewhere the
// resolver does not scan) takes the asking host's own install route.
const ASKING_HOST_INSTALL = { claude: 'claude-code', opencode: 'opencode' };

function hostText(host) {
  const text = HOST_TEXT[host];
  if (!text) throw new TypeError(`post-update sync: unknown host ${JSON.stringify(host)} (expected 'claude' or 'opencode')`);
  return text;
}

/** POSIX-ish path equality: strips a trailing slash and normalizes backslashes, no symlink resolution. */
export function samePath(a, b) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/** The bundled bin/ entry when the plugin ships one, else the clone's scripts/ source. */
export function pluginScript(root, name) {
  const bundled = join(root, 'bin', name);
  return existsSync(bundled) ? bundled : join(root, 'scripts', name);
}

/** plugin.json's version, or null when it is absent or unreadable (the caller reports the SKIP). */
export function readPluginVersion(root) {
  try {
    const v = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    return typeof v === 'string' && v.length ? v : null;
  } catch {
    // absent, unreadable or malformed plugin.json: reported as an unreadable version
  }
  return null;
}

/** { core: [major, minor, patch], pre: [identifiers] } or null for a string that is not semver. */
export const parseVersion = parseSterlingVersion;

/**
 * Semver precedence: -1, 0 or 1, or null when either side is not a version. The order is
 * the resolver's compareSterlingVersions (sterling-roots.mjs), the one comparator both hosts
 * use; this wrapper only turns its throw on a non-version into null.
 */
export function compareVersions(a, b) {
  if (!parseVersion(a) || !parseVersion(b)) return null;
  return compareSterlingVersions(a, b);
}

function stepResult({ error, status, stdout, stderr }) {
  const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
  return { status: error ? null : status, error, out, tail: out.split('\n').slice(-8).join(' | ') };
}

/** Runs one plugin script synchronously (H1). */
export function runStepSync(root, name, args, { nodeBin = process.execPath } = {}) {
  const r = spawnSync(nodeBin, [pluginScript(root, name), ...args], { cwd: root, encoding: 'utf8', timeout: POST_UPDATE_STEP_TIMEOUT_MS });
  return stepResult({ error: r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : null, status: r.status, stdout: r.stdout, stderr: r.stderr });
}

/** Runs one plugin script without blocking the event loop (the OpenCode plugin). */
export function runStepAsync(root, name, args, { nodeBin = process.execPath } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      resolve(stepResult(r));
    };
    let child;
    try {
      child = spawn(nodeBin, [pluginScript(root, name), ...args], { cwd: root, timeout: POST_UPDATE_STEP_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ error: e.message });
      return;
    }
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      spawnError = e;
      // A child that never started emits no 'close' on every Node version.
      if (child.pid === undefined) finish({ error: e.message, stdout, stderr });
    });
    child.on('close', (status, signal) => finish({ error: spawnError ? spawnError.message : signal ? `killed by ${signal}` : null, status, stdout, stderr }));
  });
}

/**
 * The two steps and their verdicts: sync-agents exit 2 is a refusal and any other
 * non-zero a failure; stamp-contract exit 2 is tolerated drift, but any
 * "0 project(s) processed" (exit 0 or a refusal-only exit 2) checked nothing, which is a failure (P5).
 * Returns { ok, detail } or { ok, restart, drift, driftOut, inserted }; `inserted` is one
 * 'action lead' string per section or bullet stamp-contract wrote.
 */
export async function runPostUpdateSteps(root, project, runStep) {
  const sync = await runStep(root, 'sync-agents.mjs', ['--target', project]);
  if (sync.error) return { ok: false, detail: `sync-agents did not run (${sync.error})` };
  if (sync.status === 2) return { ok: false, detail: `sync-agents REFUSED (exit 2 — a locally modified agent, an unsafe path, a foreign or malformed .claude/settings.json, or a project mode or handoff setting it could not read): ${sync.tail}` };
  if (sync.status !== 0) return { ok: false, detail: `sync-agents exited ${sync.status}: ${sync.tail}` };
  const restart = /RESTART REQUIRED|EXIT AND RELAUNCH/.test(sync.out);
  // From here sync-agents has already run: a later failure still carries `restart`,
  // so the user is told agents changed even though the step as a whole failed.
  const contract = await runStep(root, 'stamp-contract.mjs', ['--apply-inserts', '--project', project]);
  if (contract.error) return { ok: false, restart, detail: `stamp-contract did not run (${contract.error})` };
  if (contract.status !== 0 && contract.status !== 2) return { ok: false, restart, detail: `stamp-contract exited ${contract.status}: ${contract.tail}` };
  if (/—\s*0 project\(s\) processed/.test(contract.out)) {
    // Exit 0 or 2: either way nothing was checked. A refusal that processed nothing
    // (e.g. not_migrated, no AGENTS.md) is not drift in a synced project; its reason is named.
    const refusals = contract.out.split('\n').filter((l) => l.startsWith('✗')).map((l) => l.trim());
    if (refusals.length) return { ok: false, restart, detail: `stamp-contract checked NOTHING for ${project} (0 project(s) processed, refused: ${refusals.join('; ')})` };
    return { ok: false, restart, detail: `stamp-contract checked NOTHING for ${project} (0 project(s) processed) — the project is not reachable through the project registry; run /sterling:init here to register it` };
  }
  const inserted = contract.out
    .split('\n')
    .map((l) => /^\s*(section_inserted|inserted) {2}(.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => `${m[1]} ${m[2].trim()}`);
  return { ok: true, restart, drift: contract.status === 2, driftOut: contract.tail, inserted };
}

/**
 * True when the post-update sync applies at all: an installed plugin copy, a project
 * that is not the plugin root itself (a session there is working in Sterling), and a
 * project with .sterling/config.json. Cheap, so callers can test it before any
 * session lookup.
 */
export function postUpdateApplies(root, project) {
  return Boolean(root) && !samePath(project, root) && isInstalledCopy(root) && existsSync(join(project, '.sterling', 'config.json'));
}

/**
 * The post-update sync for one project under the newest-copy-wins rule. Returns
 * null when it does not apply or the versions are equal, else
 * { outcome, warning, context }: outcome is 'skipped', 'refused-older', 'failed' or
 * 'synced'; `warning` is the one-line banner text and `context` the model-facing
 * paragraph (both carry H1's exact spacing). A throw is the caller's to report.
 */
export async function postUpdateSync({ root, project, host = 'claude', runStep = runStepSync, env = process.env, home = homedir() }) {
  const t = hostText(host);
  if (!postUpdateApplies(root, project)) return null;
  const current = readPluginVersion(root);
  const markerPath = join(project, SYNC_MARKER_REL);
  let previous = null;
  try {
    previous = readFileSync(markerPath, 'utf8').trim() || null;
  } catch {
    // absent or unreadable — treated as never synced; the sync is idempotent
  }
  const manifest = join(root, '.claude-plugin', 'plugin.json');
  if (!current) {
    return {
      outcome: 'skipped',
      warning: `⚠ Sterling post-update sync SKIPPED — the installed plugin's version is unreadable (${manifest}). `,
      context: `\n\nPOST-UPDATE SYNC (${t.label}): SKIPPED — ${manifest} carries no readable version, so this project's agents cannot be known current.`,
    };
  }
  if (!parseVersion(current)) {
    return {
      outcome: 'skipped',
      warning: `⚠ Sterling post-update sync SKIPPED — the installed plugin's version '${current}' is not a semver version (${manifest}). `,
      context: `\n\nPOST-UPDATE SYNC (${t.label}): SKIPPED — ${manifest} carries version '${current}', which is not a semver version, so it cannot be ordered against this project's sync marker.`,
    };
  }
  // An absent or non-version marker reads as never synced, as before the version order.
  const order = previous === null ? 1 : compareVersions(current, previous) ?? 1;
  if (order === 0) return null;
  if (order < 0) {
    const update = UPDATE_ROUTE[installHostOf(root, { env, home }) ?? ASKING_HOST_INSTALL[host]](env, home, root);
    return {
      outcome: 'refused-older',
      warning: `✗ Sterling ${current} is OLDER than this project's sync marker ${previous}: post-update sync REFUSED, nothing downgraded — ${update}. `,
      context: `\n\nPOST-UPDATE SYNC REFUSED (${t.label}): this Sterling copy is ${current}, older than this project's sync marker ${previous} (${markerPath}), which a newer Sterling on another host wrote. Nothing was synced, so agents and templates are not downgraded. Tell the user to update this host's Sterling: ${update}.`,
    };
  }
  const hop = `Sterling ${previous ?? '(never synced)'}→${current}`;
  const result = await runPostUpdateSteps(root, project, runStep);
  if (!result.ok) {
    // sync-agents may have refreshed agents before a later step failed: the
    // restart is owed regardless, so it is never hidden behind the failure.
    const restartOwed = result.restart ? ` ${t.restartShort}.` : '';
    return {
      outcome: 'failed',
      warning: `✗ ${hop}: post-update sync FAILED — ${result.detail}.${restartOwed} `,
      context:
        `\n\nPOST-UPDATE SYNC FAILED (${t.label}): ${hop} — ${result.detail}. No marker was written, so it ${t.retry}; tell the user and fix the cause.` +
        (result.restart ? ` sync-agents DID refresh agents before the failure: ${t.restartLong}` : ''),
    };
  }
  let warning = '';
  try {
    writeFileSync(markerPath, `${current}\n`);
  } catch (err) {
    warning = `✗ ${hop}: agents synced, but ${markerPath} could not be written (${err?.code ?? err?.message ?? err}) — the sync ${t.rerun} until it can. `;
  }
  const restartLine = result.restart ? t.restartShort : 'agents synced, none changed';
  warning ||= `⚠ ${hop}: ${restartLine}. `;
  const inserted = result.inserted ?? [];
  if (inserted.length) warning += `AGENTS.md/CLAUDE.md gained new Sterling text (${inserted.length} insert${inserted.length === 1 ? '' : 's'}). `;
  return {
    outcome: 'synced',
    warning,
    context:
      `\n\nPOST-UPDATE SYNC (${t.label}): ${hop} — ${restartLine}.` +
      (result.restart ? ` ${t.restartLong}` : '') +
      (inserted.length ? ` stamp-contract inserted new text into this project's AGENTS.md/CLAUDE.md (text that was entirely absent; no existing wording was replaced): ${inserted.join('; ')}.` : '') +
      (result.drift ? ` Contract drift in this project (stamp-contract, tolerated): ${result.driftOut}` : ''),
  };
}

/** True when the clone agent sync applies: a git clone as plugin root and a project with .sterling/config.json. The clone itself is a project like any other. */
export function cloneAgentSyncApplies(root, project) {
  return Boolean(root) && !isInstalledCopy(root) && existsSync(join(project, '.sterling', 'config.json'));
}

const errCode = (e) => (typeof e?.code === 'string' ? e.code : 'read error');

/**
 * Which branch a git clone has checked out and whether that is its base branch, read
 * from the HEAD file with no git process (git is slow on /mnt/c under WSL2, and H1's
 * own 3000ms git probe already times out there). A linked worktree's `.git` is a file
 * holding `gitdir: <path>`; its HEAD is in that directory and the shared refs are in
 * the directory its `commondir` file names. The base is `main`, or `master` only when
 * the clone has no refs/heads/main, loose or packed. origin/HEAD is not consulted, so
 * a clone whose default branch has another name is never on its base here.
 * Returns { onBase, branch, base, clause }: branch is null on a detached or unreadable
 * HEAD; clause is one line saying why nothing syncs, null when onBase. An unreadable
 * HEAD is not-base. Only error codes are quoted, never file content.
 */
export function cloneBranchState(root) {
  const unreadable = (what) => ({
    onBase: false,
    branch: null,
    base: null,
    clause: `the Sterling clone's checked-out branch could not be read (${what}), so no agents were synced`,
  });
  const dotGit = join(root, '.git');
  let gitDir = dotGit;
  let commonDir = dotGit;
  try {
    if (statSync(dotGit).isFile()) {
      const pointer = /^gitdir: (.+)$/.exec(readFileSync(dotGit, 'utf8').split(/\r?\n/)[0]);
      if (!pointer) return unreadable('.git: no gitdir line');
      gitDir = resolve(root, pointer[1].trim());
      commonDir = gitDir;
      try {
        commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
      } catch (e) {
        // No commondir file: a gitdir that is not a linked worktree (--separate-git-dir) holds its own refs.
        if (e?.code !== 'ENOENT') return unreadable(`commondir: ${errCode(e)}`);
      }
    }
  } catch (e) {
    return unreadable(`.git: ${errCode(e)}`);
  }
  let head;
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8');
  } catch (e) {
    return unreadable(`HEAD: ${errCode(e)}`);
  }
  const ref = /^ref: refs\/heads\/(\S+)\s*$/.exec(head);
  const detached = /^[0-9a-f]{40,64}\s*$/.test(head);
  if (!ref && !detached) return unreadable('HEAD: not a branch or a commit');
  const branch = ref ? ref[1] : null;
  let base = 'main';
  if (branch !== 'main' && !existsSync(join(commonDir, 'refs', 'heads', 'main'))) {
    let packed = '';
    try {
      packed = readFileSync(join(commonDir, 'packed-refs'), 'utf8');
    } catch (e) {
      if (e?.code !== 'ENOENT') return unreadable(`packed-refs: ${errCode(e)}`);
    }
    if (!/^[0-9a-f]+ refs\/heads\/main$/m.test(packed)) base = 'master';
  }
  if (branch === base) return { onBase: true, branch, base, clause: null };
  return {
    onBase: false,
    branch,
    base,
    clause: branch
      ? `the Sterling clone is on branch ${branch}, not its base branch ${base}, so agents sync at session start after the merge`
      : `the Sterling clone is on a detached HEAD, not its base branch ${base}, so agents sync at session start once ${base} is checked out`,
  };
}

// sync-agents status lines that changed a Claude agent file (agentChangesRequireRestart's
// set). The portable `.opencode/agents/` copies print the same statuses and need no restart.
const AGENT_CHANGED_LINE = /^(installed|refreshed|header_repaired|machine_rebaked|retired): (?!\.opencode\/)\S/;

/**
 * CLONE AGENT SYNC (user-ruled 2026-10-06 through the question form, "Sync at session
 * start (Recommended)", current project only): the same two steps on a git clone, where
 * plugin.json's version does not move between template edits and so cannot be the
 * trigger. The CALLER decides that agents are behind (H1's agent-currency hash compare)
 * and passes their file names as `behind`; this function only runs the steps and words
 * the result. It never writes the sync marker, so an installed copy newer than the marker
 * still runs its own sync and nothing here can make one skip it. The newest-copy-wins
 * order still holds: a clone OLDER than the marker refuses, because a newer installed
 * copy synced this project and a hash mismatch would otherwise downgrade its agents.
 * BASE BRANCH ONLY (user-ruled 2026-10-06 through the question form, "Sync only on the
 * base branch (Recommended)"): a clone on any other branch, or on a detached or
 * unreadable HEAD, holds templates that are not merged, so nothing runs and the outcome
 * is 'off-base' with an empty warning and context and a `clause` the caller adds to its
 * own stale warning.
 * Returns null when it does not apply, else { outcome, warning, context } with outcome
 * 'off-base', 'skipped', 'refused-older', 'failed' or 'synced'.
 */
export async function cloneAgentSync({ root, project, behind = [], host = 'claude', runStep = runStepSync }) {
  const t = hostText(host);
  if (!cloneAgentSyncApplies(root, project)) return null;
  const checkedOut = cloneBranchState(root);
  if (!checkedOut.onBase) return { outcome: 'off-base', warning: '', context: '', clause: checkedOut.clause };
  const markerPath = join(project, SYNC_MARKER_REL);
  let previous = null;
  try {
    previous = readFileSync(markerPath, 'utf8').trim() || null;
  } catch {
    // absent or unreadable: no installed copy has synced this project, so nothing can be downgraded
  }
  if (previous !== null && parseVersion(previous)) {
    const current = readPluginVersion(root);
    const order = current === null ? null : compareVersions(current, previous);
    if (order === null) {
      const manifest = join(root, '.claude-plugin', 'plugin.json');
      return {
        outcome: 'skipped',
        warning: `⚠ Sterling clone agent sync SKIPPED — the clone's version (${manifest}) is unreadable or not semver, so it cannot be ordered against this project's sync marker ${previous}. `,
        context: `\n\nCLONE AGENT SYNC (${t.label}): SKIPPED — ${manifest} carries no semver version, so this clone cannot be ordered against this project's sync marker ${previous} (${markerPath}) and syncing could downgrade its agents. Nothing was synced.`,
      };
    }
    if (order < 0) {
      return {
        outcome: 'refused-older',
        warning: `✗ Sterling clone ${current} is OLDER than this project's sync marker ${previous}: agent sync REFUSED, nothing downgraded — pull this clone. `,
        context: `\n\nCLONE AGENT SYNC REFUSED (${t.label}): this Sterling clone is ${current}, older than this project's sync marker ${previous} (${markerPath}), which a newer installed Sterling wrote. Nothing was synced, so agents and templates are not downgraded. Tell the user to pull this clone (${root}).`,
      };
    }
  }
  let syncOut = '';
  const result = await runPostUpdateSteps(root, project, async (r, name, args) => {
    const step = await runStep(r, name, args);
    if (name === 'sync-agents.mjs') syncOut = step.out ?? '';
    return step;
  });
  const changed = syncOut.split('\n').map((l) => l.trim()).filter((l) => AGENT_CHANGED_LINE.test(l));
  const were = behind.length ? ` (${behind.join(', ')})` : '';
  if (!result.ok) {
    // sync-agents refreshes the agents it can before it exits 2 for the one it refuses,
    // so the restart is owed whenever it changed any.
    const restart = Boolean(result.restart) || changed.length > 0;
    return {
      outcome: 'failed',
      warning: `✗ Sterling clone: agent sync FAILED — ${result.detail}.${restart ? ` ${t.restartShort}.` : ''} `,
      context:
        `\n\nCLONE AGENT SYNC FAILED (${t.label}): this project's installed agents are behind the clone's templates${were} — ${result.detail}. Nothing records a clone sync, so it ${t.retry} while an installed agent is behind; tell the user and fix the cause.` +
        (restart ? ` sync-agents DID change agents before the failure${changed.length ? ` (${changed.join('; ')})` : ''}: ${t.restartLong}` : ''),
    };
  }
  const restartLine = result.restart ? t.restartShort : 'agents synced, none changed';
  const inserted = result.inserted ?? [];
  return {
    outcome: 'synced',
    warning:
      `⚠ Sterling clone: installed agents were behind its templates${were} — ${restartLine}. ` +
      (inserted.length ? `AGENTS.md/CLAUDE.md gained new Sterling text (${inserted.length} insert${inserted.length === 1 ? '' : 's'}). ` : ''),
    context:
      `\n\nCLONE AGENT SYNC (${t.label}): this project's installed agents were behind the clone's templates${were} — ${restartLine}.` +
      (changed.length ? ` sync-agents reported: ${changed.join('; ')}.` : '') +
      (result.restart ? ` ${t.restartLong}` : '') +
      (inserted.length ? ` stamp-contract inserted new text into this project's AGENTS.md/CLAUDE.md (text that was entirely absent; no existing wording was replaced): ${inserted.join('; ')}.` : '') +
      (result.drift ? ` Contract drift in this project (stamp-contract, tolerated): ${result.driftOut}` : ''),
  };
}
