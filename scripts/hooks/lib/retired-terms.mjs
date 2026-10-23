// Retired-term notice for delivery (GitHub #188, decision
// retiring-a-renamed-term-a-retired-terms-field-on-the-rename): when a brief
// or question uses a term a rename decision retired, delivery says so and
// names the replacement. Advisory, like all delivery. The matcher is the one
// in packages/schemas (retired-terms.ts); this file only reads the decisions
// and renders the line.
import { collectRetiredTerms, retiredTermsInText, retiredTermWarning } from '@sterling/schemas';

/**
 * The notice for `text`, or '' when it uses no retired term. `store` is the
 * subject fan (project store plus mounted domains), so a project-held rename
 * and a rename held in a mounted domain both apply: the text is this
 * project's own. The read is the store's narrow retiredTermDecisions, which
 * touches no record body that holds no rename.
 *
 * A failure here never takes the rest of the delivery down: it becomes one
 * loud line saying the retired-term check did not run.
 */
export function retiredTermNotice(store, text) {
  if (!text) return '';
  try {
    const terms = collectRetiredTerms(store.retiredTermDecisions());
    if (!terms.length) return '';
    const used = retiredTermsInText(text, terms);
    if (!used.length) return '';
    return ['STERLING RETIRED TERMS — this text uses a term a rename decision retired (advisory):', ...used.map((t) => `  - ${retiredTermWarning(t)}`)].join('\n');
  } catch (e) {
    return `STERLING RETIRED TERMS — the retired-term check FAILED (${(e && e.message) || e}); this text was NOT checked against renamed terms.`;
  }
}
