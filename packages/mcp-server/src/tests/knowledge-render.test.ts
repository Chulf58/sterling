// knowledge_render — a paste-ready, one-string rendering of one or more
// knowledge records, addressed by the standard id ladder (full uuid / exact
// slug / unambiguous 8-char prefix on READ, which this call is).
//
// SPEC-ONLY. Written while the implementation is being authored in parallel
// — packages/mcp-server/src/tools.ts was deliberately NOT read to produce
// this file, per the dispatch brief. Every pin below is derived from the
// CONTRACT in the brief, not from any implementation detail. `knowledgeRender`
// does not exist on SterlingTools's declared type yet, so every call below
// goes through a cast-through-unknown seam (same convention as
// knowledge-array-remove.test.ts's `remover()`) — a missing implementation
// fails at the call site (TypeError: ... is not a function / AssertionError),
// never at a package build error. Expect the whole suite RED right now.
//
// CONTRACT PINNED HERE:
//   1. {ids: string[]}, 1-20: empty refused naming the bound; 21 refused
//      naming the bound; exactly 20 (the inclusive upper bound) succeeds.
//   2. Ids resolve via the standard ladder: full uuid, exact slug,
//      unambiguous 8-char prefix.
//   3. An unknown id refuses the WHOLE call, naming the failing id — no
//      partial output.
//   4. Output is one paste-ready STRING: each record gets a header line
//      (type, title, status) followed by labeled content-bearing fields.
//      Decision: statement, rationale, >=1 alternatives_rejected
//      option+reason. Feature article: what_it_does, intended_behavior.
//      Server plumbing (file_baselines) never appears.
//   5. Multi-id order: records render in REQUEST order, not creation or
//      alphabetical order.
//   6. Read-only: rendering never mints a version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-09-01T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-render-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

type Loose = Record<string, unknown>;

// the cast-through-unknown seam: `knowledgeRender` is not on SterlingTools's
// declared type until this slice ships — cast rather than reference, so a
// missing implementation fails on a TypeError/AssertionError at the call
// site, never on a package build error.
type Renderer = { knowledgeRender(args: { ids: string[] }): string };
function renderer(tools: SterlingTools): Renderer {
  return tools as unknown as Renderer;
}

