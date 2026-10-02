// store-path.mjs — ONE dependency-free containment helper for every sanctioned
// script that WRITES under a project's `.sterling/` tree (decision
// sanctioned-script-store-writes-one-containment-helper-one-arg-parser, R5,
// objective rebuild-2026-09, boards a416e276 + a506e9a7).
//
// DEPENDENCY-FREE (node builtins only, no @sterling/schemas import): bootstrap-
// independent like scripts/lib/store-remediation.mjs, so it stays importable by
// any sanctioned CLI regardless of whether the workspace packages are built.
//
// THE BUG THIS CLOSES: no-capture.mjs joined `process.cwd()` and `.sterling/
// transient/session-events.json` LEXICALLY and then read/wrote through
// whatever a pre-positioned symlink at any component pointed at — reproduced
// 2026-09-06 (a symlinked `.sterling/transient` redirected the write into a
// sibling project). Lexical containment (does the resolved STRING start with
// the root?) says nothing about what is actually on disk at each component.
//
// resolveStoreWritePath(root, ...segments) -> absolute path, in this order:
//   (1) LEXICAL containment first, before any fs call: a `..` segment (bare or
//       embedded, either path separator) or an absolute segment refuses
//       immediately. This is what lets a caller ask for a path under `.sterling`
//       even in a FRESH project where `.sterling` does not exist yet — no fs
//       call has happened, so there is nothing yet to fail to find.
//   (2) Walk the EXISTING path components with lstat (never a following stat):
//       any component beneath `root` that is a symlink REFUSES, unconditionally
//       — not just one whose target would escape containment. A single in-root
//       file symlink can redirect a transient write onto config.json or
//       sterling.db, so "the target resolves inside root" is not a sufficient
//       check on its own. Only ENOENT counts as ABSENT and lets the walk stop
//       cleanly; a dangling symlink is caught by the symlink check itself
//       (lstat succeeds on the link regardless of what it points at), and any
//       other error (EACCES, ...) refuses rather than being read as "not there".
//   (3) realpath the root and the deepest existing ancestor found in (2),
//       reconstruct the (possibly still-absent) suffix onto the realpath'd
//       ancestor, and re-check containment against the realpath'd root. This
//       catches a root itself reached through a benign filesystem alias
//       without re-litigating anything (2) already refused.
//   (4) Return the absolute LEXICAL path (validated by (1)-(3) to be physically
//       contained) for the caller to pass to mkdirSync/writeFileSync/rmSync —
//       or throw StorePathContainmentError naming both the root and the target
//       it refused.
//
// RESIDUAL, SCOPED AND STATED (not silently claimed away): this is
// single-user LOCAL containment, not adversarial concurrent safety. A
// check-then-mkdirSync/writeFileSync sequence is not atomic, so a symlink
// planted in the microseconds between this call returning and the caller's
// own fs call is a real, accepted TOCTOU window. What this helper closes is
// the class of bug that was measured: a symlink already in place when the
// sanctioned script runs.
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export class StorePathContainmentError extends Error {
  constructor(message, { root, target } = {}) {
    super(message);
    this.name = 'StorePathContainmentError';
    this.root = root;
    this.target = target;
  }
}

function isAbsoluteSegment(seg) {
  return seg.startsWith('/') || seg.startsWith('\\') || /^[A-Za-z]:[\\/]?/.test(seg);
}

