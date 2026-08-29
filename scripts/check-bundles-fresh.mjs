// Bundled-artifact freshness check (invariant 3 instantiated on the SET, not a
// member; R2 board 7cde1448, generalized under board 16783088 / research_finding
// 890705ed) — shipped GENERATED artifacts only matter if they match a fresh
// build of their sources. Iterates the BUNDLED_ARTIFACT graph
// (scripts/lib/bundled-artifacts.mjs): each descriptor's REAL build function
// runs into a temp target (never in place — anti_pattern 37b3cb0a) and the
// EMITTED MANIFEST is byte-compared against the shipped files; any divergence
// fails loud naming the stale file and its rebuild command. The esbuild
// options live once, in the shared build functions — this file no longer
// mirrors them by hand.
//
// Three arms, each fail-closed:
//   TOTALITY   every scripts/build-*.mjs and every package.json build/build:*
//              script must be a registered builder or a listed non-shipping
//              exception — a third bundled artifact cannot ship ungated.
//   DIST GUARD a build vendors compiled workspace dist; when a guard package's
//              src is newer than its dist, BOTH sides of the byte-compare
//              vendor the same stale code and the compare is vacuously green
//              (decision 83bb625c's class) — so the checker REFUSES instead.
//              check-totality guards only schemas + mcp-server, and
//              direct-merge invokes this checker standalone, so the guard
//              lives here too.
//   FRESHNESS  temp build → manifest → byte-compare vs shipped.
//
//   node scripts/check-bundles-fresh.mjs [--shipped-root <dir>]
// --shipped-root compares against a COPY of the shipped tree instead of the
// live one — the seam tests use to prove the RED path without touching real
// artifacts (same class as build-hooks --out-dir). Builds, the totality scan
// and the dist guards always run against THIS repo. Parsed STRICTLY: an
// unrecognized or malformed argument refuses (P5), because falling through to
// the default would silently re-aim the compare at the live tree.
import { readdirSync, readFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, basename, sep } from 'node:path';
import {
  BUNDLED_ARTIFACTS,
  NON_SHIPPING_BUILD_SCRIPTS,
  NON_SHIPPING_PACKAGE_BUILD_SCRIPTS,
} from './lib/bundled-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let shippedRoot = root;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--shipped-root') {
    console.error(`check-bundles-fresh: unrecognized argument '${args[i]}' — usage: check-bundles-fresh.mjs [--shipped-root <dir>]`);
    process.exit(1);
  }
  const value = args[++i];
  if (!value || value.startsWith('--')) {
    console.error('check-bundles-fresh: --shipped-root requires a directory argument');
    process.exit(1);
  }
  shippedRoot = resolve(value);
  if (!existsSync(shippedRoot) || !statSync(shippedRoot).isDirectory()) {
    console.error(`check-bundles-fresh: --shipped-root '${shippedRoot}' is not a directory`);
    process.exit(1);
  }
}

// ---- ARM 1: totality — no build step outside the graph (fail closed) ----
const registeredBuilders = new Set(BUNDLED_ARTIFACTS.map((a) => basename(a.builderScript)));
const totalityProblems = [];
for (const a of BUNDLED_ARTIFACTS) {
  if (!existsSync(join(root, a.builderScript))) {
    totalityProblems.push(`registered builder ${a.builderScript} (artifact '${a.name}') does not exist on disk`);
  }
}
const buildScripts = readdirSync(here).filter((f) => f.startsWith('build-') && f.endsWith('.mjs'));
for (const f of buildScripts) {
  if (registeredBuilders.has(f)) continue;
  if (f in NON_SHIPPING_BUILD_SCRIPTS) continue;
  totalityProblems.push(
    `scripts/${f} is not a registered bundled-artifact builder and not a listed non-shipping build script — ` +
      'register it in scripts/lib/bundled-artifacts.mjs (BUNDLED_ARTIFACTS, so its output is freshness-gated) ' +
      'or, if nothing tracked ships from it, add it to NON_SHIPPING_BUILD_SCRIPTS with the reason'
  );
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  if (name !== 'build' && !name.startsWith('build:')) continue;
  if ([...registeredBuilders].some((b) => cmd.includes(`scripts/${b}`))) continue;
  if (name in NON_SHIPPING_PACKAGE_BUILD_SCRIPTS) continue;
  totalityProblems.push(
    `package.json script '${name}' (${cmd}) neither invokes a registered builder nor appears in ` +
      'NON_SHIPPING_PACKAGE_BUILD_SCRIPTS — a build step outside the artifact graph ships ungated'
  );
}
if (totalityProblems.length) {
  console.error('bundled-artifact totality FAILED — the artifact graph does not cover every build step:');
  for (const p of totalityProblems) console.error(`  ${p}`);
  process.exit(1);
}

