// SPEC-ONLY pins for the ONE exact-token flag parser in scripts/lib/project.mjs
// (slice R5 of objective rebuild-2026-09; boards a416e276 + a506e9a7).
//
// SPEC (decision `sanctioned-script-store-writes-one-containment-helper-one-arg-parser`,
// knowledge_get d0cdd940-aa4c-40fb-9fd1-5359d5bfb41c, part (B) — quoted so this
// file is readable without a store round-trip, and so a later reader can see
// exactly which clause each pin answers to):
//
//   "scripts/lib/project.mjs gains ONE exact-token parser — arg(name, argv)
//    accepts both `--name value` and `--name=value`; hasFlag(name) recognises
//    both spellings; `--name=` (empty) is a bad VALUE refused by the caller,
//    never read as bare; DUPLICATE occurrences (`--lane=a --lane b`) are
//    refused, never silently first-or-last-wins; a split-form 'value' that is
//    itself another flag is refused."
//
// WHY IT EXISTS (the measured defect, from the same record's rationale):
// `--lane=research` was silently accepted by scripts/no-capture.mjs as a BARE
// declaration, because presence was tested with `argv.includes('--lane')` and
// the shared arg() in project.mjs:8-11 parsed the split form only. A bare
// no_capture declaration discharges a WIDER duty than a lane-scoped one, so
// the silent misparse was a knowledge-loss path, not a cosmetic one.
//
// EXECUTION DISCLOSURE: the test-writer role holds no Bash and no read access
// to scripts/lib/project.mjs (H4 read wall) — this file was NEVER RUN, and was
// written entirely from the decision record above plus the dispatch brief. The
// conductor runs the red gate. Every test below states its EXPECTED FAILURE
// SHAPE and the ONE-LINE SABOTAGE that must turn it red.
//
// ⚠ TWO SHAPE ASSUMPTIONS, STATED SO A RED IS DIAGNOSED IN ONE LINE (neither
// is derived from reading the implementation):
//   (1) ARGUMENT SPELLING — the flag NAME is passed BARE, without dashes:
//       `arg('lane', argv)` / `hasFlag('lane', argv)`. That is the dispatch
//       brief's own example (`hasFlag('lane', argv)`) and the record's
//       signature (`arg(name, argv)`). If the shipped parser takes the DASHED
//       spelling (`arg('--lane', argv)`) instead, EVERY test in this file goes
//       red at once with a nullish/undefined value — that shape (all red,
//       uniformly) is a ONE-TOKEN RE-POINT of the NAME constant below, never a
//       reason to relax an assertion. NOTE the fence added by pin 10: bare is
//       the spelling that gets NORMALIZED to `--`; a name that already carries
//       its own dashes (`-m`, `--lane`) is used exactly as given.
//   (2) ABSENT vs EMPTY — the record makes `--name=` a distinguishable EMPTY
//       STRING value, which only means something if ABSENT is NOT an empty
//       string. The absent case is therefore pinned LOOSELY on purpose
//       (`== null`, plus "is not a string"): both `undefined` and `null` pass,
//       because the record does not choose between them, while `''` and any
//       real token fail. Do not tighten this to `=== undefined` without a
//       ruling; do not loosen it to a falsy check, which `''` would satisfy
//       and which would destroy the whole point of pin 3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arg, hasFlag } from '../lib/project.mjs';

// The flag name every pin below uses, bare (see shape assumption 1).
const NAME = 'lane';

// ===========================================================================
// PIN 1 — BOTH SPELLINGS YIELD THE SAME VALUE.
// Record (B): "arg(name, argv) accepts both `--name value` and `--name=value`".
// ===========================================================================
//
// SABOTAGE that must turn this red: delete the equals-form branch from arg()
// (parse the split form only, as project.mjs:8-11 did before this slice) —
// `--lane=research` is then an unrecognized bare token, arg() returns nothing,
// and the equals-form assertion goes red while the split-form CONTROL below
// stays green. That asymmetry is the whole pin: the control proves the parser
// works at all, so the red is attributable to the equals SPELLING specifically
// and to nothing else.

