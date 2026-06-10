// Promotion conditions (spec §6 H9, invariant 6) — ONE definition, two
// consumers: dispose-run (the gate) and the H9 Stop backstop (names the
// outstanding items when the conductor tries to stop mid-completion).
// Returns refusals[]; empty = promotion verified.

export function verifyPromotionConditions({ store, config, run }) {
  const refusals = [];
  const refuse = (condition, detail) => refusals.push(`${condition}: ${detail}`);

  if (!config.backup_path) {
    refuse('backup_path_missing', 'no backup_path in .sterling/config.json — snapshots are a promotion condition (§2.3)');
  }
  if (run.machine_state !== 'completing') {
    refuse('wrong_state', `run '${run.id}' is '${run.machine_state}', not 'completing' — disposal runs only inside the completion sequence (H9)`);
  }

  const brief = store.get(run.brief_ref);
  if (!brief || brief.type !== 'brief') {
    refuse('brief_missing', `brief '${run.brief_ref}' not found in the store`);
    return { refusals, article: undefined, brief: undefined };
  }

  // feature article written, linked to the originating brief (capture gate ran)
  const articles = store
    .query({ types: ['feature_article'], cap: 1000 })
    .filter((a) => a.history.some((h) => h.target_id === brief.id));
  let article;
  if (articles.length === 0) {
    refuse('feature_article_missing', `no active feature_article carries a history entry for brief '${brief.id}' — the capture gate did not run`);
  } else {
    article = articles[0];
  }

  // every article on the reconcile list — brief's (planning-time) UNION the
  // run-accumulated H7 marks — reconciled during the run
  const reconcileIds = new Set([...brief.blast_radius.reconcile_list, ...(run.reconcile_needed ?? [])]);
  for (const id of reconcileIds) {
    const rec = store.get(id);
    if (!rec) {
      refuse('article_unreconciled', `reconcile-list id '${id}' not found in the store`);
    } else if (rec.status === 'active' && rec.updated_at < run.started_at) {
      refuse('article_unreconciled', `article '${id}' was not reconciled during the run (updated_at ${rec.updated_at} < run start ${run.started_at})`);
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

  // AC-traced tests promoted
  if (article) {
    const traced = new Set(article.live_test_refs.map((r) => r.ac_id));
    for (const ac of brief.acceptance_criteria) {
      if (!traced.has(ac.ac_id)) refuse('ac_untraced', `AC '${ac.ac_id}' has no live_test_refs entry on article '${article.slug}'`);
    }
    // fulfilled todos removed: done = removed (P4)
    for (const link of article.links.filter((l) => l.rel === 'fulfills')) {
      if (store.get(link.target_id)) {
        refuse('fulfilled_todo_still_on_board', `article fulfills todo '${link.target_id}' but it is still in the store — done = removed (P4)`);
      }
    }
  }

  return { refusals, article, brief };
}
