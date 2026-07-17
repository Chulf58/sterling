// Concept-designed registration (decision 7208729b, concept-article layer):
// the conductor appends a concept_designed session event the moment a domain
// concept's design SETTLES in conversation — H10's Stop check then demands the
// family's concept article (feature_article with concept_family) before the
// session ends, and queues a durable concept_article_missing item if it still
// doesn't exist. detail carries the concept FAMILY slug (granularity: one
// article per family — see the reconcile-always contract rule).
//   node scripts/concept-designed.mjs --family <slug> [--family <slug>...] [--target <dir>]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { argAll, arg, fail } from './lib/project.mjs';

const families = argAll('--family');
const target = arg('--target') ?? process.cwd();
if (!families.length) fail('concept-designed: at least one --family required (the concept family slug, e.g. weapons)');

const eventsPath = join(target, '.sterling', 'transient', 'session-events.json');
mkdirSync(dirname(eventsPath), { recursive: true });
const events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
const at = new Date().toISOString();
for (const family of families) events.push({ kind: 'concept_designed', detail: family, at });
writeFileSync(eventsPath, JSON.stringify(events));
console.log(JSON.stringify({ registered: families }));
