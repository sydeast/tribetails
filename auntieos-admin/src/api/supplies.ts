import { call } from '../lib/fns';

/**
 * AO-41 Supplies Tracker. Admin-gated MyTribe callables over the new top-level
 * `supplies` collection (admin-only read+write in firestore.rules). Shapes are
 * fixed by WIDGET_FANOUT_SPEC.md so all three platforms call the same thing.
 *
 * A supply is "low" when `onHand <= par` (par being the reorder threshold). The
 * server returns `lowCount` under that exact rule; `lib/dashboardInsights.ts#
 * lowSupplies` applies the same rule client-side to pick and order the rows, so
 * the headline count and the visible rows can never disagree.
 */

/** One `supplies/{id}` row as returned by `listSupplies`. */
export interface SupplyRow {
  _id: string;
  name: string;
  onHand: number;
  /** Reorder threshold: at or below this, the supply is "low". */
  par: number;
  unit: string;
}

/** The `listSupplies` response: the rows plus the server-computed low count. */
export interface SupplyList {
  supplies: SupplyRow[];
  lowCount: number;
}

/**
 * `listSupplies` (admin-gated): the full supply list plus how many are at or
 * below par. Throws (via `lib/fns.call`) on failure, surfaced fail-loud.
 */
export async function listSupplies(): Promise<SupplyList> {
  const res = await call<Record<string, never>, { supplies?: SupplyRow[]; lowCount?: number }>(
    'listSupplies',
    {},
  );
  return {
    supplies: res.supplies ?? [],
    lowCount: res.lowCount ?? 0,
  };
}

/**
 * `adjustSupply` (admin-gated): change one supply's on-hand count by [delta]
 * (the server clamps at 0 and fails loud if the supply is missing), returns the
 * new on-hand. Rejects propagate; the row shows the error rather than pretending
 * the restock landed.
 */
export async function adjustSupply(supplyId: string, delta: number): Promise<{ onHand: number }> {
  const res = await call<{ supplyId: string; delta: number }, { onHand: number }>('adjustSupply', {
    supplyId,
    delta,
  });
  return { onHand: res.onHand };
}

/** What `upsertSupply` writes. Omit `supplyId` to create; pass it to update in place. */
export interface UpsertSupplyInput {
  supplyId?: string;
  name: string;
  onHand: number;
  par: number;
  unit: string;
}

/** `upsertSupply` (admin-gated): create or update a supply, returns its id. */
export async function upsertSupply(input: UpsertSupplyInput): Promise<{ id: string }> {
  const res = await call<UpsertSupplyInput, { id: string }>('upsertSupply', input);
  return { id: res.id };
}
