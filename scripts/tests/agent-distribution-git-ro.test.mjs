// agent-distribution × git-ro: S3 (templates and rendering). SPEC ONLY,
// red-first.
//
// SPEC: /tmp/claude-1000/-mnt-c-Users-cuj-Sterling/2f52faee-d898-40b6-9eae-f67501e2bf0c/scratchpad/git-ro-reach-spec.md
// section S3 (board 512f7595, branch fix/git-ro-consumer-reach), governed by
// decision `git-ro-wrapper-fixed-recipes-no-caller-flags`
// (knowledge_get 1a7f3926-703a-471c-b33a-c3907bc9c3b3) and article
// `git-ro-wrapper` (d87cb243). scripts/lib/agent-distribution.mjs itself was
// NOT read beyond the import surface (H4 read wall) — this file mirrors the
// construction idiom already used by scripts/tests/agent-distribution.test.mjs
// (read for convention only, never imported/modified): a bare template
// string, an OPTS bag, and renderInstalledAgent's {name, installedContent}
// return shape.
//
// S3.1: a new substitution variable GIT_RO = '<pluginRoot>/scripts/git-ro.mjs'
// (forward slashes, like HOOKS_DIR) is supplied at both var-construction
// sites. S3.2: agent-templates/coder.md and agent-templates/debugger.md gain
// a body section carrying the exact runnable form `{{NODE}} "{{GIT_RO}}" ...`.
// S3.3: renderInstalledAgent's unresolved-placeholder check currently scans
// only the FRONTMATTER (agent-distribution.mjs:127 per the spec); S3.3 widens
// it to the WHOLE rendered template (frontmatter + body) so a forgotten BODY
// variable cannot ship silently — this is the defect a body-only `{{GIT_RO}}`
// exercises directly.
//
// RED DISCIPLINE: {{GIT_RO}} does not exist as a substitution variable in
// today's renderInstalledAgent, so the body-substitution pin is red because
// the token is never replaced; the whole-template-unresolved-check pin is red
// (for a DIFFERENT, more specific reason worth separating out) because even
// once GIT_RO substitutes correctly elsewhere, a body-only unresolved
// placeholder does not throw today — S3.3 is what makes it throw. The two
// SHIPPED-TEMPLATE pins are red today because agent-templates/coder.md and
// agent-templates/debugger.md carry no {{GIT_RO}} token yet (D3/S3.2), and
// debugger.md still carries the literal "git are NOT available" phrasing
// (D3) S3.2 replaces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderInstalledAgent } from '../lib/agent-distribution.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const OPTS_BASE = { pluginVersion: '0.1.0', now: '2026-01-01T00:00:00.000Z' };

// A minimal template whose BODY (not the frontmatter) carries the git-ro
// runnable form. Mirrors sibling suite's MACHINE_TOKEN_TEMPLATE shape (a
// `hooks:` PreToolUse command line resolves NODE/HOOKS_DIR already, proving
// those two tokens are unaffected by anything pinned here) plus a body line
// carrying the NEW variable under test.
const GIT_RO_BODY_TEMPLATE = `---
name: probe-agent
description: Fixture agent for the git-ro body-substitution pins.
tools: Read, Bash
hooks:
  PreToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: '{{NODE}} "{{HOOKS_DIR}}/h.mjs"'
---

Read-only git via the wrapper:

{{NODE}} "{{GIT_RO}}" log
`;

