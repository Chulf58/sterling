// Pure avatar assignment for live subagents. Nothing is mutated; the next state is returned.
//
// assign(liveIds, current, rng, { poolSize = 48, freed = [] } = {}) -> { current, freed }
//   liveIds  ids of the subagents that are live now
//   current  Map<subagentId, avatarIndex> from the previous call
//   rng      () => number in [0, 1), injected so callers and tests are deterministic
//   freed    avatar indices in the order they were freed, least recently freed first
//
// - A live id already in `current` keeps its avatar (warm or resumed subagent).
// - A new id gets a random index that no other live id holds.
// - An id no longer live frees its index: it leaves `current` and moves to the tail of `freed`.
// - If every index is held by a live id, a new id shares the least recently freed index
//   (head of `freed`); with no freed history it falls back to a random index.

export interface AssignState {
  current: Map<string, number>;
  freed: number[];
}

export interface AssignOptions {
  poolSize?: number;
  freed?: readonly number[];
}

export function assign(
  liveIds: readonly string[],
  current: ReadonlyMap<string, number>,
  rng: () => number,
  { poolSize = 48, freed = [] }: AssignOptions = {},
): AssignState {
  const live = new Set(liveIds);
  const next = new Map<string, number>();
  for (const id of liveIds) {
    const idx = current.get(id);
    if (idx !== undefined) next.set(id, idx);
  }
  const held = (): Set<number> => new Set(next.values());

  let order = freed.filter((i) => i >= 0 && i < poolSize);
  const heldNow = held();
  for (const [id, idx] of current) {
    if (live.has(id) || heldNow.has(idx)) continue;
    order = order.filter((i) => i !== idx);
    order.push(idx);
  }

  for (const id of liveIds) {
    if (next.has(id)) continue;
    const taken = held();
    const open: number[] = [];
    for (let i = 0; i < poolSize; i++) if (!taken.has(i)) open.push(i);
    let pick: number;
    if (open.length > 0) pick = open[Math.floor(rng() * open.length)]!;
    else if (order.length > 0) pick = order[0]!;
    else pick = Math.floor(rng() * poolSize);
    next.set(id, pick);
  }
  return { current: next, freed: order };
}

// Small seeded rng for previews and tests.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
