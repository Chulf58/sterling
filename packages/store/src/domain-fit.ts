// DOMAIN DESCRIPTION FIT: which mounted domains' descriptions a record's text
// fits. Deterministic and lexical: it reuses axis.ts's tokenizer, so a TERM
// means here exactly what it means for every other Sterling matcher. The
// caller counts how many domains fit; "exactly one" is the agent-promotion
// rule (decision projects-mount-domains-and-sibling-projects). This module
// only reports fits and never decides to promote. Pure: no fs, no store handle.
import { AXIS_MIN_TERM_LEN, GENERIC_DEV_TERMS, extractAxisTermsUncapped } from './axis.js';

/** Matched description terms a domain needs before it fits. Mirrors
 *  AXIS_MIN_HITS in axis.ts: one shared word is coincidence, two is signal. A
 *  wrong "fits" here can promote a record into the wrong shared domain, so the
 *  default errs toward "no fit" (the record then goes to the user).
 *  HONEST NOTE: 2 is borrowed from the axis threshold, not measured on domain
 *  descriptions; tune it on real promotion outcomes. A description with fewer
 *  distinct terms than this needs all of them (see fitDomains). */
export const DOMAIN_FIT_MIN_TERMS = 2;

export interface DomainDescriptor {
  name: string;
  /** Missing, null or blank: the domain never fits. */
  description?: string | null;
}

export interface DomainFit {
  name: string;
  /** Matched description terms over distinct description terms, in (0, 1]. */
  score: number;
  /** The description terms found in the record, in description rank order. */
  matched: string[];
}

export interface FitDomainsOptions {
  /** Matched description terms required to fit; a positive integer, default
   *  DOMAIN_FIT_MIN_TERMS. Capped at the description's own term count, so a
   *  one-word description can fit on that one word. */
  minTerms?: number;
  /** Domain names never reported (case-insensitive), e.g. ['sterling']. They
   *  still take part in the duplicate-name check. */
  exclude?: string[];
}

/** A description term and a record term match when equal or when one is a
 *  prefix of the other ('account' / 'accounts'), the same symmetric rule as
 *  axis.ts's centrality check. It is not stemming: 'opportunity' and
 *  'opportunities' do not match. */
function termsMatch(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Terms that can carry a subject: the shared extraction minus universal dev
 *  vocabulary ('test', 'build', 'output'), which appears in every record and
 *  would make any description that uses it fit everything. */
function subjectTerms(text: string): string[] {
  return extractAxisTermsUncapped(text).filter((t) => t.length >= AXIS_MIN_TERM_LEN && !GENERIC_DEV_TERMS.has(t));
}

/** The domains whose description fits `recordText`, best first: score
 *  descending, then matched count descending, then name ascending, so the order
 *  never depends on the input order. A domain fits when at least
 *  min(minTerms, its distinct description terms) of those terms appear in the
 *  record. Throws TypeError for non-string text, a non-array domain list, a
 *  malformed entry or a non-string exclude; RangeError for a bad minTerms;
 *  Error for a duplicate domain name (case-insensitive). */
export function fitDomains(
  recordText: string,
  domains: DomainDescriptor[],
  opts: FitDomainsOptions = {}
): DomainFit[] {
  if (typeof recordText !== 'string') throw new TypeError('fitDomains: recordText must be a string');
  if (!Array.isArray(domains)) throw new TypeError('fitDomains: domains must be an array');
  const minTerms = opts.minTerms ?? DOMAIN_FIT_MIN_TERMS;
  if (!Number.isInteger(minTerms) || minTerms < 1) {
    throw new RangeError(`fitDomains: minTerms must be a positive integer, got ${String(minTerms)}`);
  }
  if (opts.exclude !== undefined && (!Array.isArray(opts.exclude) || opts.exclude.some((n) => typeof n !== 'string'))) {
    throw new TypeError('fitDomains: exclude must be an array of strings');
  }
  const excluded = new Set((opts.exclude ?? []).map((n) => n.toLowerCase()));

  const seen = new Set<string>();
  for (const d of domains) {
    if (d === null || typeof d !== 'object' || typeof d.name !== 'string' || d.name.trim() === '') {
      throw new TypeError('fitDomains: every domain needs a non-empty string name');
    }
    if (d.description != null && typeof d.description !== 'string') {
      throw new TypeError(`fitDomains: description of domain '${d.name}' must be a string`);
    }
    const key = d.name.toLowerCase();
    if (seen.has(key)) throw new Error(`fitDomains: duplicate domain name '${d.name}'`);
    seen.add(key);
  }

  const recordTerms = subjectTerms(recordText);
  const fits: DomainFit[] = [];
  for (const d of domains) {
    if (excluded.has(d.name.toLowerCase()) || !d.description) continue;
    const descTerms = subjectTerms(d.description);
    if (!descTerms.length) continue;
    const matched = descTerms.filter((dt) => recordTerms.some((rt) => termsMatch(dt, rt)));
    if (matched.length < Math.min(minTerms, descTerms.length)) continue;
    fits.push({ name: d.name, score: matched.length / descTerms.length, matched });
  }
  return fits.sort(
    (a, b) => b.score - a.score || b.matched.length - a.matched.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}