test('arg: `--lane research` (split) and `--lane=research` (equals) both yield "research"', () => {
  // CONTROL ARM, FIRST — the split form is the spelling that already worked
  // before this slice. If a parser were broken/rewritten such that it returns
  // nothing for anything, this assertion catches it here, so the equals-form
  // assertion below cannot pass or fail for the wrong reason.
  assert.equal(
    arg(NAME, ['--reason', 'x', '--lane', 'research']),
    'research',
    'CONTROL-ARM-BROKEN SHAPE: the split form is the pre-existing baseline this pin compares against and must itself work',
  );

  // EXPECTED FAILURE SHAPE if this goes red: the equals form returns undefined
  // /null (unrecognized bare token) or returns the whole token
  // `--lane=research` unsplit.
  assert.equal(
    arg(NAME, ['--reason', 'x', '--lane=research']),
    'research',
    'EQUALS-FORM-UNPARSED SHAPE: `--lane=research` must yield exactly the value after the first "=", identically to the split form',
  );

  // Position independence — the pin is about the token, not about where in
  // argv it sits (a positional/index-based parse would pass the two above and
  // fail here).
  // EXPECTED FAILURE SHAPE if this goes red: the parser only inspects a fixed
  // argv position (e.g. argv[0]/argv[2]) instead of scanning for the token.
  assert.equal(arg(NAME, ['--lane', 'research', '--reason', 'x']), 'research', 'POSITIONAL-PARSE SHAPE (split form, leading position)');
  assert.equal(arg(NAME, ['--lane=research', '--reason', 'x']), 'research', 'POSITIONAL-PARSE SHAPE (equals form, leading position)');
});

// ===========================================================================
// PIN 2 — ABSENT is not a value, and never a string.
// Record (B), by implication of "`--name=` (empty) is a bad VALUE ... never
// read as bare": the caller can only refuse an empty value if it can tell
// EMPTY apart from ABSENT.
// ===========================================================================
//
// SABOTAGE that must turn this red: have arg() return `''` (or any default
// string) when the flag is absent — the `typeof !== 'string'` assertion goes
// red immediately, and pin 3's meaning collapses because empty and absent
// become indistinguishable.

test('arg: an ABSENT flag yields no value at all — nullish, and never a string', () => {
  for (const argv of [[], ['--reason', 'x'], ['--other', 'y'], ['research']]) {
    const v = arg(NAME, argv);
    // EXPECTED FAILURE SHAPE if this goes red: arg() returned a string for a
    // flag that is not present — either a default, or a stray value token
    // (`'research'` from the bare-token argv above) picked up without its flag.
    assert.ok(typeof v !== 'string', `ABSENT-YIELDS-STRING SHAPE: arg('${NAME}', ${JSON.stringify(argv)}) returned the string ${JSON.stringify(v)}; absent must never be a string (see shape assumption 2)`);
    // Deliberately loose (== null accepts both undefined and null) — the
    // record does not choose between them.
    assert.ok(v == null, `ABSENT-YIELDS-VALUE SHAPE: arg('${NAME}', ${JSON.stringify(argv)}) returned ${JSON.stringify(v)}; absent must be nullish`);
  }
});

// ===========================================================================
// PIN 3 — `--lane=` (EMPTY) is an empty-string VALUE, never bare/absent.
// Record (B): "`--name=` (empty) is a bad VALUE refused by the caller, never
// read as bare".
// ===========================================================================
//
// SABOTAGE that must turn this red: treat an empty equals-value as absent
// (`const v = token.slice(eq + 1); return v || undefined;` — the `|| undefined`
// is the whole bug) — arg() then returns undefined, the strict `=== ''`
// assertion goes red, and downstream every caller reads `--lane=` as a BARE
// declaration, which is the exact wider-duty discharge this slice exists to
// close.

test('arg: `--lane=` yields the EMPTY STRING as a value — the caller sees a bad value, not a bare flag', () => {
  const v = arg(NAME, ['--reason', 'x', '--lane=']);
  // EXPECTED FAILURE SHAPE if this goes red: `v` is undefined/null, i.e.
  // `--lane=` was collapsed into "no lane given" and would discharge the wider
  // bare duty silently.
  assert.equal(v, '', 'EMPTY-COLLAPSED-TO-ABSENT SHAPE: `--lane=` must be returned as an empty-string VALUE');
  assert.equal(typeof v, 'string', 'EMPTY-COLLAPSED-TO-ABSENT SHAPE: and it must be a string, so the caller can refuse it as a bad value');

  // The companion half, without which pin 3 is only half-pinned: the flag is
  // PRESENT. `laneGiven` (hasFlag) must be true while `laneValue` is '' — that
  // pair is precisely what lets no-capture.mjs refuse rather than fall back to
  // a bare declaration.
  // EXPECTED FAILURE SHAPE if this goes red: hasFlag returns false for
  // `--lane=`, so the caller never even reaches the bad-value refusal.
  assert.equal(hasFlag(NAME, ['--reason', 'x', '--lane=']), true, 'EMPTY-NOT-DETECTED SHAPE: `--lane=` is a PRESENT flag carrying a bad value');
});

