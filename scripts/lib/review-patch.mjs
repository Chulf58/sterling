// The REVIEWABLE PATCH artifact for reviewer dispatch (board f24d42b2).
//
// WHY THIS EXISTS: roster reviewers hold no Bash grant, so a brief that says
// "run `git diff main`" is unsatisfiable and the conductor hand-materializes
// the diff instead. That hand-step is the shape decision 4977a96c already
// rejected for the SELECTION input ("a two-step remembered procedure with a
// temp file") and it has since failed the same two ways the selection input
// failed: untracked files under-counted, and line NUMBERS passed where line
// CONTENT was required. So the patch is produced by the SAME sanctioned
// command that produces the selection, from the SAME snapshot, and its path is
// reported inside the selection JSON.
//
// WHAT IT IS NOT — both obvious sources are wrong:
//   * NOT a rendering of buildDiffJson. That view is deliberately lossy: added
//     content only, no removed lines, no headers, and a pure deletion
//     contributes no entry at all (scripts/lib/diff-json.mjs).
//   * NOT bare `git diff <base>`. That omits UNTRACKED files — the documented
//     r-1417 blind spot.
// It is the tracked unified diff (committed-since-base + staged + unstaged,
// with deletions, context, modes, renames and binary indication) UNIONED with
// every untracked path rendered mechanically as a new-file stanza.
//
// SYMLINKS: an untracked symlink is represented AS A SYMLINK (mode 120000,
// blob content = the link target), never as the target's bytes. The old
// readFileSync(join(cwd, rel)) path FOLLOWED the link and would have persisted
// arbitrary out-of-repo file content into the artifact.
// NO REAPER. An earlier draft swept patches older than 24h from
// .sterling/transient/review-diffs/ and cited P4 for it. That citation was
// inverted: P4 removes transient state on THE MECHANICAL EVENT THAT ENDS ITS
// LIFE, and in direct mode no such event exists — so the sweeper substituted a
// CLOCK, which is a heuristic wearing P4's name, and it was unpinned
// file-deleting code besides. Patches simply accumulate in a git-ignored
// directory that no mechanism reads by enumeration; accumulation is boarded as
// its own item. Pipeline mode already has the real lifecycle event:
// dispose-run removes .sterling/runs/<id>/ on the normal path AND on abort.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// THE PATHNAME ESCAPING IS A SECURITY BOUNDARY, not cosmetics. A filename may
// legally contain a NEWLINE (ext4, and every filesystem Sterling runs on), and
// `ls-files --others -z` hands it over literally — correctly, since -z exists
// to avoid quoting. If a synthesized stanza then interpolates that name raw,
// the name BREAKS OUT of the `diff --git` header at column 0 and everything
// after the newline is read as PATCH STRUCTURE: an untracked file named
// `x\ndiff --git a/scripts/hooks/h6.mjs …\n@@ …` injects a whole fabricated
// stanza, so a reviewer attributes a change to a file the contributor never
// touched and the real stanza can be buried behind the forgery. Selecting the
// quoted branch on a control character is NOT the fix — the branch has to
// ESCAPE it.
//
// git's own scheme (quote.c, quote_c_style / cq_lookup), mirrored exactly:
//   \a \b \t \n \v \f \r  for 0x07–0x0d
//   \" and \\             for the two syntax characters
//   \NNN THREE-DIGIT OCTAL for every other control byte and DEL (0x7f)
// Octal rather than \xNN or \uNNNN because git's unquote_c_style reads octal:
// any other encoding yields a patch git itself cannot read back, and `git
// apply` is the strongest oracle this artifact has.
const C_ESCAPES = new Map([
  [0x07, 'a'],
  [0x08, 'b'],
  [0x09, 't'],
  [0x0a, 'n'],
  [0x0b, 'v'],
  [0x0c, 'f'],
  [0x0d, 'r'],
  [0x22, '"'],
  [0x5c, '\\'],
]);