// ---- ARM 2: dist guards — refuse to certify against a stale dist ----
function newestMtime(dir, exts) {
  let newest = null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = newestMtime(full, exts);
      if (sub !== null && (newest === null || sub > newest)) newest = sub;
    } else if (exts.some((x) => e.name.endsWith(x))) {
      const m = statSync(full).mtimeMs;
      if (newest === null || m > newest) newest = m;
    }
  }
  return newest;
}
const guardPkgs = [...new Set(BUNDLED_ARTIFACTS.flatMap((a) => a.distGuards ?? []))];
for (const pkgDir of guardPkgs) {
  const src = newestMtime(join(root, pkgDir, 'src'), ['.ts', '.tsx']);
  const dist = newestMtime(join(root, pkgDir, 'dist'), ['.js']);
  // 1s epsilon, same as check-totality — mtime granularity on some mounts
  if (src !== null && dist !== null && src > dist + 1000) {
    console.error(
      `bundle freshness REFUSED: ${pkgDir}/src is newer than ${pkgDir}/dist — a fresh temp build would vendor the same stale dist as the shipped bundle and compare vacuously green (decision 83bb625c). Run npm run build first.`
    );
    process.exit(1);
  }
  if (dist === null) {
    console.error(`bundle freshness REFUSED: ${pkgDir}/dist is missing — run npm run build first.`);
    process.exit(1);
  }
}

// ---- ARM 3: freshness — temp build, manifest, byte-compare ----
const stale = [];
const counts = [];
for (const artifact of BUNDLED_ARTIFACTS) {
  const tmp = mkdtempSync(join(tmpdir(), `sterling-bundle-check-${artifact.name}-`));
  try {
    const outTarget = artifact.kind === 'dir' ? tmp : join(tmp, basename(artifact.shipped));
    let emitted;
    try {
      emitted = await artifact.build({ root, outTarget });
    } catch (e) {
      // A build failure is NOT staleness — report it as its own outcome so the
      // operator fixes the build, not the bundle (83bb625c's bundles_unverified shape).
      console.error(`bundle freshness UNVERIFIABLE: building artifact '${artifact.name}' failed — ${e?.message ?? e}`);
      process.exit(1);
    }
    if (!emitted || emitted.length === 0) {
      console.error(`bundle freshness UNVERIFIABLE: artifact '${artifact.name}' emitted NOTHING — a vacuous build cannot certify freshness (P5)`);
      process.exit(1);
    }
    counts.push(`${artifact.name}: ${emitted.length} file(s)`);
    for (const builtFile of emitted) {
      const rel =
        artifact.kind === 'dir'
          ? join(artifact.shipped, relative(tmp, builtFile)).split(sep).join('/')
          : artifact.shipped;
      const shippedFile = join(shippedRoot, rel);
      if (!existsSync(shippedFile)) {
        stale.push({ artifact, rel: `${rel} (no shipped file)` });
        continue;
      }
      if (!readFileSync(builtFile).equals(readFileSync(shippedFile))) stale.push({ artifact, rel });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (stale.length) {
  console.error('bundle freshness FAILED — shipped bundles do not match a fresh build of their sources:');
  for (const s of stale) console.error(`  ${s.rel}`);
  const remedies = [...new Set(stale.map((s) => s.artifact.rebuild))];
  console.error(`Rebuild and commit: ${remedies.join(' && ')}`);
  process.exit(1);
}
console.log(`bundle freshness: ok (${counts.join(', ')} byte-identical to a fresh build)`);