// ===========================================================================
// PIN 4 — DUPLICATES ARE REFUSED, never first-wins or last-wins.
// Record (B): "DUPLICATE occurrences (`--lane=a --lane b`) are refused, never
// silently first-or-last-wins".
// ===========================================================================
//
// SABOTAGE that must turn this red: return on the first match (`for (const t
// of argv) if (t === '--' + name) return next;`) — the first-wins value 'a' is
// returned instead of throwing, and every assert.throws below goes red. The
// mirror sabotage (scan to the end and keep the last match) goes red the same
// way with 'b'. Neither silent resolution can survive this pin.

test('arg: DUPLICATE occurrences are refused, in every spelling combination, with the flag named in the error', () => {
  // CONTROL ARM, FIRST — a SINGLE occurrence must return normally. Without
  // this, an implementation that throws on everything would pass all three
  // attack arms below for entirely the wrong reason.
  assert.equal(
    arg(NAME, ['--lane', 'a']),
    'a',
    'CONTROL-ARM-BROKEN SHAPE: a single occurrence must return its value — otherwise the refusals below prove only that the parser throws, not that it detects duplicates',
  );

  const namesTheFlag = (err) => err instanceof Error && /--lane\b/.test(err.message);

  // EXPECTED FAILURE SHAPE if any of these three goes red: no error is thrown
  // — the parser silently resolved the conflict (first-wins or last-wins), and
  // assert.throws reports "Missing expected exception".
  // A secondary red shape: an Error IS thrown but its message does not contain
  // `--lane`, so the operator cannot tell WHICH flag was duplicated.
  assert.throws(() => arg(NAME, ['--lane=a', '--lane', 'b']), namesTheFlag, 'DUPLICATE-SILENTLY-RESOLVED SHAPE (mixed spellings — the record\'s own example)');
  assert.throws(() => arg(NAME, ['--lane', 'a', '--lane', 'b']), namesTheFlag, 'DUPLICATE-SILENTLY-RESOLVED SHAPE (split + split)');
  assert.throws(() => arg(NAME, ['--lane=a', '--lane=b']), namesTheFlag, 'DUPLICATE-SILENTLY-RESOLVED SHAPE (equals + equals)');

  // A duplicate is a duplicate even when both occurrences agree — the refusal
  // is about the ambiguity of the COMMAND LINE, not about the values differing
  // (a value-difference check would pass the three above and fail here).
  // EXPECTED FAILURE SHAPE if this goes red: the parser compares values and
  // only refuses when they differ, so `--lane a --lane a` slips through.
  assert.throws(() => arg(NAME, ['--lane', 'a', '--lane', 'a']), namesTheFlag, 'VALUE-COMPARISON SHAPE: identical duplicates are refused too');

  // CONTROL (must pass for the OPPOSITE reason): two DIFFERENT flags are not a
  // duplicate. Without this, "refuse whenever argv has two flag-looking
  // tokens" would pass every assertion above.
  assert.equal(arg(NAME, ['--lane', 'a', '--other', 'b']), 'a', 'OVER-REFUSAL SHAPE: two distinct flags are not a duplicate');

  // hasFlag SHARES the duplicate refusal (review finding: no pin covered it).
  // This matters because no-capture.mjs derives laneGiven from hasFlag and
  // laneValue from arg — if only arg() refuses, a caller that checks presence
  // FIRST gets a clean `true` from an ambiguous command line, and whether the
  // ambiguity is ever reported depends on the order the caller happens to call
  // the two functions in. The refusal must not be order-dependent.
  // EXPECTED FAILURE SHAPE if this goes red: no throw — hasFlag counts
  // occurrences without refusing (assert.throws reports "Missing expected
  // exception").
  // SABOTAGE: implement hasFlag as a bare existence scan
  // (`argv.some(t => t === '--' + name || t.startsWith('--' + name + '='))`)
  // with the duplicate check living only in arg() — this assertion goes red
  // while every arg() duplicate assertion above stays green, which is exactly
  // the half-enforced shape it exists to catch.
  assert.throws(() => hasFlag(NAME, ['--lane', 'a', '--lane', 'b']), namesTheFlag, 'DUPLICATE-UNREFUSED-BY-HASFLAG SHAPE: hasFlag shares the duplicate refusal');

  // CONTROL for the line above (must pass for the OPPOSITE reason): a single
  // occurrence must still return true, so the throw is attributable to the
  // duplicate and not to hasFlag refusing whenever the flag is present.
  assert.equal(hasFlag(NAME, ['--lane', 'a']), true, 'OVER-REFUSAL SHAPE: hasFlag returns true for a single occurrence');
});

