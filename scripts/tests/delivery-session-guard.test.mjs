import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardPath, readGuard, writeGuard, sanitizeSessionId } from '../hooks/lib/delivery.mjs';

test('guard paths isolate conductor and agent receipts by session directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-session-guard-'));
  try {
    assert.equal(
      guardPath(dir, undefined, 'session-a'),
      join(dir, '.sterling', 'transient', 'delivery', 'session-a', 'guard-conductor.json')
    );
    assert.equal(
      guardPath(dir, 'agent-42', 'session-b'),
      join(dir, '.sterling', 'transient', 'delivery', 'session-b', 'guard-agent-agent-42.json')
    );
    assert.notEqual(guardPath(dir, undefined, 'session-a'), guardPath(dir, undefined, 'session-b'));
    assert.equal(
      guardPath(dir, undefined, '../another-session'),
      join(dir, '.sterling', 'transient', 'delivery', '..%2Fanother-session', 'guard-conductor.json'),
      'external session ids cannot add a path component'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing session id reads empty and never writes a shared guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-session-guard-'));
  try {
    const path = guardPath(dir, undefined, undefined);
    assert.equal(path, null);
    assert.deepEqual(readGuard(path), {
      version: 2,
      substance: [],
      discovery: [],
      frontier_files: [],
      pointer_files: [],
      gap_articles: [],
    });
    writeGuard(path, { version: 2 });
    const firstInvocation = readGuard(path);
    firstInvocation.substance.push({ id: 'record-1', revision: 1 });
    writeGuard(path, firstInvocation);
    assert.deepEqual(readGuard(guardPath(dir, undefined, undefined)).substance, [], 'the next invocation cannot see a prior mark');
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'delivery')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-string session id that stringifies empty cannot select the delivery root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-session-guard-'));
  try {
    const delivery = join(dir, '.sterling', 'transient', 'delivery');
    const firstSession = join(delivery, 'session-a');
    const secondSession = join(delivery, 'session-b');
    mkdirSync(firstSession, { recursive: true });
    mkdirSync(secondSession, { recursive: true });

    assert.equal(sanitizeSessionId([]), '%00', 'the sanitizer never produces an empty path component');
    const path = guardPath(dir, undefined, []);
    assert.equal(path, null, 'an empty-after-coercion id takes the degraded path');
    const firstInvocation = readGuard(path);
    firstInvocation.substance.push({ id: 'record-1', revision: 1 });
    writeGuard(path, firstInvocation);
    assert.deepEqual(readGuard(guardPath(dir, undefined, [])).substance, [], 'degraded invocations cannot deduplicate');
    assert.equal(existsSync(firstSession), true, 'the first sibling session remains');
    assert.equal(existsSync(secondSession), true, 'the second sibling session remains');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unencodable session id degrades loudly instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-session-guard-'));
  try {
    const delivery = join(dir, '.sterling', 'transient', 'delivery');
    const firstSession = join(delivery, 'session-a');
    const secondSession = join(delivery, 'session-b');
    mkdirSync(firstSession, { recursive: true });
    mkdirSync(secondSession, { recursive: true });

    // A lone surrogate is valid JSON but makes encodeURIComponent throw URIError.
    // An unparseable id is an ABSENT id, never a crash: the hook must reach its
    // disclosed no-dedup path rather than exit non-zero on an uncaught stack.
    const lone = '\uD800';
    assert.equal(sanitizeSessionId(lone), null, 'the sanitizer reports unencodable rather than throwing');
    const path = guardPath(dir, undefined, lone);
    assert.equal(path, null, 'an unencodable id takes the degraded path');

    const firstInvocation = readGuard(path);
    firstInvocation.substance.push({ id: 'record-1', revision: 1 });
    writeGuard(path, firstInvocation);
    assert.deepEqual(readGuard(guardPath(dir, undefined, lone)).substance, [], 'degraded invocations cannot deduplicate');
    assert.equal(existsSync(firstSession), true, 'the first sibling session remains');
    assert.equal(existsSync(secondSession), true, 'the second sibling session remains');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
