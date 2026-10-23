// Retired-term notice for delivery (GitHub #188, decision
// retiring-a-renamed-term-a-retired-terms-field-on-the-rename): when a brief
// or question uses a term a rename decision retired, delivery says so and
// names the replacement. Advisory, like all delivery. The matcher is the one
// in packages/schemas (retired-terms.ts); this file only reads the decisions
// and renders the line.
import { collectRetiredTerms, retiredTermsInText, retiredTermWarning } from '@sterling/schemas';

/** Read window: every decision, never a ranked top-N. */
const DECISION_SCAN_CAP = 1_000_000;

/**
 * The notice for `text`, or '' when it uses no retired term. `store` is the
 * subject fan (project store plus mounted domains), so a project-held rename
 * and a rename held in a mounted domain both apply: the text is this
 * project's own.
 */
export function retiredTermNotice(store, text) {
  if (!text) return '';
  const decisions = store.query({ types: ['decision'], cap: DECISION_SCAN_CAP }).filter((d) => Array.isArray(d.retired_terms));
  if (!decisions.length) return '';
  const used = retiredTermsInText(text, collectRetiredTerms(decisions));
  if (!used.length) return '';
  return ['STERLING RETIRED TERMS — this text uses a term a rename decision retired (advisory):', ...used.map((t) => `  - ${retiredTermWarning(t)}`)].join('\n');
}
