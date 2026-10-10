// Concept-designed registration (decision foreign_7208729b, concept-article layer):
// the conductor appends a concept_designed session event the moment a domain
// concept's design SETTLES in conversation — H10's Stop check then demands the
// family's concept article (feature_article with concept_family) before the
// session ends, and queues a durable concept_article_missing item if it still
// doesn't exist. detail carries the concept FAMILY slug (granularity: one
// article per family — see the reconcile-always contract rule).
//   node scripts/concept-designed.mjs --family <slug> [--family <slug>...] [--target <dir>]
import { join } from 'node:path';
import { argAll, arg, fail } from './lib/project.mjs';
import { appendSessionEventsAt, SESSION_EVENTS_LOCK_HELD } from './hooks/lib/session-events.mjs';

const families = argAll('--family');
const target = arg('--target') ?? process.cwd();
if (!families.length) fail('concept-designed: at least one --family required (the concept family slug, e.g. weapons)');

const eventsPath = join(target, '.sterling', 'transient', 'session-events.json');
const at = new Date().toISOString();
try {
  appendSessionEventsAt(eventsPath, families.map((family) => ({ kind: 'concept_designed', detail: family, at })));
} catch (e) {
  // Issue #64: a held lock skips the write, named, and never writes unlocked.
  if (e.code === SESSION_EVENTS_LOCK_HELD) fail(`concept-designed: concept_designed event(s) for ${families.join(', ')} NOT registered: ${e.message}`);
  throw e;
}
console.log(JSON.stringify({ registered: families }));
