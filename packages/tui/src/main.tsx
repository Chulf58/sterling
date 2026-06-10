// Entry point: sterling-tui --store <path-to-sterling.db>
// Exits politely on non-TTY stdout (§11).
import React from 'react';
import { render } from 'ink';
import { SterlingStore } from '@sterling/store';
import { App } from './app.js';

if (!process.stdout.isTTY) {
  console.error('sterling-tui: stdout is not a TTY — exiting politely (§11)');
  process.exit(0);
}

const args = process.argv.slice(2);
const storeIdx = args.indexOf('--store');
if (storeIdx === -1 || !args[storeIdx + 1]) {
  console.error('usage: sterling-tui --store <path-to-sterling.db>');
  process.exit(2);
}

const store = new SterlingStore(args[storeIdx + 1]);
const { waitUntilExit } = render(<App store={store} />);
await waitUntilExit();
store.close();