test('renderInstalledAgent substitutes {{GIT_RO}} in the BODY exactly like HOOKS_DIR/NODE — the exact runnable two-token form appears verbatim', () => {
  // EXPECTED FAILURE SHAPE (today): GIT_RO is not a recognized substitution
  // variable, so the body line stays literally
  // `{{NODE}} "{{GIT_RO}}" log` (NODE substitutes via vars.NODE as usual,
  // GIT_RO does not) — the assert.match below fires against un-substituted
  // `{{GIT_RO}}` text, or renderInstalledAgent throws on an unresolved
  // placeholder if some OTHER unresolved-placeholder check already covers the
  // body (in which case this pin is still red, just via a thrown exception
  // rather than a failed match — both are the correct red for "GIT_RO does
  // not yet substitute").
  // NAMED SABOTAGE (post-fix): wire GIT_RO into the vars/token map but with
  // BACKSLASH separators or a trailing slash left in — the exact-string match
  // below goes red while a looser "does it contain git-ro.mjs" check would
  // stay green; this pin is deliberately exact for that reason.
  const { installedContent } = renderInstalledAgent(GIT_RO_BODY_TEMPLATE, 'probe-agent.md', {
    ...OPTS_BASE,
    vars: { NODE: '"/x/node"', GIT_RO: '/clone/scripts/git-ro.mjs', HOOKS_DIR: '/clone/hooks' },
  });
  assert.ok(
    installedContent.includes('"/x/node" "/clone/scripts/git-ro.mjs" log'),
    `the body must carry the exact substituted runnable form; got body-ish tail: ${JSON.stringify(installedContent.slice(installedContent.indexOf('Read-only')))}`
  );
  assert.ok(!installedContent.includes('{{GIT_RO}}'), 'no unresolved {{GIT_RO}} token survives when GIT_RO is supplied');
});

test('renderInstalledAgent THROWS naming {{GIT_RO}} when the template needs it but vars omits it — the unresolved-placeholder check covers the WHOLE template, not only the frontmatter (S3.3)', () => {
  // EXPECTED FAILURE SHAPE (today): this assert.throws does NOT throw at all
  // (today's unresolved-placeholder check, per the spec, scans only the
  // frontmatter — GIT_RO_BODY_TEMPLATE's frontmatter carries no {{GIT_RO}},
  // only the body does) — renderInstalledAgent returns normally with a
  // literal, un-substituted `{{GIT_RO}}` left sitting in the installed body,
  // which is exactly the "forgotten body variable ships silently" defect
  // S3.3 exists to close.
  // NAMED SABOTAGE (post-fix): widen the unresolved-placeholder scan to
  // include the body, but scan for a HARDCODED list of known variable names
  // instead of a generic `{{...}}` pattern — a NEW/renamed body variable that
  // is not on that hardcoded list would silently ship again, and this pin
  // (which uses GIT_RO, a variable the fix is specifically FOR) would still
  // happen to pass; the whole-template-scan framing is what the sibling
  // shipped-template pins below additionally guard, by exercising the REAL
  // templates rather than only this fixture.
  assert.throws(
    () => renderInstalledAgent(GIT_RO_BODY_TEMPLATE, 'probe-agent.md', {
      ...OPTS_BASE,
      vars: { NODE: '"/x/node"', HOOKS_DIR: '/clone/hooks' }, // GIT_RO deliberately omitted
    }),
    /\{\{GIT_RO\}\}/,
    'an unresolved {{GIT_RO}} placeholder anywhere in the rendered template (frontmatter OR body) must refuse, naming the token'
  );
});

test('SHIPPED TEMPLATE: agent-templates/coder.md carries the literal {{GIT_RO}} token in its body (S3.2)', () => {
  const content = readFileSync(join(root, 'agent-templates', 'coder.md'), 'utf8');
  // EXPECTED FAILURE SHAPE (today): coder.md carries no {{GIT_RO}} token at
  // all (D3: "No agent template mentions the wrapper") — this assert.match
  // fires against a string that lacks the substring entirely.
  // NAMED SABOTAGE: land the git-ro documentation section using the LITERAL
  // resolved path instead of the {{GIT_RO}} token (defeats S3.1's
  // per-machine substitution — a hardcoded path is wrong on every OTHER
  // machine) — this goes red.
  assert.match(content, /\{\{GIT_RO\}\}/, 'coder.md must carry the {{GIT_RO}} substitution token, not a hardcoded path');
});

