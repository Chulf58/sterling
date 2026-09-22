// DISPATCH-PROMPT PARSING — path-candidate extraction over a dispatch
// prompt's TEXT.
//
// THE PARENT-TRANSCRIPT PROMPT READER FUNCTIONS THAT USED TO LIVE HERE ARE
// DELETED (decision `dispatch-state-machine-pre-slot-post-binding-locked-
// start-resolution-replaces-transcript-attribution`): the parent transcript is LAGGED at
// SubagentStart (measured, not assumed) and cannot attribute a prompt to a
// spawn safely by any ordering trick. Every consumer now recovers its own
// prompt (if any) from scripts/lib/dispatch-register.mjs's resolveDispatchStart,
// which resolves a per-dispatch state record instead of reading the transcript
// tail. This file keeps only the TEXT-shaped parser those consumers still
// call once they have a prompt string in hand.
//
// THE REVIEW-TERRITORY STRUCTURED DECLARATION PARSER (parseReviewTerritory,
// decision `review-territory-structured-receipt-files`) IS DELETED — it had
// no non-test reader (research_finding h22-dispatch-register-consumer-map-
// which-parts-have-a-reader-september-2026): h22-dispatch-register.mjs's
// SubagentStart now writes `files` from free-prose extraction only.

// Path-candidate extraction from free-form prompt prose. No shared extractor
// exists yet in this codebase for this shape (grepped: absent) — the nearest
// analog, a bash-command path extractor, does not exist either; this is a
// standalone extractor for prompt TEXT rather than a single shell command.
// Deliberately permissive: a false positive costs one extra store lookup that
// finds nothing; a false negative costs the staging this hook exists to
// provide. Directory segments exclude '.' (so URLs and prose like
// "claude.com/docs" rarely qualify); the filename segment allows '.' for
// multi-dot names (e.g. 'h19-delivery.test.mjs'); the trailing extension group
// is what stops the match before sentence punctuation ('…delivery.mjs.' keeps
// only 'delivery.mjs').
export const PATH_CANDIDATE_RE = /(?:[\w-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10}/g;

export function extractPathCandidates(text) {
  const found = String(text ?? '').match(PATH_CANDIDATE_RE) ?? [];
  return [...new Set(found)];
}
