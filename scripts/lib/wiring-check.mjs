// H12 — wiring + zero-consumer check (spec §6 H12): a run-completion script
// (part of FINAL completeness), not a per-edit hook. Static half: new exports
// referenced only by tests = built-but-not-wired → block unless dormancy was
// declared (then a wire_in_dormant todo carries the obligation). The dynamic
// half is the end-to-end AC tests. Analysis itself is an adapter capability
// (§9.1 static_wiring); absent capability skips LOUDLY, never passes.
import { randomUUID } from 'node:crypto';

export function runWiringCheck({ adapterModule, cwd, scope, article, store, now }) {
  if (!adapterModule.capabilities?.static_wiring) {
    return {
      violations: [],
      skipped: { check: 'wiring-zero-consumer', reason: `capability_absent:${adapterModule.name}` },
    };
  }
  // adapter contract: staticWiring -> { test_only_exports: [{ file, name }] }
  const result = adapterModule.staticWiring({ cwd, scope });
  const offenders = result.test_only_exports ?? [];
  if (offenders.length === 0) return { violations: [], skipped: null };

  if (article?.state === 'dormant') {
    // deliberate dormancy: declared + tracked, never silent (§3.2.3).
    // Dedupe is enqueueSystemTodo's job now (system_reason + feature_link key,
    // scanned inside the write transaction) — the old query-then-pointer-
    // fallback dance existed only to avoid the dangling-pointer duplicate bug
    // (R2 board 6308d805), which the choke's own query-based scan already
    // prevents by construction.
    const { record } = store.enqueueSystemTodo({
      id: randomUUID(),
      type: 'todo',
      created_at: now,
      updated_at: now,
      author: 'system',
      status: 'active',
      superseded_by: null,
      links: [],
      scope: 'project',
      stack_tags: [],
      text: `wire in dormant feature '${article.slug}': ${offenders.map((o) => `${o.file}:${o.name}`).join(', ')}`,
      source: 'system',
      system_reason: 'wire_in_dormant',
      feature_link: article.id,
    });
    return { violations: [], skipped: null, dormant: true, wire_in_dormant_todo: record.id };
  }

  return {
    violations: offenders.map((o) => `built-but-not-wired: export '${o.name}' in '${o.file}' is referenced only by tests (H12) — wire it in or declare dormancy`),
    skipped: null,
  };
}
