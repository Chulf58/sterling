// reference_material.location is free text that is only sometimes a repo path
// (GitHub issues #14 and #13). ONE classifier in packages/schemas decides which,
// and the schema's write transform and file_key extractor both follow it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocation, isCollapsedUrlLocation, normalizeLocation, repoPathOfLocation, RECORD_TYPES } from '../index.js';

const parseRecord = (input: unknown): unknown => RECORD_TYPES.reference_material.schema.parse(input);

const ref = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: '11111111-1111-4111-8111-111111111111', // not-a-citation: fixture id
  type: 'reference_material',
  created_at: '2026-10-04T00:00:00.000Z',
  updated_at: '2026-10-04T00:00:00.000Z',
  author: 'conductor',
  status: 'active',
  superseded_by: null,
  links: [],
  scope: 'project',
  stack_tags: [],
  title: 't',
  kind: 'doc',
  location: 'docs/spec.md',
  summary: 's',
  source_date: '2026-10-04',
  capture_date: '2026-10-04',
  ...over,
});

test('classifyLocation: a scheme followed by :// is a url, whatever the scheme', () => {
  for (const u of ['https://example.com/a//b', 'http://example.com', 'git+ssh://host/repo.git', 'file:///tmp/x.md', 'HTTPS://EXAMPLE.COM/x']) {
    assert.equal(classifyLocation(u), 'url', u);
  }
});

test('classifyLocation: a location with whitespace and no scheme is prose', () => {
  for (const p of ['the vendor portal, section 3', 'Slack thread with the platform team', 'see docs/spec.md in the other repo']) {
    assert.equal(classifyLocation(p), 'prose', p);
  }
});

test('classifyLocation: one whitespace-free token with no scheme is a path, repo-relative or not', () => {
  for (const p of ['docs/spec.md', '.\\docs\\spec.md', 'README', '/abs/spec.md', 'C:\\docs\\spec.md', 'c:/docs/spec.md', '../sibling/spec.md']) {
    assert.equal(classifyLocation(p), 'path', p);
  }
});

test('classifyLocation: a collapsed URL (scheme and a single slash) is still a url, never a file', () => {
  assert.equal(classifyLocation('https:/example.com/a'), 'url');
});

test('isCollapsedUrlLocation: scheme:/x is collapsed; an intact URL, a drive path and a repo path are not', () => {
  assert.equal(isCollapsedUrlLocation('https:/example.com/a'), true);
  assert.equal(isCollapsedUrlLocation('http:/example.com'), true);
  assert.equal(isCollapsedUrlLocation('https://example.com/a'), false);
  assert.equal(isCollapsedUrlLocation('c:/docs/spec.md'), false);
  assert.equal(isCollapsedUrlLocation('docs/spec.md'), false);
  assert.equal(isCollapsedUrlLocation('the portal at https:/x'), false);
});

test('normalizeLocation: a url and prose are kept exactly; a repo path is normalized; an external path is kept', () => {
  assert.equal(normalizeLocation('https://example.com/a//b/'), 'https://example.com/a//b/');
  assert.equal(normalizeLocation('the vendor portal,  section 3'), 'the vendor portal,  section 3');
  assert.equal(normalizeLocation('.\\docs\\spec.md'), 'docs/spec.md');
  assert.equal(normalizeLocation('./docs//spec.md'), 'docs/spec.md');
  assert.equal(normalizeLocation('/abs/spec.md'), '/abs/spec.md');
  assert.equal(normalizeLocation('C:\\docs\\spec.md'), 'C:\\docs\\spec.md');
});

test('repoPathOfLocation: only a repo-relative path yields one', () => {
  assert.equal(repoPathOfLocation('./docs/spec.md'), 'docs/spec.md');
  assert.equal(repoPathOfLocation('https://example.com/a'), undefined);
  assert.equal(repoPathOfLocation('https:/example.com/a'), undefined);
  assert.equal(repoPathOfLocation('the vendor portal'), undefined);
  assert.equal(repoPathOfLocation('/abs/spec.md'), undefined);
  assert.equal(repoPathOfLocation('../sibling/spec.md'), undefined);
});

test('schema: a kind:doc URL location parses verbatim (issue #14: https:// was collapsed to https:/)', () => {
  const parsed = parseRecord(ref({ location: 'https://example.com/docs/spec' })) as unknown as { location: string };
  assert.equal(parsed.location, 'https://example.com/docs/spec');
});