// ===========================================================================
// PIN 5 — a split-form VALUE that is itself another flag is refused.
// Record (B): "a split-form 'value' that is itself another flag is refused".
// ===========================================================================
//
// SABOTAGE that must turn this red: take the next token unconditionally
// (`return argv[i + 1];`) — `--lane --other` then yields the string '--other'
// as if it were a lane name, no error is thrown, and assert.throws reports
// "Missing expected exception". This is the shape that silently produces a
// lane called "--other" and a `--other` flag that has vanished.

test('arg: a split-form value that is itself another flag is refused, not swallowed as the value', () => {
  // CONTROL ARM, FIRST — an ordinary split-form value still parses, so a red
  // below is attributable to the flag-shaped VALUE and not to a parser that
  // refuses split forms wholesale.
  assert.equal(arg(NAME, ['--lane', 'research', '--other', 'x']), 'research', 'CONTROL-ARM-BROKEN SHAPE: an ordinary split-form value must still parse');

  const namesTheFlag = (err) => err instanceof Error && /--lane\b/.test(err.message);

  // EXPECTED FAILURE SHAPE if either goes red: no throw — arg() returned
  // '--other' (or '--other=x') as the lane value.
  assert.throws(() => arg(NAME, ['--lane', '--other']), namesTheFlag, 'FLAG-AS-VALUE SHAPE (split form, next token is a bare flag)');
  assert.throws(() => arg(NAME, ['--lane', '--other=x']), namesTheFlag, 'FLAG-AS-VALUE SHAPE (split form, next token is an equals-form flag)');

  // CONTROL (must pass for the OPPOSITE reason): a value that merely CONTAINS
  // a dash, or is a negative-looking token, is a legitimate value — the
  // refusal keys on the token being a FLAG (leading `--`), not on dashes.
  // EXPECTED FAILURE SHAPE if this goes red: the guard is written as
  // `value.includes('-')` or `value.startsWith('-')` and over-refuses.
  assert.equal(arg(NAME, ['--lane', 'research-b']), 'research-b', 'OVER-REFUSAL SHAPE: a hyphenated value is a value, not a flag');
});

// ===========================================================================
// PIN 6 — a TRAILING split flag with no value never yields a string.
// NOT NAMED IN THE RECORD — see the note below. Pinned as a DISJUNCTION-FREE
// invariant rather than a chosen verdict, deliberately.
// ===========================================================================
//
// The record fixes the verdict for `--lane --other` (refused) and for
// `--lane=` (empty-string value), but says nothing about `--lane` as the LAST
// token with nothing after it. Two implementations are defensible: throw (same
// family as flag-as-value), or return nothing and let hasFlag+arg's
// present-but-valueless pair be refused by the caller (same family as
// `--lane=`). This pin therefore refuses to invent a verdict and instead pins
// the one thing BOTH defensible answers agree on and that no correct parser
// may do: it must never hand back a STRING. Returning `''` here would be
// actively wrong, because `''` is pin 3's reserved meaning for `--lane=`.
//
// SABOTAGE that must turn this red: `return argv[i + 1] ?? '';` — the trailing
// flag yields '' and becomes indistinguishable from `--lane=`, so the
// `typeof !== 'string'` assertion goes red.

