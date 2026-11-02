// Checkout evidence for reconcile debt (decision
// maintenance-reconciliation-retains-checkout-evidence-and-use). One home for
// three consumers: the minters (settlement.mjs, the MCP server's read-time
// drift check) record what a checkout observed, and the worker's launcher and
// the MCP server's worker policy prove whether that observation is part of the
// committed snapshot the shared reconciliation reads. Dependency-free (node
// builtins and git), so the hook bundles can inline it.
//
// AN OBSERVATION is one path as one checkout saw it: the checkout's locator
// (a tag saying where to look, never proof of anything), the checkout's HEAD
// commit at that moment, and the path's state: a file (git mode + blob id of
// the bytes read), absent, unreadable, or unknown (a legacy item that kept no
// evidence).
//
// PAYABLE means every observation of an item is INTEGRATED into the captured
// target commit T of the record's authoritative tree. Exactly two proofs
// count: (1) T holds the observed state at the path; (2) the observation was
// of committed content (its own commit C holds the observed state) and C is an
// ancestor of T. A DIRTY observation (C does not hold the state) pays only by
// (1); unmatched, it waits in the store checkout and is the conductor's from
// any other checkout: no commit can be shown to be the later commit of THAT edit, because a
// checkout reset to an old commit can observe a state some older descendant
// already held (and T may since have reverted), so a matching commit after C
// proves nothing about this observation. A matching blob anywhere else in
// history, an article baseline, a branch tip, or a checkout that no longer
// exists proves nothing either. Unknown, unreadable and
// unresolvable evidence is held for the conductor; evidence that is merely not
// integrated yet is held until it is. The proofs cover the captured commits
// and the bytes read, never edits nobody has observed yet.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const HEX = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function git(root, args, input) {
  const r = spawnSync('git', ['-C', root, ...args], { input, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, status: r.status, out: r.stdout ? r.stdout.toString('utf8') : '', err: r.error?.message ?? (r.stderr ? r.stderr.toString('utf8').trim() : '') };
}

const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** HEAD commit of `root`, or null when git cannot answer. */
export function headCommit(root) {
  const r = git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const head = r.out.trim();
  return r.ok && HEX.test(head) ? head : null;
}

/**
 * Where `root` sits: its HEAD, its prefix inside the git top-level, and a
 * locator tag. `storeRoot` is the project store's checkout: the same top-level
 * is {kind:'store'}; any other checkout is {kind:'checkout', worktree, branch?},
 * worktree being git's admin name ('main' for the primary checkout). Names are
 * reusable, so a locator never proves lifetime or payment. Null when git
 * cannot answer.
 */