test('schema: a kind:doc prose location parses verbatim; a path location is still normalized', () => {
  assert.equal((parseRecord(ref({ location: 'the vendor portal // section 3' })) as unknown as { location: string }).location, 'the vendor portal // section 3');
  assert.equal((parseRecord(ref({ location: '.\\docs\\spec.md' })) as unknown as { location: string }).location, 'docs/spec.md');
});

// Review round: a path with whitespace, slash-less schemes, and which collapses count.

test('a path-shaped location with whitespace (a separator and a file extension) is a PATH: keyed and normalized', () => {
  assert.equal(classifyLocation('docs/Design Notes/spec.md'), 'path');
  assert.equal(classifyLocation('docs\\Design Notes\\spec.md'), 'path');
  assert.equal(repoPathOfLocation('./docs//Design Notes/spec.md'), 'docs/Design Notes/spec.md');
  assert.equal((parseRecord(ref({ location: '.\\docs\\Design Notes\\spec.md' })) as unknown as { location: string }).location, 'docs/Design Notes/spec.md');
  assert.deepEqual(RECORD_TYPES.reference_material.fileKeys(ref({ location: 'docs/Design Notes/spec.md' })), ['docs/Design Notes/spec.md']);
});

test('whitespace without the path shape is prose: no separator, or no file extension at the end', () => {
  for (const p of ['See the vendor portal, section 4', 'Confluence page Design Notes', 'Design Notes.md', 'docs/Design Notes/spec']) {
    assert.equal(classifyLocation(p), 'prose', p);
    assert.deepEqual(RECORD_TYPES.reference_material.fileKeys(ref({ location: p })), [], p);
  }
});

test('the accepted cost: a sentence that ends in a file path reads as a path', () => {
  assert.equal(classifyLocation('see docs/foo.md'), 'path');
});

test('prose that mentions a URL is never path-shaped, so its :// is not collapsed', () => {
  const text = 'the portal, mirrored at https://example.com/spec.html';
  assert.equal(classifyLocation(text), 'prose');
  assert.equal(normalizeLocation(text), text);
});

test('a slash-less scheme is a url-kind location: verbatim, no file key', () => {
  for (const u of ['mailto:a@b.com', 'urn:isbn:1', 'jira:ABC-12', 'arxiv:2401.1', 'MAILTO:a@b.com']) {
    assert.equal(classifyLocation(u), 'url', u);
    assert.equal(normalizeLocation(u), u);
    assert.equal(repoPathOfLocation(u), undefined, u);
    assert.deepEqual(RECORD_TYPES.reference_material.fileKeys(ref({ location: u })), [], u);
  }
});

test('single-slash and bare scheme forms are url-kind; a Windows drive path is still a path', () => {
  for (const u of ['https:/', 's3:/bucket/key', 'file:/tmp/x', 'https:/example.com/a']) {
    assert.equal(classifyLocation(u), 'url', u);
    assert.equal(normalizeLocation(u), u);
  }
  for (const p of ['c:/docs', 'C:\\docs', 'C:\\My Docs\\spec.md']) {
    assert.equal(classifyLocation(p), 'path', p);
    assert.equal(repoPathOfLocation(p), undefined, p);
    assert.equal(normalizeLocation(p), p);
  }
});

test('a word and a colon followed by a space is prose, not a scheme', () => {
  assert.equal(classifyLocation('Note: ask the platform team'), 'prose');
});

test('isCollapsedUrlLocation counts only http, https and ftp collapses; file:/ and s3:/ are legitimate forms', () => {
  for (const u of ['https:/example.com/a', 'http:/example.com', 'ftp:/example.com/f', 'HTTPS:/example.com']) {
    assert.equal(isCollapsedUrlLocation(u), true, u);
  }
  for (const u of ['file:/tmp/x', 's3:/bucket/key', 'https:/', 'https://example.com', 'mailto:a@b.com', 'c:/docs/spec.md']) {
    assert.equal(isCollapsedUrlLocation(u), false, u);
  }
});

test('file keys: a path location is a file key; a URL, a collapsed URL and prose are not', () => {
  const keys = (location: string) => RECORD_TYPES.reference_material.fileKeys(ref({ location }));
  assert.deepEqual(keys('./docs/spec.md'), ['docs/spec.md']);
  assert.deepEqual(keys('https://example.com/docs/spec'), []);
  assert.deepEqual(keys('https:/example.com/docs/spec'), []);
  assert.deepEqual(keys('the vendor portal'), []);
});
