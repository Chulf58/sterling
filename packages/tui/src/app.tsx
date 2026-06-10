// The Sterling TUI (spec §11): three tabs, one pattern — every tab is a live
// view over a durable store. Selecting any card writes the one-shot selection
// ROW in the store (P4 bans a signal file); H2 injects it into the next
// conductor message.
import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { SterlingStore } from '@sterling/store';
import { todoCards, noteCards, runView, type Card, type RunView } from './viewmodel.js';

const TABS = ['Todos', 'Notes', 'Live-run'] as const;

export interface AppProps {
  store: SterlingStore;
  pollMs?: number;
}

export function App({ store, pollMs = 1000 }: AppProps) {
  const { exit } = useApp();
  const [tab, setTab] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<string | undefined>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => setTick((n) => n + 1), pollMs);
    return () => clearInterval(t);
  }, [pollMs]);

  void tick; // re-render trigger; data re-reads below each render (live view)
  const cards: Card[] = tab === 0 ? todoCards(store) : tab === 1 ? noteCards(store) : [];
  const run: RunView | undefined = tab === 2 ? runView(store) : undefined;
  const clampedCursor = Math.min(cursor, Math.max(0, cards.length - 1));

  useInput((input, key) => {
    if (input === 'q') {
      exit();
      return;
    }
    if (key.leftArrow) setTab((t) => (t + TABS.length - 1) % TABS.length);
    if (key.rightArrow || key.tab) setTab((t) => (t + 1) % TABS.length);
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(Math.max(0, cards.length - 1), c + 1));
    if (key.return || input === ' ') {
      if (tab === 2) {
        const r = runView(store);
        if (r) store.writeSelection('run', r.id, new Date().toISOString());
      } else {
        const card = cards[clampedCursor];
        if (card) {
          store.writeSelection(card.type, card.id, new Date().toISOString());
          setExpanded((e) => (e === card.id ? undefined : card.id));
        }
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        {TABS.map((t, i) => (
          <Text key={t} inverse={i === tab} bold={i === tab}>
            {' '}{t}{' '}
          </Text>
        ))}
      </Box>
      {tab !== 2 && (
        <Box flexDirection="column" marginTop={1}>
          {cards.length === 0 && <Text dimColor>(empty)</Text>}
          {cards.map((card, i) => (
            <Box key={card.id} flexDirection="column">
              <Text inverse={i === clampedCursor}>
                {i === clampedCursor ? '› ' : '  '}
                {card.title}
              </Text>
              {expanded === card.id && card.detail ? <Text dimColor>    {card.detail}</Text> : null}
            </Box>
          ))}
        </Box>
      )}
      {tab === 2 && (
        <Box flexDirection="column" marginTop={1}>
          {!run && <Text dimColor>no active run</Text>}
          {run && (
            <>
              <Text>
                run {run.id} — <Text bold>{run.machine_state}</Text> · {run.phaseLabel}
              </Text>
              <Text>last signal: {run.lastSignal} · context warns: {run.warnFlags}</Text>
              {run.pendingJudgment ? <Text color="yellow">pending judgment: {run.pendingJudgment}</Text> : null}
            </>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>←/→ tabs · ↑/↓ move · enter select+expand · q quit</Text>
      </Box>
    </Box>
  );
}
