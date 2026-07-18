import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { LogExpenseArgs, ListExpensesArgs } from '../src/admin/expenses';
import { OptimizeRouteArgs } from '../src/admin/optimizeRoute';
import { AdjustSupplyArgs, UpsertSupplyArgs } from '../src/admin/supplies';
import { UpsertExpirationArgs } from '../src/admin/expirations';

/**
 * AO-8 drift guard (design doc `docs/2026-07-18-AO5-AO8-shared-contract-design.md`
 * Option C). The AuntieOS admin (React), the Compose app (web + desktop) and the
 * android app each HAND-MIRROR these callable request shapes; nothing but review
 * discipline keeps the four in sync. This test freezes the request field set of
 * every cross-app widget callable, so a backend shape change (added / removed /
 * renamed field) trips a red test HERE, forcing a deliberate update + a look at
 * the three mirrors, instead of drifting silently until a client breaks.
 *
 * Canonical request + response shapes live in `docs/CALLABLE_CONTRACT.md` (the
 * single human source the mirrors are built from). When you intentionally change
 * a shape: update that doc, update this frozen set, and update all three client
 * mirrors in the same change.
 */

/** Sorted top-level key set of a zod object schema. */
function shapeKeys(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape).sort();
}

const FROZEN_REQUEST_SHAPES: Record<string, { schema: z.ZodObject<z.ZodRawShape>; keys: string[] }> = {
  // AO-35
  optimizeRoute: { schema: OptimizeRouteArgs, keys: ['date'] },
  // AO-40
  logExpense: { schema: LogExpenseArgs, keys: ['amountCents', 'kind', 'note', 'occurredAt'] },
  listExpenses: { schema: ListExpensesArgs, keys: ['sinceIso'] },
  // AO-41
  adjustSupply: { schema: AdjustSupplyArgs, keys: ['delta', 'supplyId'] },
  upsertSupply: { schema: UpsertSupplyArgs, keys: ['name', 'onHand', 'par', 'supplyId', 'unit'] },
  // AO-39
  upsertExpiration: { schema: UpsertExpirationArgs, keys: ['dateIso', 'expirationId', 'kind', 'kinfolkId', 'label'] },
  // listSupplies / listExpirations take no args (empty request), so nothing to freeze.
};

describe('AO-8 callable contract drift guard', () => {
  for (const [name, { schema, keys }] of Object.entries(FROZEN_REQUEST_SHAPES)) {
    it(`${name} request shape is unchanged (update the mirrors + CALLABLE_CONTRACT.md if this fails)`, () => {
      expect(shapeKeys(schema)).toEqual([...keys].sort());
    });
  }
});