test('arg: a TRAILING `--lane` with nothing after it never yields a string value (throws, or yields nothing — never "")', () => {
  let threw = false;
  let value;
  try {
    value = arg(NAME, ['--reason', 'x', '--lane']);
  } catch (err) {
    threw = true;
    assert.ok(err instanceof Error, 'if it refuses, it refuses with an Error');
    assert.match(err.message, /--lane\b/, 'MISSING-FLAG-NAME SHAPE: if it refuses, the message names --lane');
  }
  if (!threw) {
    assert.ok(
      typeof value !== 'string',
      `TRAILING-FLAG-YIELDS-STRING SHAPE: a trailing --lane returned ${JSON.stringify(value)}; it must never be a string, and specifically never '' (that spelling is reserved for --lane=)`,
    );
  }
});

// ===========================================================================
// PIN 7 — hasFlag recognises BOTH spellings, and is false when absent.
// Record (B): "hasFlag(name) recognises both spellings".
// ===========================================================================
//
// SABOTAGE that must turn this red: implement hasFlag as
// `argv.includes('--' + name)` — the literal, measured defect this slice
// closes. `--lane=research` is a single array element that never equals the
// string `--lane`, so the equals-form assertion goes red while the split-form
// and absent assertions stay green. That precise pattern of one red among
// three greens IS the historical bug's signature.

test('hasFlag: true for `--lane research` and for `--lane=research`, false when the flag is absent', () => {
  assert.equal(hasFlag(NAME, ['--reason', 'x', '--lane', 'research']), true, 'SPLIT-FORM-UNDETECTED SHAPE');
  assert.equal(hasFlag(NAME, ['--reason', 'x', '--lane=research']), true, 'EQUALS-FORM-UNDETECTED SHAPE (the `argv.includes("--lane")` bug)');

  // CONTROL (must pass for the OPPOSITE reason): an unconditional `return
  // true` would satisfy both assertions above; these two make a green mean
  // "detected", not "always says yes".
  assert.equal(hasFlag(NAME, []), false, 'ALWAYS-TRUE SHAPE: absent from an empty argv');
  assert.equal(hasFlag(NAME, ['--reason', 'x', '--other', 'y']), false, 'ALWAYS-TRUE SHAPE: absent from an argv carrying other flags');

  // A bare VALUE token is not a flag — `research` appearing as a positional
  // value must not make hasFlag('research', …) true.
  // EXPECTED FAILURE SHAPE if this goes red: hasFlag matches on substring or
  // on any token equality rather than on the exact `--name` token.
  assert.equal(hasFlag('research', ['--lane', 'research']), false, 'VALUE-MISTAKEN-FOR-FLAG SHAPE: a value token is not a flag');
});

// ===========================================================================
// PIN 8 — EXACT-TOKEN matching: no prefix, no substring, no partial match.
// Record (B): "ONE exact-token parser". Brief: "an unrelated flag never
// matches by prefix (`--lanes x` does not satisfy `--lane`)".
// ===========================================================================
//
// SABOTAGE that must turn this red: match with `token.startsWith('--' + name)`
// instead of `token === '--' + name || token.startsWith('--' + name + '=')` —
// `--lanes x` then satisfies `--lane`, so arg() returns 'x' (the
// nullish/non-string assertions go red) and hasFlag returns true (its
// assertion goes red). The CONTROL arm below is what makes the red meaningful:
// it proves `--lanes` is a perfectly parsable flag under its own name, so the
// failure is about PREFIX LEAKAGE and not about `--lanes` being rejected.

test('arg/hasFlag: exact-token only — `--lanes` never satisfies `--lane` (and vice versa)', () => {
  // CONTROL ARM, FIRST (must pass for the OPPOSITE reason): `--lanes x` IS a
  // valid flag when asked for under its own name.
  assert.equal(arg('lanes', ['--lanes', 'x']), 'x', 'CONTROL-ARM-BROKEN SHAPE: --lanes must parse under its own name');
  assert.equal(hasFlag('lanes', ['--lanes', 'x']), true, 'CONTROL-ARM-BROKEN SHAPE: --lanes must be detected under its own name');

  // The prefix must not leak, in either direction, in either spelling.
  for (const argv of [['--lanes', 'x'], ['--lanes=x'], ['--lane-extra', 'x'], ['--lane-extra=x']]) {
    const v = arg(NAME, argv);
    // EXPECTED FAILURE SHAPE if these go red: a prefix/substring match handed
    // back another flag's value under the name `lane`.
    assert.ok(typeof v !== 'string', `PREFIX-LEAK SHAPE: arg('${NAME}', ${JSON.stringify(argv)}) returned ${JSON.stringify(v)}`);
    assert.ok(v == null, `PREFIX-LEAK SHAPE: arg('${NAME}', ${JSON.stringify(argv)}) returned ${JSON.stringify(v)}`);
    assert.equal(hasFlag(NAME, argv), false, `PREFIX-LEAK SHAPE: hasFlag('${NAME}', ${JSON.stringify(argv)}) must be false`);
  }

  // The other direction — a SHORTER name must not match a longer token either,
  // which a `token.includes(name)` implementation would get wrong.
  assert.ok(arg('lan', ['--lane', 'research']) == null, 'SUBSTRING-MATCH SHAPE: `--lane` must not satisfy the shorter name `lan`');
  assert.equal(hasFlag('lan', ['--lane', 'research']), false, 'SUBSTRING-MATCH SHAPE: hasFlag must not substring-match either');
});

