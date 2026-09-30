// Test-only preload (node --import): records the absolute path of every fs WRITE the
// process makes to the file named by STERLING_FS_WITNESS_LOG, one path per line, so a
// test can assert WHERE a spawned script wrote without trusting the script's own
// report. Passed through NODE_OPTIONS it also witnesses every node child. Covers the
// sync, callback and promise write surfaces of node:fs; syncBuiltinESMExports makes
// `import { writeFileSync } from 'node:fs'` bindings see the wrappers.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG = process.env.STERLING_FS_WITNESS_LOG;
if (!LOG) throw new Error('fs-write-witness: STERLING_FS_WITNESS_LOG is not set — refusing to run unwitnessed');
const appendRaw = fs.appendFileSync;
const asPath = (p) => (p instanceof URL ? fileURLToPath(p) : typeof p === 'string' || Buffer.isBuffer(p) ? String(p) : null);
const record = (p) => {
  const s = asPath(p);
  if (s === null) return;
  const abs = resolve(s);
  if (abs !== resolve(LOG)) appendRaw(LOG, `${abs}\n`);
};
const writeFlag = (flags) => typeof flags === 'string' ? /[wax+]/.test(flags) : typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0 : false;

// [name, indexes of the path arguments that are write DESTINATIONS]
const DEST = [
  ['writeFileSync', [0]], ['appendFileSync', [0]], ['mkdirSync', [0]], ['rmSync', [0]], ['rmdirSync', [0]],
  ['unlinkSync', [0]], ['renameSync', [0, 1]], ['copyFileSync', [1]], ['cpSync', [1]], ['symlinkSync', [1]],
  ['linkSync', [1]], ['truncateSync', [0]], ['utimesSync', [0]], ['chmodSync', [0]],
  ['writeFile', [0]], ['appendFile', [0]], ['mkdir', [0]], ['rm', [0]], ['rmdir', [0]], ['unlink', [0]],
  ['rename', [0, 1]], ['copyFile', [1]], ['cp', [1]], ['symlink', [1]], ['link', [1]], ['truncate', [0]],
];
for (const [name, idx] of DEST) {
  for (const target of [fs, fsp]) {
    const orig = target[name];
    if (typeof orig !== 'function') continue;
    target[name] = function witnessed(...args) {
      for (const i of idx) record(args[i]);
      return orig.apply(this, args);
    };
  }
}
for (const [target, name] of [[fs, 'openSync'], [fs, 'open'], [fsp, 'open']]) {
  const orig = target[name];
  target[name] = function witnessed(p, flags, ...rest) {
    if (writeFlag(flags)) record(p);
    return orig.call(this, p, flags, ...rest);
  };
}
const origStream = fs.createWriteStream;
fs.createWriteStream = function witnessed(p, ...rest) {
  record(p);
  return origStream.call(this, p, ...rest);
};
syncBuiltinESMExports();