test('SHIPPED TEMPLATE: agent-templates/debugger.md carries the literal {{GIT_RO}} token in its body, AND no longer claims git is unavailable (S3.2, closing D3)', () => {
  const content = readFileSync(join(root, 'agent-templates', 'debugger.md'), 'utf8');
  // EXPECTED FAILURE SHAPE (today, token half): debugger.md carries no
  // {{GIT_RO}} token — assert.match fires against a string lacking it.
  // NAMED SABOTAGE (token half): same as coder.md above — hardcode the
  // resolved path instead of the token.
  assert.match(content, /\{\{GIT_RO\}\}/, 'debugger.md must carry the {{GIT_RO}} substitution token, not a hardcoded path');

  // EXPECTED FAILURE SHAPE (today, stale-claim half): today's debugger.md:101
  // literally states git is NOT available (D3) — this assert.doesNotMatch
  // fires because the phrase IS present.
  // NAMED SABOTAGE (stale-claim half): add the {{GIT_RO}} section (satisfying
  // the arm above) WITHOUT removing the old "git are NOT available" line —
  // this arm goes red on its own even though the token arm is green, which is
  // exactly why the two are pinned as separate assertions rather than one.
  assert.doesNotMatch(content, /git are NOT available/, 'the stale "git are NOT available" claim (D3) must be removed now that read-only git ships');
});

// -----------------------------------------------------------------------------
// PRODUCTION WIRING (Codex MED: an unpinned production constructor). S3.1 fixes
// TWO var-construction sites — scripts/init-impl.mjs:643 and
// scripts/sync-agents.mjs:38 — that feed renderInstalledAgent/installAgents; a
// third real caller, scripts/install-agents.mjs, was found during review and is
// pinned here too. Read at the SOURCE-TEXT level (not imported/executed,
// consistent with the H4 read wall on scripts/lib/agent-distribution.mjs
// itself) — a bare substring probe for a `GIT_RO:` var entry that references
// `scripts/git-ro.mjs`, so removing the var from any one production
// constructor goes red without needing to invoke init/sync end-to-end.
// -----------------------------------------------------------------------------

function assertGitRoVarWired(relPath) {
  const content = readFileSync(join(root, relPath), 'utf8');
  // Anchor on the ENTRY (`GIT_RO` immediately followed by `:`, the vars-object
  // key form), never on the first bare `GIT_RO` occurrence — a comment
  // mentioning GIT_RO (e.g. "scripts/init-impl.mjs:643" per the spec pointer)
  // sits BEFORE the real entry and must not be able to satisfy this pin, nor
  // should a stray comment be able to defeat it if the real entry is missing.
  const match = /GIT_RO\s*:/.exec(content);
  // EXPECTED FAILURE SHAPE (today): match === null for all three files —
  // S3.1's GIT_RO var entry does not exist yet at ANY production construction
  // site.
  // NAMED SABOTAGE: delete (or rename without updating) the GIT_RO entry from
  // ONE of the three constructors — that file's arm goes red while its
  // siblings stay green, which is the point of pinning each site separately
  // rather than one combined assertion.
  assert.ok(match, `${relPath}: must define a GIT_RO var ENTRY (\`GIT_RO:\`, S3.1) — a comment mentioning GIT_RO does not count`);
  const lineStart = content.lastIndexOf('\n', match.index) + 1;
  const lineEnd = content.indexOf('\n', match.index);
  const entryLine = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
  // NAMED SABOTAGE: point the GIT_RO entry at the wrong file (e.g. a leftover
  // HOOKS_DIR-shaped path with no git-ro.mjs segment) — this goes red even
  // though a `GIT_RO:` key exists, which is exactly the case a bare
  // key-presence check would miss.
  assert.match(
    entryLine,
    /git-ro\.mjs/,
    `${relPath}: the GIT_RO entry's own line must reference scripts/git-ro.mjs; entry line: ${JSON.stringify(entryLine)}`
  );
}

test('PRODUCTION WIRING: scripts/init-impl.mjs defines a GIT_RO var entry referencing scripts/git-ro.mjs (S3.1)', () => {
  assertGitRoVarWired('scripts/init-impl.mjs');
});

test('PRODUCTION WIRING: scripts/sync-agents.mjs defines a GIT_RO var entry referencing scripts/git-ro.mjs (S3.1)', () => {
  assertGitRoVarWired('scripts/sync-agents.mjs');
});

test('PRODUCTION WIRING: scripts/install-agents.mjs defines a GIT_RO var entry referencing scripts/git-ro.mjs (a third real caller found in review, beside the two S3.1 names)', () => {
  assertGitRoVarWired('scripts/install-agents.mjs');
});
