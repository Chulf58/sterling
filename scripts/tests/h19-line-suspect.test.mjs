// H19 LINE-SUSPECT advisory (board 04ccecb1-a338-4b4e-91f0-c99588c1cdce).
// SPEC-ONLY, RED-GATE: none of this behavior exists yet in
// scripts/hooks/h19-knowledge-delivery.mjs. Every test below is written
// against the spec handed to the test-writer, not against the implementation
// (which does not exist), and is expected to FAIL on HEAD — see the per-test
// comment for the exact assertion that fires first.
//
// SPEC (recap): for a touched governed file `rel`, each DELIVERED record
// (owning feature_article, hazard anti_pattern, decision pointer) whose body
// text cites a line position in `rel` — a token `<rel>:<digits>` or
// `<rel>:<digits>-<digits>` — AND whose `updated_at` is OLDER than `rel`'s
// current mtime produces a line-suspect advisory in the payload: it names
// the citing record, quotes at least one stale cited token, and carries
// guidance to cite anchors (function/slug/passage) over line numbers.
// Warn-only: the advisory only ever ADDS text; exit code and every other
// delivery behavior are unchanged (AC7 floor still holds).
//
// Harness: copied verbatim from scripts/tests/h19-hazard-cap.test.mjs /
// h19-delivery.test.mjs conventions — temp project + store, runHook against
// the real hook binary, rung 'read' so the payload lands directly in
// hookSpecificOutput.additionalContext (no queue-file indirection needed).
// The only NEW fixture primitive is `touchFile`, which writes a real file and
// pins its mtime with utimesSync so the stale/fresh relationship to a
// record's `updated_at` is deterministic — no timing races, no sleeps.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-07-19T12:00:00.000Z';

// The file's mtime is pinned to this instant for every scenario below. A
// record's `updated_at` is then placed either before it (STALE — the
// condition the advisory fires on) or after it (FRESH — no advisory).
const FILE_MTIME = '2026-08-01T00:00:00.000Z';
const STALE_UPDATED_AT = '2026-07-01T00:00:00.000Z'; // older than FILE_MTIME
const FRESH_UPDATED_AT = '2026-08-15T00:00:00.000Z'; // newer than FILE_MTIME

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type, updatedAt = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: updatedAt,
    updated_at: updatedAt,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function article(slug, paths, extra = {}) {
  return {
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [],
    live_test_refs: [],
    ...extra,
  };
}

function antiPattern(title, paths, extra = {}) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger: `${title} trigger text`,
    guidance: `${title} guidance`,
    wrong_way: `${title} wrong way`,
    right_way: `${title} right way text`,
    source_evidence: `${title} evidence`,
    basis: 'codebase',
    file_keys: paths,
    ...extra,
  };
}

function decisionRecord(statement, paths, extra = {}) {
  return {
    ...envelope('decision'),
    title: statement,
    statement,
    alternatives_rejected: [],
    rationale: `${statement} rationale`,
    file_keys: paths,
    ...extra,
  };
}

function makeProject({ rung = 'read' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-linesuspect-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: rung } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const postRead = (dir, file, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  cwd: dir,
  ...extra,
});

function ctxOf(result) {
  assert.equal(result.code, 0, `hook must not block (AC7): ${result.stderr}`);
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

/**
 * Writes a real file at `rel` inside `dir` and pins its mtime to `isoMtime`
 * with utimesSync, so the stale/fresh relationship to a record's updated_at
 * is deterministic (no sleeps, no timing race).
 */
function touchFile(dir, rel, isoMtime) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `// fixture file for ${rel}\n`);
  const t = new Date(isoMtime);
  utimesSync(abs, t, t);
}

const LINE_SUSPECT = /line.?suspect/i;
const REL = 'src/a.mjs';