// ===========================================================================
// PIN 9 — INFERRED (not named in the record): only the FIRST `=` separates.
// ===========================================================================
//
// FLAGGED FOR THE CONDUCTOR: the record fixes `--name=value` but does not say
// what happens to a VALUE that itself contains `=`. This pin asserts the
// standard semantic (split on the first `=`, the remainder is the value
// verbatim), because the alternative — splitting on every `=` and keeping only
// the middle segment — silently TRUNCATES a legitimate value, which is the
// same class of silent misparse this whole slice exists to close. If the coder
// deliberately chose otherwise, this is the one pin in this file to adjudicate
// rather than to assume broken.
//
// SABOTAGE that must turn this red: parse with `token.split('=')[1]` instead
// of slicing at `indexOf('=')` — `--lane=a=b` yields 'a' and this assertion
// goes red, while every other pin in this file stays green.

test('arg: only the FIRST "=" separates — a value containing "=" survives verbatim (INFERRED; see note)', () => {
  assert.equal(arg(NAME, ['--lane=a=b']), 'a=b', 'VALUE-TRUNCATED-AT-SECOND-EQUALS SHAPE');
});

// ===========================================================================
// PIN 10 — SINGLE-DASH SHORT FLAGS are taken EXACTLY as given.
// ===========================================================================
//
// PROVENANCE: a MEASURED REGRESSION, not a clause of the record's own text —
// it follows from part (B)'s "every other sanctioned CLI migrates to the same
// parser in the slice". `scripts/commit-reviewed.mjs:215` calls `arg('-m')`
// and BROKE on the migration. So the parser's name normalization must be:
// prepend `--` only to a BARE name, and leave a name that already carries its
// own dashes exactly as written.
//
// SABOTAGE that must turn this red: normalize with
// `const flag = name.startsWith('--') ? name : '--' + name;` — a name that is
// neither bare nor long-form gets mangled, `-m` becomes `---m`, and every
// assertion in the first half below goes red while every other pin in this
// file stays green (they all use the bare name `lane`). That precise
// pattern — one file-final test red, eight greens — is this regression's
// signature.

test('arg/hasFlag: a single-dash short flag (`-m`) is matched exactly, and never confused with a long flag', () => {
  // CONTROL ARM FIRST (must pass for the OPPOSITE reason): the BARE-name path
  // still normalizes to `--`. Without this, "delete normalization entirely"
  // would satisfy every short-flag assertion below while silently breaking
  // every caller that passes a bare name — the fix must be additive.
  assert.equal(arg('lane', ['--lane', 'research']), 'research', 'CONTROL-ARM-BROKEN SHAPE: a bare name must still resolve to the `--` spelling');
  assert.equal(hasFlag('lane', ['--lane', 'research']), true, 'CONTROL-ARM-BROKEN SHAPE: hasFlag must still normalize a bare name');

  // The short flag itself — the shape commit-reviewed.mjs:215 needs.
  // EXPECTED FAILURE SHAPE if these go red: nullish/false, because the name
  // was mangled to `---m` (or `--` + `-m`) and matches nothing in argv.
  assert.equal(arg('-m', ['-m', 'msg']), 'msg', 'SHORT-FLAG-MANGLED SHAPE: arg(\'-m\', [\'-m\', \'msg\']) must yield the split-form value');
  assert.equal(hasFlag('-m', ['-m', 'msg']), true, 'SHORT-FLAG-MANGLED SHAPE: hasFlag(\'-m\', …) must detect the short flag');

  // A short name must NOT match the long spelling — the two are different
  // flags, and silently accepting either would hand `--message`'s value to a
  // caller that asked for `-m`.
  // EXPECTED FAILURE SHAPE if these go red: normalization stripped or
  // rewrote the dashes until `-m` and `--message` collapsed onto one another.
  assert.ok(arg('-m', ['--message', 'x']) == null, 'SHORT-MATCHES-LONG SHAPE: `-m` must not be satisfied by `--message`');
  assert.equal(hasFlag('-m', ['--message', 'x']), false, 'SHORT-MATCHES-LONG SHAPE: hasFlag(\'-m\') must be false for `--message`');

  // Exact-token discipline holds for short flags too (pin 8's rule, restated
  // on the single-dash surface): no prefix leakage.
  // EXPECTED FAILURE SHAPE if these go red: a `startsWith` match let `-mx`
  // satisfy `-m`, so a clustered/unrelated short flag donates its value.
  assert.ok(arg('-m', ['-mx', 'y']) == null, 'SHORT-PREFIX-LEAK SHAPE: `-mx` must not satisfy `-m`');
  assert.equal(hasFlag('-m', ['-mx', 'y']), false, 'SHORT-PREFIX-LEAK SHAPE: hasFlag(\'-m\') must be false for `-mx`');
});

