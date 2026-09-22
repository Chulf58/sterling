// H19 prompt surface now drains only H10's independent immutable notices.
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking } from './lib/common.mjs';
import { noticesDir } from './lib/delivery.mjs';
import { ledgerPath, pruneUnhashed } from './lib/ledger.mjs';

const input = readStdin();
try {
  try { pruneUnhashed(ledgerPath(input.cwd, undefined, undefined)); }
  catch (e) { process.stderr.write(`H19 notice drain: ledger prune failed: ${(e && e.message) || e}\n`); }
  const dir = noticesDir(input.cwd);
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); }
  catch (e) { if (e?.code !== 'ENOENT') throw e; }
  const files = names.map((name) => join(dir, name));
  const texts = [];
  for (const file of files) {
    try {
      const text = JSON.parse(readFileSync(file, 'utf8')).text;
      if (typeof text === 'string' && text) texts.push(text);
      else texts.push('ⓘ STERLING: removed malformed immutable notice; its contents were unreadable.');
    } catch (e) {
      if (e?.code === 'ENOENT') continue;
      texts.push('ⓘ STERLING: removed malformed immutable notice; its contents were unreadable.');
    }
  }
  const legacy = join(input.cwd, '.sterling', 'transient', 'delivery', 'pending.json');
  let legacyExists = false;
  try { statSync(legacy); legacyExists = true; }
  catch (e) { if (e?.code !== 'ENOENT') throw e; }
  if (legacyExists) {
    let legacyMessage;
    try {
      const entries = JSON.parse(readFileSync(legacy, 'utf8'));
      const count = Array.isArray(entries) ? entries.length : 0;
      legacyMessage = `ⓘ STERLING: removed obsolete delayed delivery queue with ${count} pending entr${count === 1 ? 'y' : 'ies'}; none were delivered.`;
    } catch (e) {
      if (e?.code === 'ENOENT') legacyMessage = null;
      else legacyMessage = 'ⓘ STERLING: removed obsolete delayed delivery queue; its contents were unreadable and none were delivered.';
    }
    if (legacyMessage) texts.unshift(legacyMessage);
    files.push(legacy);
  }
  if (!texts.length) allow();
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: texts.join('\n\n') } }), (err) => {
    if (err) { process.stderr.write(`H19 notice drain: write failed: ${(err && err.message) || err}\n`); process.exit(0); }
    for (const file of files) rmSync(file, { force: true, recursive: file === legacy });
    process.exit(0);
  });
} catch (e) { warnNonBlocking(`H19 notice drain failed: ${(e && e.message) || e}`); }