export function checkoutIdentity(root, storeRoot) {
  const head = headCommit(root);
  const r = git(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel', '--show-prefix']);
  if (!head || !r.ok) return null;
  const [gitDir, commonDir, top, prefix = ''] = r.out.split('\n');
  const common = realOr(resolve(root, commonDir));
  const sameTop = storeRoot && realOr(top) === realOr(storeRoot);
  let checkout;
  if (sameTop) checkout = { kind: 'store' };
  else {
    const branch = git(root, ['symbolic-ref', '-q', 'HEAD']).out.trim();
    checkout = { kind: 'checkout', worktree: realOr(gitDir) === common ? 'main' : basename(gitDir), ...(branch ? { branch } : {}) };
  }
  return { head, prefix: prefix.trim(), checkout };
}

function workingState(root, rel) {
  let st;
  try {
    st = lstatSync(join(root, rel));
  } catch (e) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'unreadable' };
  }
  let mode;
  let bytes;
  let filters = true;
  try {
    if (st.isSymbolicLink()) {
      mode = '120000';
      bytes = Buffer.from(readlinkSync(join(root, rel)));
      filters = false;
    } else if (st.isFile()) {
      mode = st.mode & 0o111 ? '100755' : '100644';
      bytes = readFileSync(join(root, rel));
    } else return { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
  const r = git(root, ['hash-object', '--stdin', ...(filters ? [`--path=${rel}`] : ['--no-filters'])], bytes);
  const blob = r.out.trim();
  return r.ok && HEX.test(blob) ? { kind: 'file', mode, blob } : { kind: 'unreadable' };
}

/**
 * Observe `paths` (repo-relative to `root`) in the checkout at `root`. Returns
 * {head, checkout, observations} or null when git cannot answer (the caller
 * then mints without evidence, which every later proof reads as unknown).
 */
export function observePaths(root, paths, storeRoot) {
  const id = checkoutIdentity(root, storeRoot);
  if (!id) return null;
  const observations = [...new Set(paths)].sort().map((path) => ({ path, checkout: id.checkout, commit: id.head, state: workingState(root, path) }));
  return { head: id.head, checkout: id.checkout, observations };
}

/**
 * The state of `rel` in `commit`'s tree, read from the object store by its
 * exact name: {kind:'file', mode, blob}, {kind:'absent'}, {kind:'other'}, or
 * null when git cannot answer.
 */
export function treeState(root, commit, rel, prefix = '') {
  const name = prefix + rel;
  const r = git(root, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', name]);
  if (!r.ok) return null;
  for (const entry of r.out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    if (entry.slice(tab + 1) !== name) continue;
    return type === 'blob' && /^(100644|100755|120000)$/.test(mode) ? { kind: 'file', mode, blob: oid } : { kind: 'other' };
  }
  return { kind: 'absent' };
}

const sameState = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind !== 'file' || (a.mode === b.mode && a.blob === b.blob));

/**
 * Is one observation integrated into `target` (a commit of the git checkout at
 * `treeRoot`)? {ok:true, via} or {ok:false, hold:'conductor'|'integration', why}.
 */
export function proveObservation(treeRoot, target, obs, { prefix = '' } = {}) {
  const at = (c) => String(c).slice(0, 8);
  const held = (hold, why) => ({ ok: false, hold, why: `${obs.path}: ${why}` });
  const kind = obs?.state?.kind;
  if (kind === 'unknown' || kind === undefined) return held('conductor', 'no checkout evidence was kept for this debt (legacy or incomplete item)');
  if (kind === 'unreadable') return held('conductor', `the observing checkout could not read the file at ${at(obs.commit)}`);
  // The exact target state is checked FIRST: it needs nothing from the
  // observing checkout's commit, so a squashed and garbage-collected origin
  // still pays when T holds exactly what was observed.
  const atTarget = treeState(treeRoot, target, obs.path, prefix);
  if (!atTarget) return held('conductor', `git could not read ${at(target)}`);
  if (sameState(atTarget, obs.state)) return { ok: true, via: 'target_holds_observed_state' };
  if (!HEX.test(obs.commit ?? '') || !git(treeRoot, ['cat-file', '-e', `${obs.commit}^{commit}`]).ok) {
    return held('conductor', `the observed commit ${at(obs.commit)} is not in this repository and the target does not hold the observed state`);
  }
  const where = obs.checkout?.kind === 'checkout' ? `checkout '${obs.checkout.worktree}'${obs.checkout.branch ? ` (${obs.checkout.branch})` : ''}` : 'the store checkout';
  const atCommit = treeState(treeRoot, obs.commit, obs.path, prefix);
  if (!atCommit) return held('conductor', `git could not read ${at(obs.commit)}`);
  if (!sameState(atCommit, obs.state)) {
    // An uncommitted state the target does not hold. In the STORE checkout it
    // waits: that checkout's own settlement re-observes every later state of
    // the path and replaces this one. From any other checkout it is ambiguous
    // (no commit can be shown to carry THAT edit), so it is the conductor's.
    // The reason names no target commit, so it does not change when T does.
    return obs.checkout?.kind === 'store'
      ? held('integration', `the store checkout's uncommitted change observed on ${at(obs.commit)} is not committed in the target yet`)
      : held('conductor', `the uncommitted change ${where} observed on ${at(obs.commit)} is not what the target holds, and no commit can be shown to carry it`);
  }
  const anc = git(treeRoot, ['merge-base', '--is-ancestor', obs.commit, target]);
  if (anc.ok) return { ok: true, via: 'committed_ancestor' };
  if (anc.status === 1) return held('integration', `the commit ${where} observed (${at(obs.commit)}) is not in ${at(target)} yet`);
  return held('conductor', `git could not compare ${at(obs.commit)} with ${at(target)}`);
}

/**
 * Can debt `item` (a reconcile_needed todo) be paid from `target` in
 * `treeRoot`? Every file_key needs evidence, and every observation must be
 * integrated. Returns {payable, holds:[{hold, why}]}; one 'conductor' hold
 * makes the item the conductor's, otherwise it waits for integration.
 */
export function itemProvenance(item, treeRoot, target, opts = {}) {
  const obs = Array.isArray(item?.observations) ? item.observations : [];
  const holds = [];
  for (const key of item?.file_keys ?? []) {
    if (!obs.some((o) => o.path === key)) holds.push({ hold: 'conductor', why: `${key}: no checkout evidence was kept for this debt (legacy or incomplete item)` });
  }
  const seen = new Set();
  for (const o of obs) {
    const k = JSON.stringify(o);
    if (seen.has(k)) continue;
    seen.add(k);
    const r = proveObservation(treeRoot, target, o, opts);
    if (!r.ok) holds.push({ hold: r.hold, why: r.why });
  }
  return { payable: holds.length === 0, conductor: holds.some((h) => h.hold === 'conductor'), holds };
}

/** The prefix of `root` inside its git top-level ('' at the top), or null. */
export function prefixOf(root) {
  const r = git(root, ['rev-parse', '--show-prefix']);
  return r.ok ? r.out.trim() : null;
}

/**
 * The committed bytes of `rel` in `commit` (a regular file only), read from
 * the object store, never the working tree; null when the path is absent, not
 * a regular file, or git cannot answer. Worker writes take their baselines
 * from these bytes, so a baseline is bound to the snapshot the proof used.
 */
export function blobText(root, commit, rel, prefix = '') {
  const st = treeState(root, commit, rel, prefix);
  if (!st || st.kind !== 'file' || st.mode === '120000') return null;
  const r = spawnSync('git', ['-C', root, 'cat-file', 'blob', st.blob], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return !r.error && r.status === 0 ? r.stdout : null;
}
