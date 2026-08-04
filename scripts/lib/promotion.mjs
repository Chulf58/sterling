// Promotion conditions (spec §6 H9, invariant 6) — ONE definition, two
// consumers: dispose-run (the gate) and the H9 Stop backstop (names the
// outstanding items when the conductor tries to stop mid-completion).
// Returns refusals[]; empty = promotion verified.
import { stateRefusal } from './run-state.mjs';

export function verifyPromotionConditions({ store, config, run }) {
  const refusals = [];
  const refuse = (condition, detail) => refusals.push(`${condition}: ${detail}`);

  if (!config.backup_path && !config.backup_opt_out) {
    refuse('backup_path_missing', 'no backup_path and no recorded opt-out in .sterling/config.json — snapshots are a promotion condition (§2.3)');
  }
  if (run.machine_state !== 'completing') {
    refuse(
      'wrong_state',
      stateRefusal({
        runId: run.id,
        observed: run.machine_state,
        expected: 'completing',
        why: 'Disposal runs only inside the completion sequence (H9).',
      })
    );
  }

  const brief = store.get(run.brief_ref);
  if (!brief || brief.type !== 'brief') {
    // FOUND vs FOUND-BUT-WRONG-TYPE: reporting "not found" for a record that is
    // sitting in the store sends the operator hunting for something that exists.
    refuse(
      'brief_missing',
      brief
        ? `run.brief_ref '${run.brief_ref}' resolves to a '${brief.type}', not a brief — the record EXISTS; the reference points at the wrong record`
        : `brief '${run.brief_ref}' resolves to no record in the store, at any status`
    );
    return { refusals, article: undefined, brief: undefined };
  }

  // feature article written, linked to the originating brief (capture gate ran)
  const allArticles = store.query({ types: ['feature_article'], cap: 1000 });
  const articles = allArticles.filter((a) => a.history.some((h) => h.target_id === brief.id));
  let article;
  if (articles.length === 0) {
    // The old wording asserted "the capture gate did not run", which is only ONE
    // of the causes — and acting on it produces a SECOND article under the same
    // slug, the two-records-one-slug corruption the contract forbids. State what
    // was actually observed and name the fix-forward path first.
    refuse(
      'feature_article_missing',
      `no active feature_article carries a history entry whose target_id is brief '${brief.id}' ` +
        `(${allArticles.length} active feature_article(s) exist in scope). Either capture never ran, OR an owning article ` +
        `exists but its history entry targets something else (a decision, or nothing). CHECK FIRST: if the owning article ` +
        `already exists, knowledge_update it to add the brief-linked history entry — do NOT create a second article for the ` +
        `same area, which would put two records under one slug`
    );
  } else {
    article = articles[0];
  }

  // every article on the reconcile list — brief's (planning-time) UNION the
  // run-accumulated H7 marks — reconciled during the run. The SOURCE is carried
  // through to the refusal: a bad id on the brief's planning-time list is a
  // planning typo, while a bad id among H7's run marks means the hook or the store
  // is at fault — different remedies that one message used to collapse.
  const sourceOf = new Map();
  for (const id of brief.blast_radius.reconcile_list) sourceOf.set(id, "the brief's planning-time reconcile_list");
  for (const id of run.reconcile_needed ?? []) {
    sourceOf.set(id, sourceOf.has(id) ? "both the brief's reconcile_list and H7's run marks" : "H7's run marks (accumulated from actual file touches)");
  }
  for (const id of sourceOf.keys()) {
    const rec = store.get(id);
    const from = sourceOf.get(id);
    if (!rec) {
      refuse(
        'article_unreconciled',
        `reconcile id '${id}' (from ${from}) resolves to no record. ` +
          (from.startsWith("the brief's")
            ? 'A planning-time id that resolves to nothing is a brief defect — correct the brief, or reject the run at the gate.'
            : 'An H7 run mark that resolves to nothing means the record was removed after being marked, or the mark is a hook/store defect — investigate rather than working around it.')
      );
    } else if (rec.status === 'active' && rec.updated_at < run.started_at) {
      refuse(
        'article_unreconciled',
        `${rec.type} '${rec.slug ?? rec.title ?? id}' (${id}, from ${from}) was not reconciled during the run ` +
          `— updated_at ${rec.updated_at} predates run start ${run.started_at}. ` +
          `Remedy: knowledge_update the record so it describes the code as it now is, then rerun disposal` +
          (rec.file_keys?.length ? ` (it declares file_keys: ${rec.file_keys.join(', ')})` : '')
      );
    }
  }

  // decisions captured: handoffs that report decisions require decision records from this run
  const handoffs = store.readHandoffs(run.id);
  const reported = handoffs.flatMap((h) => h.decisions_made);
  if (reported.length > 0) {
    const captured = store.query({ types: ['decision'], cap: 1000 }).filter((d) => d.created_at >= run.started_at);
    if (captured.length === 0) {
      refuse('decisions_uncaptured', `handoffs report ${reported.length} decision(s) made but no decision record was created during the run`);
    }
  }

  // AC-traced tests promoted: UNION across every brief-linked article, not just
  // articles[0] of a query result with NO ordering guarantee (board a9b70305). A
  // run commonly histories an owning article PLUS a concept-family one (decision
  // 7208729b); the trace may legitimately sit on either, so an AC passes when it
  // is traced on ANY of them. `article` (articles[0]) is still returned below as
  // the representative record for callers that need one knowledge_summary target
  // (neither current caller reads it — see dispose-run.mjs / h9-stop-backstop.mjs
  // — but the shape is kept so a future one has a sane default); the tracing and
  // fulfilled-todo checks themselves now read `articles`, all of them.
  //
  // A live_test_refs entry whose test_paths is empty (or missing/non-array) is
  // NOT a trace — same refusal as no entry at all. A vacuous pass here is worse
  // than no gate, because it reports success (board 3800d559).
  if (article) {
    const tracedOn = new Map(); // ac_id -> slug of the first article found tracing it
    for (const a of articles) {
      for (const ref of a.live_test_refs) {
        if (Array.isArray(ref.test_paths) && ref.test_paths.length > 0 && !tracedOn.has(ref.ac_id)) {
          tracedOn.set(ref.ac_id, a.slug);
        }
      }
    }
    const checkedNames = articles.map((a) => a.slug).join(', ');
    for (const ac of brief.acceptance_criteria) {
      if (!tracedOn.has(ac.ac_id)) {
        refuse(
          'ac_untraced',
          `AC '${ac.ac_id}' has no live_test_refs entry with a non-empty test_paths on any of the ` +
            `${articles.length} article(s) historied to this brief (checked: ${checkedNames})`
        );
      }
    }
    // fulfilled todos removed: done = removed (P4) — same union as tracing above,
    // since fulfilled_todo_still_on_board inherited the same arbitrary pick.
    for (const a of articles) {
      for (const link of a.links.filter((l) => l.rel === 'fulfills')) {
        if (store.get(link.target_id)) {
          refuse(
            'fulfilled_todo_still_on_board',
            `article '${a.slug}' fulfills todo '${link.target_id}' but it is still in the store — done = removed (P4)`
          );
        }
      }
    }
  }

  return { refusals, article, brief };
}