export function resolveStoreWritePath(root, ...segments) {
  if (typeof root !== 'string' || !root.length) {
    throw new StorePathContainmentError(`resolveStoreWritePath: root must be a non-empty string (got ${JSON.stringify(root)})`);
  }
  // BAD-INPUT screen first — resolve() needs every segment to be a non-empty
  // string, and a coerced/empty segment (String(null) -> 'null', an empty
  // string vanishing without trace) is how a path quietly becomes something
  // else. This is deliberately NOT a StorePathContainmentError shape check by
  // callers — it is a different failure class than a containment verdict.
  for (const raw of segments) {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new StorePathContainmentError(
        `resolveStoreWritePath: empty or non-string segment (${JSON.stringify(raw)}) — refusing before any filesystem access`
      );
    }
  }

  const rootResolved = resolve(root);
  // Pure string math — resolve()/join() never touch the filesystem — so this
  // is still "before any fs call" even though it runs ahead of the lexical
  // `..`/absolute screen below: computing it first lets that screen's refusal
  // NAME the resolved target, which a non-existent root has nothing else to
  // report (nothing to realpath).
  const target = resolve(rootResolved, ...segments);

  // (1) LEXICAL containment, before any fs call: an absolute segment (which
  // RESETS path.resolve's base entirely, discarding root — a total redirect,
  // not merely an escape) or a `..` anywhere (bare, or embedded inside a
  // multi-part segment like 'a/../../etc') refuses immediately, naming both
  // the root and the resolved target.
  for (const raw of segments) {
    if (isAbsoluteSegment(raw)) {
      throw new StorePathContainmentError(
        `resolveStoreWritePath: absolute segment '${raw}' resolves outside '${rootResolved}' (got '${target}') — refused before any filesystem access`,
        { root: rootResolved, target }
      );
    }
    for (const part of raw.split(/[\\/]/)) {
      if (part === '..') {
        throw new StorePathContainmentError(
          `resolveStoreWritePath: '..' segment in '${raw}' resolves outside '${rootResolved}' (got '${target}') — refused before any filesystem access`,
          { root: rootResolved, target }
        );
      }
    }
  }
  // Defense in depth: every escape/reset shape above already throws by
  // construction, so this should be unreachable — but a containment helper
  // asserts its own invariant rather than trusting the reasoning that got it
  // here.
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new StorePathContainmentError(
      `resolveStoreWritePath: '${join(...segments)}' resolves outside '${rootResolved}' (got '${target}') — refusing`,
      { root: rootResolved, target }
    );
  }

  // (2) Walk EXISTING components with lstat. Any symlink component beneath
  // root refuses, unconditionally. Only ENOENT is absent.
  const relParts = target.slice(rootResolved.length).split(sep).filter(Boolean);
  let cursor = rootResolved;
  let deepestExisting = rootResolved;
  for (const part of relParts) {
    const next = join(cursor, part);
    let st;
    try {
      st = lstatSync(next);
    } catch (e) {
      if (e && e.code === 'ENOENT') break; // absent — nothing further can exist either
      throw new StorePathContainmentError(
        `resolveStoreWritePath: could not stat '${next}' while walking toward '${target}' (${(e && e.code) || (e && e.message) || e}) — refusing`,
        { root: rootResolved, target }
      );
    }
    if (st.isSymbolicLink()) {
      // Both RESOLVED paths, named (record step 4): the realpath'd root this
      // write was supposed to stay inside, and — when the link is not
      // dangling — the realpath'd location it actually escapes to. A caller
      // (or an operator reading the refusal) can then audit exactly which
      // directory the symlink redirected toward, not just which component of
      // the lexical path was a link.
      let resolvedRoot;
      try {
        resolvedRoot = realpathSync(rootResolved);
      } catch {
        resolvedRoot = rootResolved; // root itself unreadable — fall back to the lexical form
      }
      let resolvedEscape;
      try {
        resolvedEscape = realpathSync(next);
      } catch {
        resolvedEscape = null; // dangling symlink — nothing to resolve to
      }
      throw new StorePathContainmentError(
        `resolveStoreWritePath: '${next}' is a symlink component beneath '${resolvedRoot}' on the way to '${target}'` +
          (resolvedEscape ? ` — it resolves to '${resolvedEscape}', outside '${resolvedRoot}'` : ' — the link is dangling') +
          ` — refusing, nothing was written`,
        { root: resolvedRoot, target: resolvedEscape ?? target }
      );
    }
    cursor = next;
    deepestExisting = next;
  }

  // (3) realpath the root and the deepest existing ancestor; reconstruct the
  // (possibly absent) suffix onto the realpath'd ancestor and re-check.
  // A ROOT that does not exist AT ALL (ENOENT only) degrades to its lexical
  // form rather than throwing: a nonexistent tree has no symlink component to
  // redirect through (there is nothing there yet to attack), and callers that
  // build a path purely for later use — before ever checking whether the root
  // is a real, materialized directory — must still get a deterministic string
  // back. Any OTHER errno (EACCES, ELOOP, ENOTDIR, ...) is NOT absence — it is
  // a root this call could not physically verify, and "a permission error
  // refuses" (the same rule step (2)'s walk applies to every component) holds
  // for the root too: swallowing it here would return a lexical path with NO
  // physical proof behind it, exactly the gap this helper exists to close.
  let realRoot;
  try {
    realRoot = realpathSync(rootResolved);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      realRoot = rootResolved;
    } else {
      throw new StorePathContainmentError(
        `resolveStoreWritePath: could not realpath root '${rootResolved}' (${(e && e.code) || (e && e.message) || e}) — refusing rather than trusting an unverified root`,
        { root: rootResolved, target }
      );
    }
  }
  // deepestExisting was already PROVEN to exist by the lstat walk in step (2)
  // — but a realpath call can still fail (TOCTOU: the component vanished
  // between the walk and here; EACCES/ELOOP on an intermediate segment during
  // resolution). Never let that escape as a raw, unlabeled fs error — it is
  // exactly the same "could not physically verify" class step (3)'s root
  // guard already refuses on above.
  let realDeepest;
  if (deepestExisting === rootResolved) {
    realDeepest = realRoot;
  } else {
    try {
      realDeepest = realpathSync(deepestExisting);
    } catch (e) {
      throw new StorePathContainmentError(
        `resolveStoreWritePath: could not realpath '${deepestExisting}' while walking toward '${target}' (${(e && e.code) || (e && e.message) || e}) — refusing rather than trusting an unverified ancestor`,
        { root: rootResolved, target }
      );
    }
  }
  if (realDeepest !== realRoot && !realDeepest.startsWith(realRoot + sep)) {
    throw new StorePathContainmentError(
      `resolveStoreWritePath: '${deepestExisting}' resolves (via realpath) to '${realDeepest}', outside '${realRoot}' — refusing`,
      { root: realRoot, target: realDeepest }
    );
  }
  const suffix = target.slice(deepestExisting.length); // '' when target === deepestExisting
  const reconstructed = suffix ? join(realDeepest, suffix) : realDeepest;
  if (reconstructed !== realRoot && !reconstructed.startsWith(realRoot + sep)) {
    throw new StorePathContainmentError(
      `resolveStoreWritePath: reconstructed path '${reconstructed}' (root '${realRoot}', target '${target}') resolves outside the project — refusing, nothing was written`,
      { root: realRoot, target: reconstructed }
    );
  }

  // (4) The lexical, pre-validated target — physically proven contained by
  // (2)/(3) above, and safe to hand to mkdirSync/writeFileSync/rmSync.
  return target;
}