// ONE PASS over every special character. That is also what makes the escape
// ORDER safe: a sequential replace() chain has to escape backslashes first or
// it re-escapes the backslashes it just introduced, and a single pass cannot
// see its own output at all.
function cQuoteBody(text) {
  return text.replace(/[\u0000-\u001f\u007f"\\]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const named = C_ESCAPES.get(code);
    return named ? `\\${named}` : `\\${code.toString(8).padStart(3, '0')}`;
  });
}

const needsQuoting = (text) => /[\s"\\]/.test(text) || /[\u0000-\u001f\u007f]/.test(text);

function quotePath(side, path) {
  if (!needsQuoting(path)) return `${side}/${path}`;
  return `"${side}/${cQuoteBody(path)}"`;
}

/**
 * The same C-quoting for a path about to be written to a TERMINAL. A raw
 * newline in a diagnostic is the same forgery one surface over: it lets a
 * filename fake an extra operator-visible line.
 */
export function quoteDisplayPath(path) {
  return needsQuoting(path) ? `"${cQuoteBody(path)}"` : path;
}

// The abbreviated object id git prints in an `index` line. Computed, not
// looked up: an untracked file has no object in the database yet, and asking
// git for one would both write to the odb and add an invocation to a
// derivation path that is deliberately git-free.
const ABBREV = 7;
function blobId(objectFormat, bytes) {
  return createHash(objectFormat === 'sha256' ? 'sha256' : 'sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex')
    .slice(0, ABBREV);
}

// A new-file stanza for an untracked path. `content === null` means binary:
// git emits the "Binary files … differ" INDICATION rather than content unless
// --binary is passed, and an indication is what a reviewer needs here.
// The `index <preimage>..<postimage>` line is git's own for a new file —
// all-zero preimage, no trailing mode (the mode rides `new file mode`). It is
// present for three reasons: `git apply --index` / `git am` and other tooling
// want it, its absence made the synthesized stanzas structurally different
// from the tracked ones (which reads as truncation), and that asymmetry was
// itself a hazard — a stanza forged through a filename could SUPPLY an index
// line and so look MORE authentic than the genuine ones.
function newFileStanza({ path, mode, content, blob }) {
  const head = `diff --git ${quotePath('a', path)} ${quotePath('b', path)}`;
  const lines = [head, `new file mode ${mode}`, `index ${'0'.repeat(ABBREV)}..${blob}`];
  if (content === null) {
    lines.push(`Binary files /dev/null and ${quotePath('b', path)} differ`);
    return lines.join('\n') + '\n';
  }
  // An empty new file is header-only in git's own output — no hunk.
  if (content.length === 0) return lines.join('\n') + '\n';
  const endsWithNewline = content.endsWith('\n');
  const body = content.split('\n');
  if (endsWithNewline) body.pop();
  lines.push('--- /dev/null', `+++ ${quotePath('b', path)}`, `@@ -0,0 +1,${body.length} @@`);
  for (const l of body) lines.push(`+${l}`);
  if (!endsWithNewline) lines.push('\\ No newline at end of file');
  return lines.join('\n') + '\n';
}

/**
 * Render the complete unified patch from a snapshot captured by
 * captureDiffSnapshot (scripts/lib/diff-json.mjs). Pure — no git, no fs: the
 * snapshot is the single coherent read of the working tree, and BOTH the
 * selection view and this patch are derived from it.
 * Returns { text, omitted } — `omitted` names any untracked entry that has no
 * honest patch representation (a fifo/socket, or a file that could not be
 * read). Those are reported, never silently dropped and never faked.
 */
function buildReviewPatch(snapshot) {
  const omitted = [];
  const objectFormat = snapshot.objectFormat;
  let text = snapshot.tracked;
  if (text.length && !text.endsWith('\n')) text += '\n';
  for (const entry of snapshot.untracked) {
    if (entry.kind === 'symlink') {
      const bytes = Buffer.from(entry.target, 'utf8');
      text += newFileStanza({
        path: entry.path,
        mode: '120000',
        content: entry.target,
        blob: blobId(objectFormat, bytes),
      });
    } else if (entry.kind === 'file') {
      text += newFileStanza({
        path: entry.path,
        mode: entry.mode,
        content: entry.binary ? null : entry.bytes.toString('utf8'),
        // Hashed from the RAW bytes, never the utf8 round-trip used for the
        // `+` lines: a lossy re-encode would advertise an object id that is
        // not the file's.
        blob: blobId(objectFormat, entry.bytes),
      });
    } else {
      omitted.push({ path: entry.path, reason: entry.reason });
    }
  }
  return { text, omitted };
}

/**
 * Build → hash → stage → atomically publish the patch, then report it.
 * CONTENT-ADDRESSED: <sha256 of the exact patch bytes>.patch. Same snapshot →
 * same path; a different snapshot is a different file, so a second selection
 * can never overwrite a patch an earlier reviewer is still reading (P4 forbids
 * a shared mutable transient slot).
 * IDEMPOTENT: if the path already exists its bytes are VERIFIED against ours
 * and left alone — never overwritten.
 * FAIL-CLOSED: every failure here throws. The caller must exit non-zero and
 * emit NO selection JSON, because a selection without its promised patch is
 * exactly the hand-materialization this replaces.
 */
export function publishReviewPatch({ cwd, snapshot, runId }) {
  const { text, omitted } = buildReviewPatch(snapshot);
  const bytes = Buffer.from(text, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Defence in depth on the one value here that is interpolated into a path.
  // runId arrives from a store record (requireRun), never raw CLI, so this is
  // not a live hole — but a `..` or a separator reaching it would put the
  // artifact outside the run directory, and the check costs three lines.
  if (runId != null && (!/^[A-Za-z0-9._-]+$/.test(runId) || /^\.\.?$/.test(runId))) {
    throw new Error(`refusing to publish under an unexpected run id: ${JSON.stringify(runId)}`);
  }
  const dir = runId
    ? join(cwd, '.sterling', 'runs', runId, 'review-diffs')
    : join(cwd, '.sterling', 'transient', 'review-diffs');
  mkdirSync(dir, { recursive: true });
  // SELF-CONTAMINATION GUARD. An artifact published inside the repo becomes an
  // UNTRACKED file that the next capture reads as part of the change under
  // review: the reviewer is handed a patch containing a patch, and the content
  // address never converges. Sterling's own .gitignore covers .sterling/, but
  // a consumer project's may not — so the directory ignores ITSELF. `*` hides
  // every file here including this .gitignore, so nothing about it is visible
  // to any capture. `wx` makes it idempotent and race-safe.
  try {
    writeFileSync(join(dir, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const finalPath = join(dir, `${sha256}.patch`);

  const existing = lstatSync(finalPath, { throwIfNoEntry: false });
  if (existing) {
    // lstat, not stat: a symlink planted at the content-addressed name must be
    // caught as "not a regular file", never followed and read (or written)
    // through.
    if (!existing.isFile()) {
      throw new Error(`review artifact path exists and is not a regular file — refusing to publish over it: ${finalPath}`);
    }
    const have = readFileSync(finalPath);
    if (!have.equals(bytes)) {
      throw new Error(
        `review artifact ${sha256}.patch already exists with DIFFERENT bytes (${have.length} on disk vs ${bytes.length} built) — refusing to overwrite`
      );
    }
  } else {
    // Stage under a unique name, then rename: a reader never observes a
    // partial patch at the published path, and `wx` refuses to write through a
    // planted staging file.
    const tmp = join(dir, `.tmp-${process.pid}-${randomUUID()}.patch`);
    writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    try {
      renameSync(tmp, finalPath);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* the reaper sweeps a stranded staging file */
      }
      throw e;
    }
    // NO read-back verify here. The `wx` staging write plus renameSync is what
    // earns the guarantee (a concurrent reader never sees a partial file); a
    // re-read after a successful LOCAL rename could only catch a replacement
    // in the microseconds between the two calls, and nothing pins it. The
    // pre-existing-path verification above is the one that matters, and it
    // stays.
  }

  return { artifact: { path: finalPath, sha256, base: snapshot.base }, omitted };
}