function mkArticle(
  tools: SterlingTools,
  slug: string,
  title: string,
  whatItDoes: string,
  intendedBehavior: string
): Loose {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title,
    what_it_does: whatItDoes,
    intended_behavior: intendedBehavior,
    files: [{ path: 'src/render-fixture.ts', role: 'test fixture only' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record as unknown as Loose;
}

function mkDecision(
  tools: SterlingTools,
  slug: string,
  title: string,
  statement: string,
  rationale: string,
  alternatives: { option: string; reason: string }[]
): Loose {
  return tools.knowledgeCreate('decision', {
    slug,
    title,
    statement,
    rationale,
    alternatives_rejected: alternatives,
  }).record as unknown as Loose;
}

function getRecord(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

// ---------------------------------------------------------------------------
// T-CONTROL — PLACED FIRST. Without this, every refusal pin below (empty,
// too-many, unknown-id) is equally satisfied by an implementation that simply
// throws on every call, refusal or not. This arm must pass for the OPPOSITE
// reason: a completely ordinary render succeeds. It also doubles as the
// lower-bound-precision proof (exactly 1 id, the floor of the 1-20 range) and
// the "full uuid resolves" half of the id-ladder contract (point 2).
// Sabotage: make knowledgeRender throw unconditionally on every call — this
// test goes red while, without it, the refusal tests below would stay green
// for the wrong reason.
// ---------------------------------------------------------------------------
test('T-CONTROL (first): a normal call with exactly 1 valid full-uuid id succeeds, returns a non-empty string containing that record\'s title — proves the refusal pins below guard real bounds, not "throws on everything", and that a full uuid resolves', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(
      tools,
      'control-single-render',
      'Control Single Render Distinctive Title 4f0a',
      'does things',
      'intends things'
    );
    let out: string | undefined;
    assert.doesNotThrow(() => {
      out = renderer(tools).knowledgeRender({ ids: [article.id as string] });
    }, 'a single valid full-uuid id must render without throwing');
    assert.equal(typeof out, 'string', 'the return value is a string');
    assert.ok((out as string).length > 0, 'the string is non-empty');
    assert.ok(
      (out as string).includes('Control Single Render Distinctive Title 4f0a'),
      'the rendered string contains the requested record\'s title'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC1a — empty array refused, naming the bound.
// Sabotage: delete the `ids.length < 1` guard — calling with [] no longer
// throws (e.g. returns "" or undefined instead).
// ---------------------------------------------------------------------------
test('AC1a: an EMPTY ids array is REFUSED, naming the 1-20 bound', () => {
  const { tools, cleanup } = harness();
  try {
    assert.throws(
      () => renderer(tools).knowledgeRender({ ids: [] }),
      (err: Error) => {
        assert.match(err.message, /empty|at least 1|minimum 1|non-empty/i, `refusal must name emptiness/the lower bound — got: "${err.message}"`);
        assert.match(err.message, /\b20\b/, `refusal must name the bound (20) — got: "${err.message}"`);
        return true;
      },
      'an empty ids array must be refused, not silently render nothing'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC1b — 21 ids refused, naming the bound. Uses 21 REAL, individually
// resolvable ids so the ONLY possible cause of the refusal is the count
// bound — not an unresolvable id (that is a separate, distinct pin below).
// Sabotage: change the upper-bound check from `> 20` to `> 21` (or delete
// it) — 21 real ids now succeed instead of refusing.
// ---------------------------------------------------------------------------
test('AC1b: 21 ids (all individually valid/resolvable) is REFUSED, naming the 20 bound — the cause can only be the COUNT, since every id resolves', () => {
  const { tools, cleanup } = harness();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 21; i++) {
      const rec = mkArticle(tools, `bound-max-${i}`, `Bound Max Title ${i}`, 'does things', 'intends things');
      ids.push(rec.id as string);
    }
    assert.throws(
      () => renderer(tools).knowledgeRender({ ids }),
      (err: Error) => {
        assert.match(err.message, /at most|maximum|no more than|too many|exceeds|up to/i, `refusal must name the upper-bound violation — got: "${err.message}"`);
        assert.match(err.message, /\b20\b/, `refusal must name the bound (20) — got: "${err.message}"`);
        return true;
      },
      '21 resolvable ids must still be refused on count alone'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC1c — exactly 20 ids (the inclusive upper bound) succeeds. Without this,
// a sabotage that shifts the bound down (e.g. `> 20` -> `> 19`) would still
// pass AC1b (21 > 19 too) while silently breaking the documented "1-20"
// range. This is the boundary-precision half of AC1b.
// Sabotage: change the upper-bound check from `> 20` to `>= 20` (or `> 19`)
// — exactly-20 now refuses instead of succeeding.
// ---------------------------------------------------------------------------
test('AC1c: exactly 20 ids (the inclusive upper bound) SUCCEEDS — proves the bound is 20 inclusive, not an off-by-one', () => {
  const { tools, cleanup } = harness();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const rec = mkArticle(tools, `bound-ok-${i}`, `Bound Ok Title ${i}`, 'does things', 'intends things');
      ids.push(rec.id as string);
    }
    assert.doesNotThrow(() => {
      renderer(tools).knowledgeRender({ ids });
    }, 'exactly 20 ids, the documented inclusive upper bound, must succeed');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2a — exact slug resolves (the second rung of the ladder; full uuid is
// covered by T-CONTROL above).
// Sabotage: remove the slug-equality branch from the id-resolution ladder
// used by knowledgeRender — the slug lookup now throws "unknown id".
// ---------------------------------------------------------------------------
test('AC2a: an exact SLUG resolves (id ladder, rung 2)', () => {
  const { tools, cleanup } = harness();
  try {
    mkArticle(tools, 'render-by-slug-target', 'Render By Slug Distinctive Title 9b1e', 'does things', 'intends things');
    let out: string | undefined;
    assert.doesNotThrow(() => {
      out = renderer(tools).knowledgeRender({ ids: ['render-by-slug-target'] });
    }, 'an exact slug must resolve without throwing');
    assert.ok(
      (out as string).includes('Render By Slug Distinctive Title 9b1e'),
      'the rendered string contains the slug-resolved record\'s title'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2b — unambiguous 8-char prefix resolves (rung 3). Precondition mirrors
// knowledge-array-remove.test.ts's AC9: prove the prefix is unambiguous by
// resolving it on the read surface first, so the pin is about the ladder,
// not a lucky/colliding prefix.
// Sabotage: remove the 8-char-prefix branch from the ladder — the prefix
// lookup now throws "unknown id".
// ---------------------------------------------------------------------------
test('AC2b: an unambiguous 8-char PREFIX resolves (id ladder, rung 3)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'render-by-prefix-target', 'Render By Prefix Distinctive Title c3d7', 'does things', 'intends things');
    const prefix = (article.id as string).slice(0, 8);

    assert.doesNotThrow(() => tools.knowledgeGet(prefix), 'precondition: the prefix resolves unambiguously on the read surface');

    let out: string | undefined;
    assert.doesNotThrow(() => {
      out = renderer(tools).knowledgeRender({ ids: [prefix] });
    }, 'an unambiguous 8-char prefix must resolve without throwing');
    assert.ok(
      (out as string).includes('Render By Prefix Distinctive Title c3d7'),
      'the rendered string contains the prefix-resolved record\'s title'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3 — an unknown id refuses the WHOLE call, naming the failing id, with no
// partial output. Two real records: the call must not silently render the
// good one and drop the bogus one.
// Sabotage: change the resolution loop to silently skip/filter unresolvable
// ids instead of throwing — the call no longer throws and would return a
// string containing only the good record.
// ---------------------------------------------------------------------------
test('AC3: an UNKNOWN id refuses the WHOLE call, naming the failing id — no partial output for the good record(s)', () => {
  const { tools, cleanup } = harness();
  try {
    const good = mkArticle(
      tools,
      'unknown-id-good-sibling',
      'Unknown Id Good Sibling Distinctive Title e81f',
      'does things',
      'intends things'
    );
    const bogus = 'this-id-does-not-exist-anywhere-in-the-store-9f8e7d6c';

    assert.throws(
      () => renderer(tools).knowledgeRender({ ids: [good.id as string, bogus] }),
      (err: Error) => {
        assert.ok(err.message.includes(bogus), `the refusal must name the failing id — got: "${err.message}"`);
        assert.ok(
          !err.message.includes('Unknown Id Good Sibling Distinctive Title e81f'),
          'the error is a refusal, not a rendered block — the good record\'s title must not have leaked into it as partial output'
        );
        assert.ok(
          err.message.length < 500,
          'a refusal message stays short; a 500+ char message would suggest a partial render got stapled into the thrown error'
        );
        return true;
      },
      'an unknown id must refuse the whole call, even alongside otherwise-good ids'
    );
    // throwing at all already proves no value was returned to the caller —
    // "no partial output" cannot be violated by a call that never returns.
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4a — header line for a decision: type, title, status all present on the
// same line as the record's (distinctive) title.
// Sabotage: drop the header line from the decision renderer, emitting only
// the content fields — no line carries the title alongside type/status.
// ---------------------------------------------------------------------------
test('AC4a: decision output has a header line containing the record\'s type, title and status together', () => {
  const { tools, cleanup } = harness();
  try {
    const title = 'Header Decision Distinctive Title 8f2c';
    mkDecision(
      tools,
      'header-decision-target',
      title,
      'STATEMENT placeholder — content pinned separately in AC4c',
      'RATIONALE placeholder — content pinned separately in AC4c',
      [{ option: 'OPTION placeholder', reason: 'REASON placeholder' }]
    );
    const article = mkArticle(tools, 'header-decision-target-noop', 'noop', 'x', 'y'); // ensures single-id call below still exercises the real ladder
    void article;

    const out = renderer(tools).knowledgeRender({ ids: ['header-decision-target'] });
    const lines = out.split('\n');
    const headerLine = lines.find((l) => l.includes(title));
    assert.ok(headerLine, `no line in the output contains the title "${title}" — full output:\n${out}`);
    assert.match(headerLine as string, /\bdecision\b/i, `the header line must name the record's type — got: "${headerLine}"`);
    assert.match(headerLine as string, /\bactive\b/i, `the header line must name the record's status — got: "${headerLine}"`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4b — header line for a feature_article: type, title, status together.
// Sabotage: drop the header line from the feature_article renderer.
// ---------------------------------------------------------------------------
test('AC4b: feature_article output has a header line containing the record\'s type, title and status together', () => {
  const { tools, cleanup } = harness();
  try {
    const title = 'Header Article Distinctive Title 71ac';
    mkArticle(
      tools,
      'header-article-target',
      title,
      'WHAT_IT_DOES placeholder — content pinned separately in AC4d',
      'INTENDED_BEHAVIOR placeholder — content pinned separately in AC4d'
    );

    const out = renderer(tools).knowledgeRender({ ids: ['header-article-target'] });
    const lines = out.split('\n');
    const headerLine = lines.find((l) => l.includes(title));
    assert.ok(headerLine, `no line in the output contains the title "${title}" — full output:\n${out}`);
    assert.match(headerLine as string, /feature_article|feature\s*article/i, `the header line must name the record's type — got: "${headerLine}"`);
    assert.match(headerLine as string, /\bactive\b/i, `the header line must name the record's status — got: "${headerLine}"`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4c — decision content: statement, rationale, and at least one
// alternatives_rejected option+reason all appear in the output.
// Sabotage: omit the alternatives_rejected block from the decision renderer
// (render only statement + rationale) — the option/reason assertions fail.
// ---------------------------------------------------------------------------
test('AC4c: decision output contains the statement text, the rationale text, and at least one alternatives_rejected option+reason', () => {
  const { tools, cleanup } = harness();
  try {
    const statement = 'STATEMENT-MARKER-9c41: paths are normalized POSIX before storage';
    const rationale = 'RATIONALE-MARKER-9c41: mixed separators silently corrupt cross-platform lookups';
    const option = 'OPTION-MARKER-9c41: accept raw platform paths unmodified';
    const reason = 'REASON-MARKER-9c41: raw paths broke Windows/WSL parity in testing';
    const decision = mkDecision(tools, 'content-decision-target', 'Content Decision Target', statement, rationale, [
      { option, reason },
    ]);

    const out = renderer(tools).knowledgeRender({ ids: [decision.id as string] });
    assert.ok(out.includes(statement), `output missing the statement text — full output:\n${out}`);
    assert.ok(out.includes(rationale), `output missing the rationale text — full output:\n${out}`);
    assert.ok(out.includes(option), `output missing the alternatives_rejected option text — full output:\n${out}`);
    assert.ok(out.includes(reason), `output missing the alternatives_rejected reason text — full output:\n${out}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4d — feature_article content: what_it_does and intended_behavior both
// appear in the output.
// Sabotage: omit intended_behavior from the feature_article renderer
// (render only what_it_does) — the intended_behavior assertion fails.
// ---------------------------------------------------------------------------
test('AC4d: feature_article output contains the what_it_does text and the intended_behavior text', () => {
  const { tools, cleanup } = harness();
  try {
    const whatItDoes = 'WHAT-IT-DOES-MARKER-2b7f: renders knowledge records to paste-ready text';
    const intendedBehavior = 'INTENDED-BEHAVIOR-MARKER-2b7f: preserves request order and rejects unknown ids wholesale';
    const article = mkArticle(tools, 'content-article-target', 'Content Article Target', whatItDoes, intendedBehavior);

    const out = renderer(tools).knowledgeRender({ ids: [article.id as string] });
    assert.ok(out.includes(whatItDoes), `output missing what_it_does — full output:\n${out}`);
    assert.ok(out.includes(intendedBehavior), `output missing intended_behavior — full output:\n${out}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4e — server plumbing (file_baselines) must never appear in the output,
// even though feature_article carries it. This is what rules out a naive
// "JSON.stringify the whole stored record" implementation — such an
// implementation would also incidentally pass AC4d, but this pin catches it.
// Sabotage: render by JSON.stringifying the whole stored record instead of a
// curated field list — the literal string "file_baselines" now appears.
// ---------------------------------------------------------------------------
test('AC4e: server plumbing (file_baselines) does NOT appear anywhere in the output', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'no-plumbing-target', 'No Plumbing Target', 'does things', 'intends things');
    const out = renderer(tools).knowledgeRender({ ids: [article.id as string] });
    assert.ok(!out.includes('file_baselines'), `output must not leak server plumbing — full output:\n${out}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC5 — multi-id order: records render in the order REQUESTED, not creation
// order and not alphabetical order. X is created first with a title that
// sorts BEFORE Y's alphabetically, so both "creation order" and "alphabetical
// order" agree with each other and both predict X-before-Y. Requesting
// [Y, X] can therefore only produce Y-before-Z... err Y-before-X if the
// implementation actually honors the requested array order — neither naive
// alternative (creation order, alphabetical order) can produce that result.
// Sabotage: sort/render records by id or by internal query/creation order
// instead of the requested ids[] array order — Y no longer precedes X.
// ---------------------------------------------------------------------------
test('AC5: multi-id render honors REQUEST order, not creation order or alphabetical order', () => {
  const { tools, cleanup } = harness();
  try {
    const x = mkArticle(tools, 'order-aaa-first-created', 'Aaa First Created Distinctive Title', 'does things', 'intends things');
    const y = mkArticle(tools, 'order-bbb-second-created', 'Bbb Second Created Distinctive Title', 'does things', 'intends things');
    // precondition: creation order AND alphabetical order both agree X, Y —
    // so a Y-before-X result in the output below cannot be explained by
    // either naive alternative.
    assert.ok((x.title as string) < (y.title as string), 'precondition: X sorts alphabetically before Y');

    const out = renderer(tools).knowledgeRender({ ids: [y.id as string, x.id as string] });
    const yPos = out.indexOf(y.title as string);
    const xPos = out.indexOf(x.title as string);
    assert.ok(yPos >= 0, `output missing Y's title — full output:\n${out}`);
    assert.ok(xPos >= 0, `output missing X's title — full output:\n${out}`);
    assert.ok(
      yPos < xPos,
      `Y was requested first ([Y, X]) so Y's title must appear before X's; creation order and alphabetical order both predict the opposite, so this can only pass if request order is honored — full output:\n${out}`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC6 — read-only: rendering never mints a version, on either record type.
// Sabotage: have the renderer call knowledgeUpdate (or otherwise persist a
// touch) as a side effect of reading — the reread version increments.
// ---------------------------------------------------------------------------
test('AC6: rendering is READ-ONLY — a record\'s version is unchanged after being rendered, re-read via knowledgeGet', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'readonly-article-target', 'Readonly Article Target', 'does things', 'intends things');
    const decision = mkDecision(tools, 'readonly-decision-target', 'Readonly Decision Target', 'statement', 'rationale', [
      { option: 'opt', reason: 'reason' },
    ]);
    const articleVersionBefore = (getRecord(tools, article.id as string).version as number);
    const decisionVersionBefore = (getRecord(tools, decision.id as string).version as number);

    renderer(tools).knowledgeRender({ ids: [article.id as string, decision.id as string] });

    const articleVersionAfter = (getRecord(tools, article.id as string).version as number);
    const decisionVersionAfter = (getRecord(tools, decision.id as string).version as number);
    assert.equal(articleVersionAfter, articleVersionBefore, 'rendering a feature_article must not mint a version');
    assert.equal(decisionVersionAfter, decisionVersionBefore, 'rendering a decision must not mint a version');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// DELTA PINS — four review fixes now being implemented in parallel (Codex
// thread 01a05ba4). APPENDED, spec-only as before — tools.ts still not read;
// the "=== " header-prefix convention used below was given directly by the
// coordinator's dispatch message, not discovered by reading the
// implementation. Expect DP1-DP3 RED until the parallel fix lands. DP4
// (unknown type refused) is SKIPPED — see the note above it.
//
// EXISTING-FIXTURE CHECK (requested, not a new test): every title used by
// the AC4a/AC4b/AC2a/AC2b/T-CONTROL/AC3/AC5 fixtures above is well under a
// 120-char clip threshold (the longest, T-CONTROL's, is 46 chars) — none of
// the existing pins are at risk of header-clipping under a one-line-header
// framing fix, so no existing pin needed weakening.
// ===========================================================================

// ---------------------------------------------------------------------------
// DP1 — TOTAL-OUTPUT CEILING: a call whose rendered output would exceed the
// module's total ceiling is refused loudly, naming the measured size and the
// ceiling — never silently truncated.
// Sabotage: remove the ceiling check — the call succeeds instead of
// refusing.
// ---------------------------------------------------------------------------
test('DP1: a render whose output would exceed the total-output ceiling is REFUSED, naming the measured size and the ceiling — never silently truncated', () => {
  const { tools, cleanup } = harness();
  try {
    // Multi-word filler, not one 150k token: a single giant token crashes a
    // PRE-EXISTING create-path defect (axisCandidateMatches passes unfiltered
    // terms to axisHits' dynamic RegExp — boarded separately) before
    // knowledgeRender ever runs, which would make this pin red for the wrong
    // reason. Realistic word-shaped bulk exercises only the ceiling under test.
    const hugeRationale = 'word filler segment '.repeat(7_500); // 150k chars
    const decision = mkDecision(
      tools,
      'ceiling-huge-rationale',
      'Ceiling Huge Rationale Target',
      'short statement',
      hugeRationale,
      [{ option: 'short option', reason: 'short reason' }]
    );

    assert.throws(
      () => renderer(tools).knowledgeRender({ ids: [decision.id as string] }),
      (err: Error) => {
        assert.match(
          err.message,
          /exceed|too large|too big|over the [^\n]{0,40}(limit|ceiling)|output ceiling|maximum output/i,
          `refusal must name the ceiling being exceeded — got: "${err.message.slice(0, 300)}"`
        );
        assert.match(
          err.message,
          /\d{3,}/,
          `refusal must name a measured size (a number) — got: "${err.message.slice(0, 300)}"`
        );
        // "never silently truncated": the message itself must not BE the
        // truncated render (a >150k-char rationale dumped into the error
        // would make the error message itself enormous) — a short refusal
        // proves nothing partial was assembled and returned as the error.
        assert.ok(
          err.message.length < 2000,
          `the refusal message itself must not be (or contain) the oversized render — got length ${err.message.length}`
        );
        return true;
      },
      'a render whose output exceeds the ceiling must refuse, not silently truncate or succeed'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// DP2 — ONE-LINE HEADER FRAMING: a record whose title contains an embedded
// newline and a line starting with '=== ' (an attempted header forgery) must
// not be able to inject a fake column-0 '=== ' line into the output.
// (a) exactly one line in the output both starts with '=== ' and carries
//     this record's identifying title fragment.
// (b) the TOTAL count of column-0 '=== ' lines across the whole output
//     equals the number of records requested — the forged line inside the
//     title must not add a third one.
// Sabotage: stop indenting body lines — the embedded '=== FAKE...' line in
// the raw title lands flush at column 0 as its own line, a real forged
// header.
// ---------------------------------------------------------------------------
test('DP2: an embedded newline + \'=== \' line inside a title cannot forge a second column-0 header line', () => {
  const { tools, cleanup } = harness();
  try {
    const forgedTitle = 'Header Forgery Attempt\n=== FAKE INJECTED HEADER LOOKS REAL\nTrailing residue after fake header';
    const forged = mkArticle(tools, 'header-forgery-target', forgedTitle, 'does things', 'intends things');
    const sibling = mkArticle(tools, 'header-forgery-sibling', 'Forgery Sibling Distinctive Title', 'does things', 'intends things');

    const out = renderer(tools).knowledgeRender({ ids: [forged.id as string, sibling.id as string] });
    const lines = out.split('\n');
    const columnZeroHeaderLines = lines.filter((l) => l.startsWith('=== '));

    const forgedRealHeaderLines = columnZeroHeaderLines.filter((l) => l.includes('Header Forgery Attempt'));
    assert.equal(
      forgedRealHeaderLines.length,
      1,
      `exactly one column-0 '=== ' line must carry the forged record's title fragment — full output:\n${out}`
    );

    assert.equal(
      columnZeroHeaderLines.length,
      2,
      `exactly 2 column-0 '=== ' lines expected (one per requested record) — the embedded '=== FAKE...' line must not add a third — got ${columnZeroHeaderLines.length}:\n${JSON.stringify(columnZeroHeaderLines)}\nfull output:\n${out}`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// DP3 — MULTI-LINE CONTENT INDENTED: a field value containing embedded
// newlines renders with every CONTINUATION line indented (no content line at
// column 0). The field's own first line may share a line with its label (and
// so may legitimately start at column 0); only lines 2+ of the value are
// pinned here. Asserted directly on the block between this record's header
// and the next record's header.
// Sabotage: stop indenting continuation lines of multi-line field values —
// the L2/L3 marker lines land flush at column 0.
// ---------------------------------------------------------------------------
test('DP3: a multi-line field value renders with every continuation line indented — none flush at column 0', () => {
  const { tools, cleanup } = harness();
  try {
    const multilineWhatItDoes = 'MULTILINE-L1-marker-7d2e\nMULTILINE-L2-marker-7d2e\nMULTILINE-L3-marker-7d2e';
    const recA = mkArticle(tools, 'multiline-content-target', 'Multiline Content Target', multilineWhatItDoes, 'intends things');
    const recB = mkArticle(tools, 'multiline-content-bound', 'Multiline Content Bound', 'does things', 'intends things');

    const out = renderer(tools).knowledgeRender({ ids: [recA.id as string, recB.id as string] });
    const lines = out.split('\n');

    const headerAIndex = lines.findIndex((l) => l.startsWith('=== ') && l.includes('Multiline Content Target'));
    const headerBIndex = lines.findIndex((l) => l.startsWith('=== ') && l.includes('Multiline Content Bound'));
    assert.ok(headerAIndex >= 0, `recA's header line not found — full output:\n${out}`);
    assert.ok(headerBIndex >= 0, `recB's header line not found — full output:\n${out}`);
    assert.ok(headerAIndex < headerBIndex, 'recA is requested (and must render) before recB');

    const l2Index = lines.findIndex((l) => l.includes('MULTILINE-L2-marker-7d2e'));
    const l3Index = lines.findIndex((l) => l.includes('MULTILINE-L3-marker-7d2e'));
    assert.ok(l2Index >= 0, `L2 marker line not found — full output:\n${out}`);
    assert.ok(l3Index >= 0, `L3 marker line not found — full output:\n${out}`);
    assert.ok(
      l2Index > headerAIndex && l2Index < headerBIndex,
      "L2 marker must fall within recA's own block, between the two headers"
    );
    assert.ok(
      l3Index > headerAIndex && l3Index < headerBIndex,
      "L3 marker must fall within recA's own block, between the two headers"
    );

    assert.ok(
      /^\s/.test(lines[l2Index]),
      `the L2 continuation line must be indented, not flush at column 0 — got: "${lines[l2Index]}"`
    );
    assert.ok(
      /^\s/.test(lines[l3Index]),
      `the L3 continuation line must be indented, not flush at column 0 — got: "${lines[l3Index]}"`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// DP4 — UNKNOWN TYPE REFUSED: SKIPPED. The public create surface
// (SterlingTools.knowledgeCreate, the only record-creation path this harness
// is permitted to use) validates `type` against the registered record-type
// set before a row is ever persisted (CLAUDE.md invariant 3, "registries
// first" — every extensible set, including record types, has its
// registry-backed consistency check before the first member is added). There
// is therefore no way to get an unknown-type record INTO the store through
// the public surface for knowledgeRender to be handed in the first place;
// reaching into the DB by hand to fabricate one was explicitly ruled out by
// the dispatch. Per the dispatch's own instruction, this pin is skipped
// rather than faked with a hand-crafted row or an unverified assumption
// about knowledgeCreate's rejection wording (which would itself require
// reading tools.ts to state precisely).
// ---------------------------------------------------------------------------
