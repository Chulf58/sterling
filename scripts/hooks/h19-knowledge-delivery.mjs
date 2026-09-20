// H19 — knowledge delivery (decision 6dfbe675; concept family
// knowledge-delivery). The front half of the learning loop: put the owning
// article IN FRONT of the agent at file-touch, mechanically — never a gate
// (AC7: this hook must never exit 2). Since decision ca23c811 the payload also
// carries the path's HAZARDS (anti_pattern, as substance) and its RATIONALE
// (decision, as capped pointers) — articles alone answer neither "what must I
// not do here" nor "why is it this way". Registered at PostToolUse
// Read|Edit|Write|MultiEdit. Delivery is direct at PostToolUse; legacy
// injection_rung values receive one migration notice and otherwise behave as read.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, exitAfterWrite, openStore, loadConfig, repoRel, gitIgnored } from './lib/common.mjs';
import {
  guardPath,
  readGuard,
  writeGuard,
  renderArticle,
  isOwnerDiscoveryOnly,
  renderReference,
  renderHazards,
  cappedHazards,
  renderDecisionPointers,
  DECISION_POINTER_CAP,
  rankFileDecisionPointers,
  lineSuspectBlock,
  joinSuspectBlock,
  renderPayload,
  isSubstanceDelivered,
  isDiscoveryDelivered,
  markSubstanceDelivered,
  markDiscoveryDelivered,
  budgetKnownGaps,
  assembleDelivery,
  hazardParts,
  recordRevision,
  resolveTotalCap,
  ownerPointer,
  ownerSuffix,
  decisionBlockPointer,
  claimLegacyInjectionRungNotice,
} from './lib/delivery.mjs';

const input = readStdin();

