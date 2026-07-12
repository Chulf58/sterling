// Cleanup-plan evidence [S] (spec §8.4): the deletion plan's mechanical input.
// deprecated/dormant articles + deletion_candidate queue entries; the
// articles' file/dependency data is the evidence that makes deletion safe.
//   node scripts/cleanup-plan.mjs [--target <dir>]
import { arg, openProject } from './lib/project.mjs';

const target = arg('--target') ?? process.cwd();
const { store } = openProject(target);
try {
  const articles = store.query({ types: ['feature_article'], cap: 1000 });
  // "active" = not itself a cleanup candidate — a dependent that is deprecated/dormant does not block.
  const activeById = new Map(articles.filter((a) => a.state !== 'deprecated' && a.state !== 'dormant').map((a) => [a.id, a]));
  const candidates = articles
    .filter((a) => a.state === 'deprecated' || a.state === 'dormant')
    .map((a) => {
      // relies_on names articles by SLUG (pinned convention, decision 474b1c71); id accepted as a legacy fallback.
      const active_dependents = articles
        .filter((other) => other.id !== a.id && activeById.has(other.id) && (other.dependencies.relies_on.includes(a.slug) || other.dependencies.relies_on.includes(a.id)))
        .map((d) => ({ id: d.id, slug: d.slug }));
      return {
        article: a.id,
        slug: a.slug,
        state: a.state,
        files: a.files.map((f) => f.path),
        traced_tests: a.live_test_refs.flatMap((r) => r.test_paths),
        active_dependents,
        deletable: active_dependents.length === 0,
      };
    });
  const queue = store
    .query({ types: ['todo'], cap: 1000 })
    .filter((t) => t.source === 'system' && t.system_reason === 'deletion_candidate')
    .map((t) => ({ id: t.id, text: t.text, file_keys: t.file_keys ?? [] }));
  console.log(JSON.stringify({ candidates, queue }, null, 2));
} finally {
  store.close();
}
