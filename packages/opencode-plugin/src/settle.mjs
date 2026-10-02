// Settlement at the end of an execution: mint reconcile duties for the files the
// last turn changed, advance the settled snapshot, and notify. The maintenance
// worker launch that follows is worker.mjs.
import { join } from 'node:path';
import { gitTouches, mintSettlementReconcile, writeGitSettled, writeInitialGitSettled } from '../../../scripts/hooks/lib/settlement.mjs';
import { readRegister } from '../../../scripts/lib/dispatch-register.mjs';
import { errText, logLine } from './log.mjs';
import { addNotice, pruneShownNotices } from './notices.mjs';

/**
 * A live Claude Code dispatch means H10 is holding paths it will settle
 * itself, so the snapshot must not advance past them. Any row without
 * `ended` counts; a register that cannot be read counts as live (fail closed).
 */
export function liveDispatch(root) {
  const reg = readRegister(root);
  if (reg.availability === 'absent') return { live: false };
  if (reg.availability !== 'ok') return { live: true, why: `the dispatch register is ${reg.availability}` };
  const rows = reg.entries.filter((e) => !e.ended);
  return rows.length ? { live: true, why: `${rows.length} Claude dispatch(es) still registered (${rows.map((r) => r.agent_id).join(', ')})` } : { live: false };
}

/** The settle step for one execution; `launchWorkerFor(root, at)` runs after a settlement that did not fail. */
export function createSettle({ openStore, now, launchWorkerFor }) {
  async function settle(root) {
    pruneShownNotices(root);
    const at = now();
    const git = gitTouches(root, at);
    if (!git.ok) {
      if (git.reason !== 'no_git') addNotice(root, `Sterling settlement skipped: git could not answer (${git.reason}).`, at);
      return;
    }
    if (!git.settled) {
      writeInitialGitSettled(root, git.next);
      return;
    }
    const dispatch = liveDispatch(root);
    let store;
    try {
      store = openStore(join(root, '.sterling', 'sterling.db'));
      const minted = mintSettlementReconcile(store, root, git.candidates.map((c) => c.path), at);
      if (!dispatch.live) writeGitSettled(root, git.next);
      if (minted.length) {
        const lines = minted.map((m) => {
          const a = store.get(m.article_id);
          return `${a?.slug ?? m.article_id} (${m.paths.join(', ')})`;
        });
        addNotice(root, `Sterling settlement: the last turn changed files owned by ${minted.length} article(s) and queued reconcile duties: ${lines.join('; ')}. Bring each article in line with the change (knowledge_update), or confirm it already is.`, at);
      }
      if (git.base_lost) addNotice(root, `Sterling settlement: the settled commit ${git.settled.sha} is no longer reachable from HEAD ${git.next.sha}; duties for the commits between them were not derived. Reconcile them by hand from git log.`, at);
      if (dispatch.live) addNotice(root, `Sterling settlement: the settled snapshot was not advanced because ${dispatch.why}; Claude Code settles those paths when the dispatch ends.`, at);
    } catch (e) {
      logLine(root, `settle failed: ${errText(e)}`);
      addNotice(root, `Sterling settlement failed (${errText(e)}); the settled snapshot was not advanced, so the next turn retries the same range.`, at);
      return;
    } finally {
      store?.close();
    }
    launchWorkerFor(root, at);
  }

  return settle;
}
