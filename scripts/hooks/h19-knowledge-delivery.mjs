// H19 — knowledge delivery (decision 6dfbe675; concept family
// knowledge-delivery). The front half of the learning loop: put the owning
// article IN FRONT of the agent at file-touch, mechanically — never a gate
// (AC7: this hook must never exit 2). Since decision ca23c811 the payload also
// carries the path's HAZARDS (anti_pattern, as substance) and its RATIONALE
// (decision, as capped pointers) — articles alone answer neither "what must I
// not do here" nor "why is it this way". Registered at PostToolUse
// Read|Edit|Write|MultiEdit and PreToolUse Edit|Write|MultiEdit; which
// registration acts is decided by config.delivery.injection_rung — the rung is
// PROBE-SET (verify-at-build 0956a464, research_finding on the build's CC
// version), defaulting to the platform-proven 'prompt' path:
//   'prompt' (default): PostToolUse enqueues; h19-delivery-drain injects at the
//     next UserPromptSubmit (H2's proven additionalContext surface, one-turn lag).
//   'read':  PostToolUse injects additionalContext directly at the touch.
//   'edit':  only PreToolUse injection works on this platform — the PreToolUse
//     registration injects on Edit/Write; Read touches fall back to the queue.
// Pipeline: during an active run, agents with an agent_id got prep's
// knowledge_pack — H19 stays silent for them (AC6, no double-delivery); the
// conductor's own inline touches still deliver.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking, exitAfterWrite, openStore, loadConfig, repoRel, gitIgnored } from './lib/common.mjs';
import {
  guardPath,
  pendingPath,
  readGuard,
  writeGuard,
  enqueuePending,
  renderArticle,
  renderReference,
  renderHazards,
  completePorchHazards,
  cappedHazards,
  renderDecisionPointers,
  DECISION_POINTER_CAP,
  rankFileDecisionPointers,
  lineSuspectBlock,
  joinSuspectBlock,
  renderPayload,
  porchHeaderLine,
  renderPorch,
  resolvePorchBudget,
  rerenderRecipe,
  isDelivered,
  markDelivered,
  budgetKnownGaps,
  capDeliveryParts,
  partitionPorchHazards,
  resolveTotalCap,
  recordsShownIn,
  ownerPointer,
  ownerSuffix,
  decisionBlockPointer,
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
    // Unknown/typo'd rung falls back to the platform-proven default, never to a
    // silently different behavior (the MCP write path zod-validates, but config
    // can be hand-edited).
    const rawRung = loadConfig(input.cwd)?.delivery?.injection_rung;
    const rung = ['prompt', 'read', 'edit'].includes(rawRung) ? rawRung : 'prompt';
    const event = input.hook_event_name;

    // Route by event × rung: exactly one registration acts per touch.
    //  PreToolUse acts only on rung 'edit' (the PostToolUse surface is broken there).
    //  PostToolUse acts on 'read' (direct) and 'prompt' (enqueue); on rung 'edit'
    //  it still handles Read touches (no PreToolUse Read registration exists) by
    //  falling back to the queue.
    let mode; // 'inject' | 'enqueue' | null
    if (event === 'PreToolUse') {
      mode = rung === 'edit' ? 'inject' : null;
    } else {
      if (rung === 'read') mode = 'inject';
      else if (rung === 'prompt') mode = 'enqueue';
      else mode = input.tool_name === 'Read' ? 'enqueue' : null; // rung 'edit'
    }
    if (!mode) return allow();

    // The pending queue serves the CONDUCTOR's next prompt — a subagent never
    // sees a UserPromptSubmit, so enqueueing its touches would mis-route its
    // articles into the conductor's context (correctness review 2026-07-19).
    // Subagents receive delivery only on the inject rungs, in their own context.
    if (mode === 'enqueue' && input.agent_id) return allow();

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

    const gPath = guardPath(input.cwd, input.agent_id);
    const guard = readGuard(gPath);

    // Dedup by record id, not by file: a new file owned by an already-delivered
    // article re-arms nothing (the article is in context); a new owning record
    // always delivers (scope-growth re-arm). Hazards and decisions share the one
    // ledger — their ids are ids like any other.
    const freshOwners = owners.filter((r) => !isDelivered(guard, r));
    const freshHazards = hazards.filter((r) => !isDelivered(guard, r));
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
    const freshDecisions = rankFileDecisionPointers(decisions.filter((r) => !isDelivered(guard, r)));
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
    if (!freshOwners.length && !freshHazards.length && !freshDecisions.length && !frontierFresh) return allow();

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
    // scan AND the render recipe (fixer F3): the recipe must carry exactly what the
    // payload rendered, so re-deriving the slice in three places is how a record
    // the reader never saw gets promoted into the drained payload.
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

    // LINE-SUSPECT ADVISORY (board 04ccecb1-a338-4b4e-91f0-c99588c1cdce, warn-only
    // P1 advisory). `fresh` above already holds exactly the records this touch is
    // about to render (owners uncapped, hazards/decisions the rendered slice), so
    // the scan runs over that same set: for each record whose body text cites a
    // line position in `rel` (`<rel>:42` / `<rel>:10-20`) while the record's own
    // updated_at PREDATES rel's current mtime, the citation may have rotted under
    // it. Wrapped so ANY internal failure here (a bad stat — including the file
    // having moved/vanished since the touch — a malformed record, a regex
    // surprise) degrades to NO advisory rather than a broken delivery: this can
    // never be the reason a delivery fails (P5 / AC7 floor is the hook's own,
    // untouched by this addition).
    // Kept as the DECOMPOSED {header, lines:[{id,line}], footer} block, not a
    // pre-joined string, so the recipe can carry each line keyed by the record it
    // names and the drain can re-resolve them (fixer M1).
    let suspectBlock = null;
    try {
      const mtimeMs = statSync(join(input.cwd, rel)).mtimeMs;
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
    } catch {
      // stat failure or any scan error: skip the advisory silently (warn-only).
    }

    // Hazards LEAD: "do not do this here" outranks the description of what the
    // territory is, and the reader may stop after the first block. The
    // line-suspect block, if any, trails everything else — it is a footnote on
    // knowledge already delivered above, not knowledge in its own right.
    const blocks = [
      ...renderHazards(freshHazards, charCap, { fileKeys: [rel] }),
      ...freshOwners.map((r) =>
        r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, charCap, { gaps: gapsByOwner.get(r.id) })
      ),
      ...(freshDecisions.length ? [renderDecisionPointers(rel, freshDecisions)] : []),
      // joinSuspectBlock returns '' when no line survives; the filter keeps an
      // empty advisory shell out of the payload exactly as the drain does.
      joinSuspectBlock(suspectBlock ?? {}),
    ].filter((b) => typeof b === 'string' && b);
    const payload = renderPayload(rel, blocks, { unowned });

    // FRONT PORCH — DIRECT-INJECT PATH ONLY (decision 0050a536 §5 amendment,
    // 2026-09-08, evidence 5d2a527f; Codex thread 01a07f97). `payload` above is
    // built ONCE, ahead of the mode branch, and stays exactly what it always
    // was: it is what ENQUEUE stores in the pending queue (so the drain's later
    // output is byte-identical to before this change — the porch must never
    // leak into what gets queued), and it is also the INJECT fallback whenever
    // the porch itself has nothing to add (budget 0, MISCONFIGURED, or the
    // hazards-and-owners-both-empty case renderPorch itself declines). Building
    // a SEPARATE `injectPayload`, computed only for `mode === 'inject'`, is what
    // keeps those two shapes from ever being the same assembly step — porching
    // the shared builder unconditionally would have changed the enqueued
    // payload too, exactly the mistake this restructuring exists to avoid.
    //
    // Gated on `!unowned`: the porch's header claims 'owning knowledge for
    // <rel>' (porchHeaderLine), which is the wrong claim over unowned
    // territory (a hazard can attach to a path no article owns) — the frontier
    // notice's own header stays exactly as rendered by `payload` above in that
    // case, unmodified by this amendment.
    let injectPayload = payload;
    if (mode === 'inject') {
      // PER-DELIVERY TOTAL CAP (scale-down Slice 3c; see capDeliveryParts in
      // lib/delivery.mjs). Hazards are complete, unbudgeted substance; owners, decisions and
      // the line-suspect footnote share what remains of the cap, degrading to
      // `knowledge_get <id>` pointers. Only the direct-inject payload is capped
      // here; the enqueued payload above is rebuilt from its recipe at drain.
      const totalCap = resolveTotalCap(input.cwd);
      const ownerPart = (r) => {
        const text = r.type === 'reference_material' ? renderReference(r) : renderArticle(store, r, charCap, { gaps: gapsByOwner.get(r.id) });
        return { kind: 'ordinary', text, pointer: ownerPointer(text, r), suffix: ownerSuffix(r) };
      };
      const decisionWiden = `knowledge_query types:["decision"] file_keys:["${rel}"] cap:${freshDecisions.length}`;
      const ownerParts = freshOwners.map(ownerPart);
      const suspectParts = [{ kind: 'ordinary', text: joinSuspectBlock(suspectBlock ?? {}) }];
      const decisionParts = [
        ...(freshDecisions.length
          ? [
              {
                kind: 'ordinary', text: renderDecisionPointers(rel, freshDecisions),
                pointer: decisionBlockPointer(freshDecisions.length, decisionWiden),
                suffix: `  … the rest held back by the delivery cap — ${decisionWiden}`,
              },
            ]
          : []),
      ];
      const tailParts = [...ownerParts, ...decisionParts, ...suspectParts];
      const hazardParts = (list) => renderHazards(list, Number.MAX_SAFE_INTEGER, { fileKeys: [rel] }).map((text) => ({ kind: 'hazard', text }));

      // FRONT PORCH (decision 0050a536 §5 amendment): the bounded prefix
      // stays ahead of the capped remainder on owned territory; it is ordinary
      // content and spends the total cap like every non-hazard part.
      // Gated on `!unowned`: the porch header claims owning knowledge.
      const shownPathDecisions = freshDecisions.slice(0, DECISION_POINTER_CAP);
      const assemble = (pathM) => {
      let porch = { text: '', hazardsRendered: false };
      if (!unowned) {
        const referenceOwnersForInject = freshOwners.filter((r) => r.type === 'reference_material');
        const rawPorchBudget = resolvePorchBudget(input.cwd);
        const porchBudget = totalCap > 0 ? Math.min(rawPorchBudget, totalCap) : rawPorchBudget;
        porch =
          porchBudget > 0
            ? renderPorch(porchHeaderLine([rel]), freshHazards, freshOwners, porchBudget, {
                articleBodiesCount: freshOwners.length - referenceOwnersForInject.length,
                referencePointerCount: referenceOwnersForInject.length,
                pathDecisionPointerCount: pathM,
                hasSubjectChannel: false,
                fileKeys: [rel],
              })
            : porch;
      }
      // With a porch the owners' digests are already delivered, so decision
      // pointers take the remaining budget ahead of full article bodies.
      const shownHazards = cappedHazards(freshHazards);
      const deferredHazardIds = new Set(porch.deferred_hazard_ids ?? []);
      const porchHazards = completePorchHazards(shownHazards.filter((hazard) => !deferredHazardIds.has(hazard.id)));
      const deferredHazards = hazardParts(shownHazards.filter((hazard) => deferredHazardIds.has(hazard.id)));
      const porchParts = porch.text ? partitionPorchHazards(porch.text, porchHazards) : null;
      if (porch.text && !porchParts) {
        porch = renderPorch(porchHeaderLine([rel]), [], freshOwners, porchBudget, {
          articleBodiesCount: freshOwners.length - freshOwners.filter((r) => r.type === 'reference_material').length,
          referencePointerCount: freshOwners.filter((r) => r.type === 'reference_material').length,
          pathDecisionPointerCount: pathM, hasSubjectChannel: false, fileKeys: [rel],
        });
      }
      const parts = porch.text
        ? [...(porchParts ?? [{ kind: 'ordinary', text: porch.text }]), ...deferredHazards, ...decisionParts, ...ownerParts, ...suspectParts]
        : [
            { kind: 'ordinary', text: renderPayload(rel, [], { unowned, substantiveCount: freshOwners.length + freshHazards.length + freshDecisions.length }) },
            ...hazardParts(freshHazards),
            ...tailParts,
          ];
      return { text: capDeliveryParts(parts, totalCap).join('\n\n'), porchText: porch.text };
      };
      // PORCH SELF-REPORT = POST-CAP ACTUAL: the porch-end line states how many
      // decision pointers follow, and the cap decides that only after the porch
      // is sized — re-render until the report matches what was emitted.
      let pathM = shownPathDecisions.length;
      let built = assemble(pathM);
      for (let i = 0; i < 3; i++) {
        const below = built.text.slice(built.porchText.length);
        const actual = shownPathDecisions.filter((r) => below.includes(r.id)).length;
        if (actual === pathM) break;
        pathM = actual;
        built = assemble(pathM);
      }
      injectPayload = built.text;
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
      // Inject path: guard only what the capped payload actually names by id.
      markDelivered(guard, mode === 'inject' ? recordsShownIn(injectPayload, fresh) : fresh);
      if (frontierFresh) guard.frontier_files.push(rel);
      writeGuard(gPath, guard);
    };

    if (mode === 'enqueue') {
      // RENDER RECIPE beside the payload (decision db3392db part 2): the queue
      // injects one turn later, so the drain re-reads these ids and rebuilds the
      // payload from CURRENT records — the pre-rendered `payload` above survives
      // only as the fallback for a drain that cannot reach the store.
      //
      // THE ID LISTS ARE THE SHOWN (POST-CAP) SLICES, with what the caps SUPPRESSED
      // carried alongside as counts (fixer F3). The earlier shape stored the
      // UNCAPPED fresh sets and let the drain re-apply the caps, which silently
      // PROMOTES: a hazard capped out of this payload, whose more-severe sibling is
      // superseded by drain time, would surface in the drained text as though it
      // had been delivered here — and the guard never marked it delivered, so the
      // reader gets it twice, once as a record they were never shown. The counts
      // are what let the drain replay the original '… N more NOT shown' tail
      // without holding the ids it must not render.
      if (!enqueuePending(pendingPath(input.cwd), {
        kind: unowned ? 'frontier' : 'delivery',
        rel,
        payload,
        recipe: rerenderRecipe({
          rel,
          unowned,
          charCap,
          hazardIds: shownHazards.map((r) => r.id),
          ownerIds: freshOwners.map((r) => r.id),
          decisionIds: shownDecisions.map((r) => r.id),
          hazardTail: freshHazards.length - shownHazards.length,
          cachedHazardBlocks: renderHazards(shownHazards, charCap, { fileKeys: [rel] }),
          decisionTail: freshDecisions.length - shownDecisions.length,
          // THE LINE-SUSPECT ADVISORY IS RECORD-DERIVED, not file-only (fixer M1).
          // It reads as a note about the FILE's line positions, but every one of its
          // lines is labelled with the CITING RECORD's own title/slug/id, so
          // replaying it verbatim at drain would serve cached per-record text for a
          // record that may have been superseded or deleted meanwhile — the same leak
          // the pointer channel was rebuilt to close. It therefore rides `suspects`
          // as {id, line} entries and is re-resolved there; `trailing_blocks` is
          // reserved for text with no record id in it at all.
          suspects: suspectBlock,
        }),
        agent_id: input.agent_id ?? 'conductor',
      })) throw new Error('delivery queue lock timeout');
      // ENQUEUE'S BOOKKEEPING STAYS POSITIONAL — immediately after a successful
      // enqueuePending, exactly as before: there is no stream callback on this
      // path, and a throw above leaves the guard untouched for the next touch.
      recordDelivered();
      return allow();
    }

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