// THE BODY IS A FUNCTION, AND EVERY TERMINAL CALL INSIDE IT IS A `return`
// (decision hook-stdout-exit-after-write-callback-bound-exit-deny-stays-
// synchronous). On the INJECT path the process now exits inside the stdout
// write callback, so a bare `allow()` no longer stops what follows it the way a
// hard exit did; returning is what preserves that.
function main(input) {
  const rel = repoRel(input.tool_input?.file_path, input.cwd);
  if (!rel) return allow(); // outside the repo: no delivery jurisdiction
  if (rel === '.git' || rel.startsWith('.git/')) return allow(); // machinery internals (H7 precedent)
  if (rel.startsWith('.sterling/')) return allow(); // the store's own tree is never governed territory

  const store = openStore(input.cwd);
  if (!store) return allow(); // not a Sterling project — no ceremony (P1)

  try {
    // Step 2 accepts old config values only to issue a one-time migration notice.
    const rawRung = loadConfig(input.cwd)?.delivery?.injection_rung;
    const event = input.hook_event_name;

    if (event !== 'PostToolUse') return allow();
    const migrationNotice = claimLegacyInjectionRungNotice(input.cwd, rawRung);
    const mode = 'inject';

    // The staged-pipeline skip (`if (run && input.agent_id) return allow()` —
    // prep.mjs had already staged the agent's knowledge pack) was removed with
    // the pipeline itself (scale-down decision
    // sterling-claude-code-scale-down-boundary, 2ad87dd1): every subagent now
    // gets ordinary delivery like the conductor.

    const owners = store
      .query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 })
      .filter((r) => !r.working_tree);

    // HAZARDS AND RATIONALE FOR THIS PATH (decision ca23c811). Articles answer
    // "what is this and how must it behave"; they do NOT answer "what must I not
    // do here" or "why is it this way" — those live in anti_pattern and decision,
    // both of which carry file_keys and neither of which delivery served. An
    // anti_pattern naming the exact path being edited was invisible while H10
    // asked at Stop whether a hazard had been RECORDED; a consuming project
    // shipped the very bug its stored anti_pattern described. Queried SEPARATELY
    // from owners because these types do NOT confer ownership — the frontier
    // signal still fires for territory no article owns.
    const hazards = store.query({ types: ['anti_pattern'], file_keys: [rel], cap: 100 });
    const decisions = store.query({ types: ['decision'], file_keys: [rel], cap: 100 });

    const gPath = guardPath(input.cwd, input.agent_id, input.session_id);
    const guard = readGuard(gPath);

    // Dedup by record id, not by file: a new file owned by an already-delivered
    // article re-arms nothing (the article is in context); a new owning record
    // always delivers (scope-growth re-arm). Hazards and decisions share the one
    // ledger — their ids are ids like any other.
    // Hazards render as SUBSTANCE here (whole hazard block) — freshness
    // checks ONLY the substance ledger, so a record shown elsewhere as a mere
    // discovery pointer (H20, or the Bash rung's owner pointer line) still
    // qualifies for its real delivery here (decision 92088a62: "a record
    // shown as discovery still qualifies for substance later" — the
    // regression case this closes is an H20 article POINTER suppressing the
    // later full H19 article).
    const freshHazards = hazards.filter((r) => !isSubstanceDelivered(guard, r));
    // OWNERS SPLIT BY WHAT THEY WILL ACTUALLY RENDER AS (fix-round MEDIUM 3):
    // a reference_material or an oversize (digested) article NEVER renders as
    // substance — filtering it against `isSubstanceDelivered` alone means
    // that check is permanently false and the SAME pointer/digest re-delivers
    // on every single touch, forever (a deterministic once-per-context guard
    // failure, not the acceptable duplicate a lost guard write can cause).
    // `isOwnerDiscoveryOnly` is the ONE place that decision is made — the
    // SAME predicate `ownerPart` below uses for `contentClass`, so the two
    // can never drift apart.
    const freshOwners = owners.filter((r) => (isOwnerDiscoveryOnly(r) ? !isDiscoveryDelivered(guard, r) : !isSubstanceDelivered(guard, r)));
    // RANKED ONCE, HERE, AND NOWHERE ELSE (board: H19 file-touch decision cap,
    // measured 2026-09-06). The store's file_keys join degenerates to newest-first
    // on a single path, so on a file carrying more decisions than
    // DECISION_POINTER_CAP the older standing rulings were dropped — see
    // rankFileDecisionPointers for the order and why centrality is not it. Ranking
    // at the single point where the array is BORN is what keeps the guard slice
    // (below), the render recipe and the renderer call all reading the SAME order:
    // re-sorting at any one of those three sites would mark one set delivered
    // while the payload showed another, which is the silent-loss shape the
    // "guard only what was actually rendered" note below exists to prevent.
    // Decisions render as DISCOVERY everywhere (a pointer line, never a full
    // body) — freshness checks the discovery ledger.
    const freshDecisions = rankFileDecisionPointers(decisions.filter((r) => !isDiscoveryDelivered(guard, r)));
    // The frontier signal stays once per file per session (grill answer: solve,
    // not accept), but it is now the payload HEADER rather than a separate
    // emission that returned early. That early return was why a hazard in UNOWNED
    // territory — the reporting project's exact case — was swallowed.
    // A gitignored path is never governed territory (board 1de3653b): no article
    // will ever own it and H10 will not demand one, so the frontier signal — whose
    // whole message is "H10 will demand an article here" — would be false on it.
    // gitIgnored's null (git cannot answer) degrades TOWARD signaling: unowned
    // stands, exactly the pre-feature behavior. Checked only on unowned paths so
    // the owned-territory fast path spawns nothing.
    const bare = owners.length === 0;
    const unowned = bare && !(gitIgnored([rel], input.cwd)?.has(rel) ?? false);
    const frontierFresh = unowned && !guard.frontier_files.includes(rel);
    if (!freshOwners.length && !freshHazards.length && !freshDecisions.length && !frontierFresh) {
      if (migrationNotice) {
        return exitAfterWrite(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: migrationNotice } }), 0);
      }
      return allow();
    }

    const charCap = loadConfig(input.cwd)?.delivery?.payload_char_cap ?? 2400;
    // GUARD ONLY WHAT WAS ACTUALLY RENDERED (correctness review 2026-07-30). The
    // decision cap means freshDecisions can exceed what the payload shows, and
    // marking the unshown ones delivered is silent loss with no detector: a later
    // touch of a DIFFERENT file governed by the same decisions would find them all
    // guarded and print no DECISIONS block at all — not even the count. Guarding
    // only the rendered slice makes the remainder surface on a later touch instead,
    // which is the same "never mark delivered what was not delivered" rule the
    // side-effect-first ordering below enforces for the payload as a whole.
    // Hazards guard the severity-sorted RENDERED slice only, mirroring the
    // decision cap below (board a470046d slice 1): a hazard capped out of this
    // payload must surface on a later touch, not vanish as 'delivered'.
    // The SHOWN slices are named once and reused for the guard, the line-suspect
    // scan AND the assembler parts below: re-deriving the slice in more than one
    // place is how a record the reader never saw gets promoted into a mark it
    // never earned.
    const shownHazards = cappedHazards(freshHazards);
    const shownDecisions = freshDecisions.slice(0, DECISION_POINTER_CAP);
    const fresh = [...freshOwners, ...shownHazards, ...shownDecisions];

    // KNOWN_GAPS INLINE (decision db3392db Part 3 / 53fd6f62, board 3dbbdb35):
    // one GLOBAL 3-gap budget across every fresh owner in THIS delivery — never
    // per-article — computed over freshOwners in their own delivery order so an
    // article that does not re-render this session (already guarded) never
    // re-offers its gaps either (dedup rides the existing lineage guard above,
    // not a separate ledger).
    const gapsByOwner = budgetKnownGaps(freshOwners);

    // LINE-SUSPECT ADVISORY (board 04ccecb1-a338-4b4e-91f0-c99588c1cdce). `fresh`
    // is exactly the set this touch renders. A path can disappear between the
    // tool call and this scan, in which case the advisory has no mtime to compare;
    // other failures are hook failures and reach the loud outer boundary.
    // Kept as the DECOMPOSED {header, lines:[{id,line}], footer} block, not a
    // pre-joined string, so the recipe can carry each line keyed by the record it
    // names and the drain can re-resolve them (fixer M1).
    let suspectBlock = null;
    let mtimeMs = null;
    try {
      mtimeMs = statSync(join(input.cwd, rel)).mtimeMs;
    } catch (e) {
      // The file may have been removed or an ancestor replaced after PostToolUse.
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
    }
    if (mtimeMs !== null) {
      const escapedRel = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Negative lookbehind on a path/word character keeps a citation of a
      // DIFFERENT file that merely ENDS with `rel` (e.g. 'other/src/a.mjs:7'
      // against rel 'src/a.mjs') from matching as if it named rel itself. The
      // scan surface is the STRINGIFIED record, where a newline/tab in prose is
      // the two characters `\` `n` — a line-initial citation would sit behind a
      // literal `n` (a \w) and be wrongly suppressed, so an escape-sequence
      // lookbehind explicitly re-admits it (review finding 2026-08-21).
      const lineTokenRe = new RegExp(`(?:(?<=\\\\[nt])|(?<![\\w./-]))${escapedRel}:\\d+(?:-\\d+)?`, 'g');
      const suspects = [];
      for (const record of fresh) {
        // History is FROZEN PROVENANCE — an old entry legitimately cites lines
        // as of its own moment, so it never makes a record line-suspect; only
        // the live body fields are scanned (same decomposition recordSizes uses).
        const { history: _history, ...liveBody } = record;
        const tokens = [...new Set(JSON.stringify(liveBody).match(lineTokenRe) ?? [])];
        if (!tokens.length) continue; // no citation of rel's line position at all
        const updatedAtMs = Date.parse(record.updated_at ?? '');
        if (!Number.isFinite(updatedAtMs) || updatedAtMs >= mtimeMs) continue; // fresh — not suspect
        suspects.push({ record, tokens });
      }
      if (suspects.length) suspectBlock = lineSuspectBlock(suspects, charCap);
    }

    // Hazards LEAD: "do not do this here" outranks the description of what the
    // territory is, and the reader may stop after the first block. The
    // line-suspect block, if any, trails everything else — it is a footnote on
    // knowledge already delivered above, not knowledge in its own right.
    const blocks = [
      ...renderHazards(freshHazards, charCap, { fileKeys: [rel] }),
      ...freshOwners.map((r) =>
        r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, { gaps: gapsByOwner.get(r.id) })
      ),
      ...(freshDecisions.length ? [renderDecisionPointers(rel, freshDecisions)] : []),
      // joinSuspectBlock returns '' when no line survives; the filter keeps an
      // empty advisory shell out of the payload exactly as the drain does.
      joinSuspectBlock(suspectBlock ?? {}),
    ].filter((b) => typeof b === 'string' && b);
    const payload = renderPayload(rel, blocks, { unowned });

    let injectPayload = payload;
    let emittedSubstance = [];
    let emittedDiscovery = [];
    if (mode === 'inject') {
      // PER-DELIVERY TOTAL CAP (scale-down Slice 3c; see assembleDelivery in
      // lib/delivery.mjs — the ONE ASSEMBLER, decision 92088a62). Hazards are
      // complete, unbudgeted substance; owners, decisions and the line-suspect
      // footnote share what remains of the cap, degrading to `knowledge_get
      // <id>` pointers. Only the assembler's OWN returned emittedSubstance/
      // emittedDiscovery sets — never a UUID scan of the composed text — may
      // ever be persisted to the guard below.
      const totalCap = resolveTotalCap(input.cwd);
      // CONTENT CLASS BY WHAT WAS ACTUALLY RENDERED (fix-round HIGH 2 / MEDIUM
      // 3): a reference_material owner renders ONLY a pointer (renderReference),
      // and an oversize feature_article renders a DIGEST (renderArticle's own
      // bounded, disclosed partial view, never the complete record) — neither
      // is "complete text", so neither may spend a substance mark. Only a
      // normal (non-digested) feature_article, now rendered WHOLE (no more
      // pre-clip — see renderArticle), is substance. `isOwnerDiscoveryOnly` is
      // the SAME predicate `freshOwners` above filters against, so the
      // freshness ledger and the rendered contentClass can never disagree.
      const ownerPart = (r) => {
        const text = r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, { gaps: gapsByOwner.get(r.id) });
        const contentClass = isOwnerDiscoveryOnly(r) ? 'discovery' : 'substance';
        return { kind: 'ordinary', contentClass, identity: r.id, revision: recordRevision(r), text, pointer: ownerPointer(text, r), suffix: ownerSuffix(r) };
      };
      const decisionWiden = `knowledge_query types:["decision"] file_keys:["${rel}"] cap:${freshDecisions.length}`;
      const ownerParts = freshOwners.map(ownerPart);
      const suspectParts = [{ kind: 'ordinary', contentClass: 'chrome', text: joinSuspectBlock(suspectBlock ?? {}) }];
      const shownPathDecisions = freshDecisions.slice(0, DECISION_POINTER_CAP);
      const decisionParts = [
        ...(freshDecisions.length
          ? [
              {
                kind: 'ordinary', contentClass: 'discovery',
                identities: shownPathDecisions.map((d) => ({ identity: d.id, revision: recordRevision(d) })),
                text: renderDecisionPointers(rel, freshDecisions),
                pointer: decisionBlockPointer(freshDecisions.length, decisionWiden),
                suffix: `  … the rest held back by the delivery cap — ${decisionWiden}`,
              },
            ]
          : []),
      ];
      const tailParts = [...ownerParts, ...decisionParts, ...suspectParts];

      // MIGRATION NOTICE CHARGED ON THE CAP TOO (fix-round HIGH 4): this used
      // to be string-prepended AFTER assembly at the final stdout write, so
      // its bytes escaped the total cap entirely — the same class of bug
      // decision 92088a62 requires closing for every chrome source. Folded in
      // as a LEADING pinned-but-charged part instead, exactly like the active-
      // plan line in h19-dispatch-staging.mjs.
      const migrationNoticeParts = migrationNotice ? [{ kind: 'ordinary', pinned: true, contentClass: 'chrome', text: migrationNotice }] : [];
      const assemble = () => {
      const parts = [
        ...migrationNoticeParts,
        { kind: 'ordinary', contentClass: 'chrome', text: renderPayload(rel, [], { unowned, substantiveCount: freshOwners.length + freshHazards.length + freshDecisions.length }) },
        ...hazardParts(freshHazards, { fileKeys: [rel] }),
        ...tailParts,
      ];
      const assembled = assembleDelivery(parts, totalCap);
      return { text: assembled.text, emittedSubstance: assembled.emittedSubstance, emittedDiscovery: assembled.emittedDiscovery };
      };
      const built = assemble();
      injectPayload = built.text;
      emittedSubstance = built.emittedSubstance;
      emittedDiscovery = built.emittedDiscovery;
    }

    // SIDE EFFECT FIRST, GUARD SECOND. The guard is what
    // makes delivery once-per-session, so writing it before the delivery actually
    // happens converts any failure into permanent silent loss: nothing retries,
    // because the next touch sees the records already marked. Ordered this way, a
    // throw lands in the catch below with the guard untouched, so the next touch
    // delivers again. The combined freshness short-circuit above is what this guard
    // arms, so a guard written before a failed delivery silences the article for the whole session
    // with no residue and no detector.
    // ON THE INJECT PATH THAT ORDERING IS NOW MECHANICAL, not positional
    // (decision hook-stdout-exit-after-write-callback-bound-exit-deny-stays-
    // synchronous): the bookkeeping rides `onWritten`, so it runs only after the
    // stream has actually taken the payload — a write that fails leaves the guard
    // untouched by construction rather than by statement order, and the process
    // exits non-zero instead of reporting a clean delivery. ENQUEUE keeps the
    // positional form below: enqueuePending is a synchronous file write with no
    // stream callback to hang the bookkeeping on.
    // NOTE what this does and does not close: it
    // fully closes the case where the delivery THROWS (enqueue or stdout). It cannot
    // close the case where stdout succeeds and the PLATFORM ignores additionalContext
    // — nothing raises there, so no in-process ordering helps. That case is now PROBED
    // rather than hypothetical (research_finding 6adaa2ef, decision aa41e2ed): both
    // surfaces inject on this machine's WSL CLI at CC 2.1.220, interactive as well as
    // headless, so injection_rung is 'read' here. What that probe does NOT license is
    // the claim this comment used to make — that the failure is a 'per-platform
    // binary' settled once. Upstream it is per CC version x client surface x matcher x
    // tool class (live in the CLI, dead in the VSCode extension; dropped for the Bash
    // matcher; dropped for MCP calls), so a probe settles one CELL and an unprobed
    // client or launcher still loses silently. The successor is rung PROVENANCE — fall
    // back to 'prompt' when the running session is not the probed cell — not
    // residue-on-inject, which would double-deliver every healthy payload to hedge it.
    const recordDelivered = () => {
      // Inject path: guard only what the assembler says it actually emitted —
      // never a re-scan of the composed text (decision 92088a62's ONE
      // ASSEMBLER CONTRACT).
      markSubstanceDelivered(guard, emittedSubstance);
      markDiscoveryDelivered(guard, emittedDiscovery);
      if (frontierFresh) guard.frontier_files.push(rel);
      writeGuard(gPath, guard);
    };

    // migrationNotice is already folded into injectPayload above (as a
    // leading, charged chrome part — fix-round HIGH 4), so it is not
    // re-prepended here.
    return exitAfterWrite(
      JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: injectPayload } }),
      0,
      { onWritten: recordDelivered }
    );
  } catch (e) {
    // Delivery is an aid, never a gate: internal failure is loud but NON-blocking
    // (P5 visibility without an AC7 violation). Pending-aware: a failure raised
    // while an inject payload is already in flight is disclosed on stderr and
    // the delivered envelope's exit 0 carries — an exit-1 hook's stdout is not
    // read for additionalContext, so exiting 1 over a delivered payload would
    // throw the delivery away.
    return warnNonBlocking(`H19: knowledge delivery failed for '${rel}': ${(e && e.message) || e}`);
  }
}

main(input);
// no close: every path above exits the process (in the write callback on the
// inject path), which releases the handle (board f81b1987)
