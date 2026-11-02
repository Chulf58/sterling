// Types only. The evidence shape is defined once, by the todo schema's
// `observations` (packages/schemas); these are derived from it.
import type { DurableRecord } from '@sterling/schemas';

export type Observation = NonNullable<Extract<DurableRecord, { type: 'todo' }>['observations']>[number];
export type ObservationCheckout = Observation['checkout'];
export type ObservationState = Observation['state'];
export type Hold = { hold: 'conductor' | 'integration'; why: string };
export function headCommit(root: string): string | null;
export function checkoutIdentity(root: string, storeRoot: string | undefined): { head: string; prefix: string; checkout: ObservationCheckout } | null;
export function observePaths(root: string, paths: string[], storeRoot: string | undefined): { head: string; checkout: ObservationCheckout; observations: Observation[] } | null;
export function treeState(root: string, commit: string, rel: string, prefix?: string): { kind: 'file'; mode: string; blob: string } | { kind: 'absent' } | { kind: 'other' } | null;
export function proveObservation(treeRoot: string, target: string, obs: Observation, opts?: { prefix?: string }): { ok: true; via: string } | ({ ok: false } & Hold);
export function itemProvenance(
  item: { file_keys?: string[]; observations?: Observation[] },
  treeRoot: string,
  target: string,
  opts?: { prefix?: string }
): { payable: boolean; conductor: boolean; holds: Hold[] };
export function prefixOf(root: string): string | null;
export function blobText(root: string, commit: string, rel: string, prefix?: string): Buffer | null;