// ---------------------------------------------------------------------------
// 1. Baseline: a stale line citation in an owning article's body fires.
// Expected failure shape on HEAD: no advisory text exists at all, so
// ctx.match(LINE_SUSPECT) is null and the assert.match on it fails first.
// ---------------------------------------------------------------------------
test('LINE-SUSPECT: a stale line citation in an owning article fires — names the slug, quotes the token, points at anchors', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(
      article('alpha', [REL], {
        what_it_does: `alpha does the alpha thing (see ${REL}:42 for the guard check)`,
        updated_at: STALE_UPDATED_AT,
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir));

    assert.match(ctx, LINE_SUSPECT, 'a line-suspect advisory block is present');
    assert.match(ctx, /alpha/, 'the citing record is named (slug)');
    assert.ok(ctx.includes(`${REL}:42`), 'the stale cited token is quoted literally');
    assert.match(ctx, /anchor/i, 'guidance recommends citing anchors (function/slug/passage) over line numbers');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Bare file mention, no digits: no advisory. This assertion is a
// doesNotMatch, so it is one of the tests that CAN vacuously pass against
// HEAD (no advisory feature at all means it always doesNotMatch) — flagged
// in the report as such, not as proof of anything.
// ---------------------------------------------------------------------------
test('LINE-SUSPECT: a bare file mention with no :digits token never advises', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(
      article('alpha', [REL], {
        what_it_does: `alpha touches ${REL} directly, no line reference`,
        updated_at: STALE_UPDATED_AT, // stale by time, but there is no token to be stale about
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir));
    assert.doesNotMatch(ctx, LINE_SUSPECT, 'no line token in the body means nothing to flag as suspect');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Citation present, but record.updated_at is NEWER than the file's mtime:
// the citation was written after the file last changed, so it is not stale.
// Vacuously-passable against HEAD for the same reason as test 2.
// ---------------------------------------------------------------------------
test('LINE-SUSPECT: a line citation newer than the file\'s mtime never advises', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(
      article('alpha', [REL], {
        what_it_does: `alpha does the alpha thing (see ${REL}:42 for the guard check)`,
        updated_at: FRESH_UPDATED_AT, // record written AFTER the file last changed
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir));
    assert.doesNotMatch(ctx, LINE_SUSPECT, 'a citation newer than the file it cites is not suspect');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. The record owns `rel` (so it IS delivered) but its body cites a
// DIFFERENT file's line, never rel's own line — this isolates the token/file
// match from mere staleness (record is stale-eligible by time; the miss must
// come from the file mismatch, not the timestamp). Also vacuously-passable
// against HEAD, but non-trivially so: a naive "any digits after any colon"
// scanner would wrongly fire here, which is exactly what this pins against
// once the feature exists.
// ---------------------------------------------------------------------------
test('LINE-SUSPECT: a citation of a DIFFERENT file\'s line does not advise for this delivery', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(
      article('alpha', [REL], {
        what_it_does: `alpha does the alpha thing (see other/path.mjs:7 for the related shape)`,
        updated_at: STALE_UPDATED_AT,
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir));
    assert.doesNotMatch(ctx, LINE_SUSPECT, 'the cited line belongs to a different file — not a citation of rel');
    // CONDUCTOR-REPAIRED (blind-author over-broad assertion, oracle preserved):
    // the raw token legitimately appears in the RENDERED ARTICLE BODY (the
    // record's own prose is delivered verbatim), so asserting it absent from
    // the whole payload is unsatisfiable. The oracle — no line-suspect
    // advisory fires for a different file's citation — is fully pinned by the
    // LINE_SUSPECT doesNotMatch above.
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Decisions are delivered as CAPPED POINTERS (statement + id), never full
// bodies — but the scan must still cover them, per spec point 5. The stale
// citation lives in the statement (guaranteed part of the record's body
// text and, per AC8, part of what actually renders), so this also proves the
// pointer-rendering path does not exempt a decision from the scan.
// Expected failure shape on HEAD: LINE_SUSPECT never matches.
// ---------------------------------------------------------------------------
test('LINE-SUSPECT: a decision delivered as a pointer is scanned too — a stale citation in its statement is named', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(article('alpha', [REL])); // an owning article, so the touch delivers at all
    const dec = store.create(
      decisionRecord(`fix documented at ${REL}:13`, [REL], { updated_at: STALE_UPDATED_AT })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir));

    assert.match(ctx, LINE_SUSPECT, 'the decision-citing advisory is present');
    assert.ok(ctx.includes(`${REL}:13`), 'the stale cited token from the decision is quoted');
    // Decisions carry no `slug` field; the record is identified by its id
    // the same way every other decision pointer in the payload already is
    // (`(knowledge_get <id>)`), so the advisory naming it is expected to
    // surface that id.
    assert.ok(ctx.includes(dec.id), 'the citing decision is identified (by id, as decision pointers already are)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Two independently stale citing records: both must be named, with their
// own tokens — whether as two advisory lines or one grouped block.
// ---------------------------------------------------------------------------
test('LINE-SUSPECT: two stale citing records are both named, each with its own token', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(
      article('alpha', [REL], {
        what_it_does: `alpha does the alpha thing (see ${REL}:42 for the guard check)`,
        updated_at: STALE_UPDATED_AT,
      })
    );
    store.create(
      antiPattern('one-way latch', [REL], {
        trigger: `one-way latch trigger text, see ${REL}:99 for the failure site`,
        updated_at: STALE_UPDATED_AT,
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir));

    assert.match(ctx, LINE_SUSPECT, 'at least one line-suspect block is present');
    assert.match(ctx, /alpha/, 'the first citing record (article) is named');
    assert.match(ctx, /one-way latch/, 'the second citing record (anti_pattern) is named');
    assert.ok(ctx.includes(`${REL}:42`), 'the first token is quoted');
    assert.ok(ctx.includes(`${REL}:99`), 'the second token is quoted');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. Exit-code / warn-only discipline: the advisory only ADDS text. Re-run
// the baseline scenario and confirm every ordinary delivery element (the
// owning-knowledge header, the article's own body, its AC line) is still
// present alongside the advisory, and the hook still exits 0.
// Expected failure shape on HEAD: the advisory-related assertions fail
// (as in test 1); the ordinary-payload assertions in this test are expected
// to PASS already today, pinning that they must keep passing once the
// feature lands (a regression here would mean the advisory replaced rather
// than added to the payload).
// ---------------------------------------------------------------------------
test('LINE-SUSPECT: warn-only discipline — advisory coexists with the ordinary payload, exit code unchanged', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(
      article('alpha', [REL], {
        what_it_does: `alpha does the alpha thing (see ${REL}:42 for the guard check)`,
        updated_at: STALE_UPDATED_AT,
      })
    );
    const r = runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir);
    assert.equal(r.code, 0, 'never blocks (AC7 floor unchanged)');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

    assert.match(ctx, /owning knowledge for '.*a\.mjs'/, 'the ordinary owning-knowledge header still renders');
    assert.match(ctx, /alpha does the alpha thing/, 'the ordinary article body still renders');
    assert.match(ctx, /AC1: alpha works/, 'the ordinary AC line still renders');
    assert.match(ctx, LINE_SUSPECT, 'and the advisory is present in addition to all of the above');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. A range token `<rel>:10-20` counts as a line citation under the same
// staleness rule.
// ---------------------------------------------------------------------------
test('LINE-SUSPECT: a range token `rel:10-20` counts as a line citation and fires under the stale condition', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(
      article('alpha', [REL], {
        what_it_does: `alpha does the alpha thing (see ${REL}:10-20 for the whole block)`,
        updated_at: STALE_UPDATED_AT,
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir));

    assert.match(ctx, LINE_SUSPECT, 'a range citation is treated as a line citation');
    assert.ok(ctx.includes(`${REL}:10-20`), 'the range token is quoted literally');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// STRENGTHENING (review 2026-08-21) — the three cases the original blind
// suite could not discriminate: the lookbehind's actual purpose (path-prefix
// suppression), the stringified-newline false negative it caused, and the
// history-is-frozen-provenance exclusion.
// ---------------------------------------------------------------------------
test('LINE-SUSPECT: a citation of a LONGER path merely ENDING with rel (other/src/a.mjs:7) never advises', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(
      article('alpha', [REL], {
        what_it_does: `alpha does the alpha thing (see other/${REL}:7 for the sibling shape)`,
        updated_at: STALE_UPDATED_AT,
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir));
    assert.doesNotMatch(ctx, LINE_SUSPECT, 'a longer path ending with rel is a different file, not a citation of rel');
  } finally {
    cleanup();
  }
});

test('LINE-SUSPECT: a LINE-INITIAL citation in multiline prose (after \\n) still fires', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(
      article('alpha', [REL], {
        what_it_does: `alpha does the alpha thing.\n${REL}:42 is the guard site, cited line-initially.`,
        updated_at: STALE_UPDATED_AT,
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir));
    assert.match(ctx, LINE_SUSPECT, 'a line-initial citation is the idiomatic form and must not be lost to JSON escaping');
    assert.ok(ctx.includes(`${REL}:42`), 'the line-initial token is quoted');
  } finally {
    cleanup();
  }
});

test('LINE-SUSPECT: a citation living ONLY in history[] never advises — history is frozen provenance', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchFile(dir, REL, FILE_MTIME);
    store.create(
      article('alpha', [REL], {
        history: [{ date: STALE_UPDATED_AT, event: `built the guard at ${REL}:42 as of that day` }],
        updated_at: STALE_UPDATED_AT,
      })
    );
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, REL), dir));
    assert.doesNotMatch(ctx, LINE_SUSPECT, 'a history-only citation is provenance of its own moment, never line-suspect');
  } finally {
    cleanup();
  }
});