// ===========================================================================
// PIN 11 — the FLAG-AS-VALUE refusal (pin 5) covers SINGLE-DASH flags too,
// and does NOT swallow a negative-number-looking value.
// ===========================================================================
//
// Codex review, thread 01a07ad1. Pin 5 pinned the refusal only against
// `--other`-shaped values, so the natural implementation —
// `if (value.startsWith('--')) throw …` — passes pin 5 completely while a
// SHORT flag is still swallowed as a value. Since pin 10 makes short flags
// first-class, that gap is now reachable: `commit-reviewed.mjs`'s
// `arg('-m')` sits one typo away from consuming a following `-x` as its
// commit message.
//
// SABOTAGE that must turn the first two assertions red: write the guard as
// `value.startsWith('--')` — `-x` and `-m` are not `--`-prefixed, so both are
// accepted as ordinary values, no error is thrown, and assert.throws reports
// "Missing expected exception". The THIRD assertion is what stops the
// over-correction (`value.startsWith('-')`), which would refuse `-1`.

test('arg: a SHORT flag is refused as a split-form value too, but a negative-number value is still a value', () => {
  const names = (flag) => (err) => err instanceof Error && err.message.includes(flag);

  // CONTROL ARM FIRST: an ordinary value still parses for both spellings of
  // the flag NAME, so a red below is about the VALUE being flag-shaped and not
  // about short/long names being broken.
  assert.equal(arg('-m', ['-m', 'a commit message']), 'a commit message', 'CONTROL-ARM-BROKEN SHAPE: an ordinary value must parse for a short flag');
  assert.equal(arg('--reason', ['--reason', 'because']), 'because', 'CONTROL-ARM-BROKEN SHAPE: an ordinary value must parse for a long flag');

  // EXPECTED FAILURE SHAPE if either goes red: no throw — the short flag was
  // swallowed as a value, so `-m -x` silently records the message "-x" and the
  // `-x` flag disappears from the command line unnoticed.
  assert.throws(() => arg('-m', ['-m', '-x']), names('-m'), 'SHORT-FLAG-AS-VALUE SHAPE: a short flag must not be consumed as a short flag\'s value');
  assert.throws(() => arg('--reason', ['--reason', '-m']), names('--reason'), 'SHORT-FLAG-AS-VALUE SHAPE: a short flag must not be consumed as a LONG flag\'s value either');

  // CONTROL (must pass for the OPPOSITE reason): `-1` is a VALUE. A guard
  // written as `startsWith('-')` would refuse it, breaking every caller that
  // passes a negative number or a lone dash-prefixed datum.
  // EXPECTED FAILURE SHAPE if this goes red: over-refusal — the throw fires on
  // a legitimate value and the test reports the unexpected exception.
  assert.equal(arg('--offset', ['--offset', '-1']), '-1', 'OVER-REFUSAL SHAPE: a negative-number-looking token is a value, not a flag');
  assert.equal(arg('-n', ['-n', '-1']), '-1', 'OVER-REFUSAL SHAPE: same for a short flag\'s negative value');
});
