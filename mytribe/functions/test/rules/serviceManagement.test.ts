import { afterAll, afterEach, beforeEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser } from './setup';

/**
 * WARNING-16: Admin Service-Management catalog collections.
 *
 * The AuntieOS Android client reads/writes these directly from Settings. They
 * previously had NO rule (default-deny), so the direct reads/writes failed with
 * permission errors. Rules now grant:
 *   - base_services / supplemental_services / surcharges / discounts:
 *     read = staff or test admin (#1037, D-2026-09-28-VISIT-PRICES-ARE-BILLING:
 *     prices are billing information), write = owner
 *   - business_hours: read = signedIn(), write = owner
 *   - promo_codes: read AND write = isAuntie() (kinfolk must not enumerate codes)
 */

const CATALOG_COLLECTIONS = [
  'base_services',
  'supplemental_services',
  'surcharges',
  'discounts',
  'business_hours',
];

function asAuntie(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('auntie-uid', { admin: true });
}

describe('rules: Service-Management catalog (WARNING-16)', () => {
  beforeEach(async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      for (const col of CATALOG_COLLECTIONS) {
        await db.doc(`${col}/doc1`).set({ name: 'Seed', priceMinor: 1000 });
      }
      await db.doc('promo_codes/code1').set({ code: 'SAVE10', percentOff: 10 });
    });
  });

  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  // ── Auntie can write all six ────────────────────────────────────────────────
  it('auntie can WRITE every service catalog collection', async () => {
    const env = await getEnv();
    const fs = asAuntie(env).firestore();
    for (const col of CATALOG_COLLECTIONS) {
      await assertSucceeds(fs.doc(`${col}/doc2`).set({ name: 'New', priceMinor: 2000 }));
    }
    await assertSucceeds(fs.doc('promo_codes/code2').set({ code: 'SAVE20', percentOff: 20 }));
  });

  // ── #1037: a signed-in non-staff account reads business_hours only ────────
  it('signed-in non-auntie can READ business_hours but not the price-carrying catalog', async () => {
    const env = await getEnv();
    const fs = asUser(env, 'kinfolk-uid').firestore();
    for (const col of CATALOG_COLLECTIONS) {
      if (col === 'business_hours') await assertSucceeds(fs.doc(`${col}/doc1`).get());
      else await assertFails(fs.doc(`${col}/doc1`).get());
    }
  });
  it('auntie can READ every catalog collection', async () => {
    const env = await getEnv();
    const fs = asAuntie(env).firestore();
    for (const col of CATALOG_COLLECTIONS) {
      await assertSucceeds(fs.doc(`${col}/doc1`).get());
    }
  });

  it('signed-in non-auntie CANNOT read promo_codes', async () => {
    const env = await getEnv();
    await assertFails(asUser(env, 'kinfolk-uid').firestore().doc('promo_codes/code1').get());
  });

  // ── Signed-in non-auntie cannot WRITE any of them ──────────────────────────
  it('signed-in non-auntie CANNOT write any service catalog collection', async () => {
    const env = await getEnv();
    const fs = asUser(env, 'kinfolk-uid').firestore();
    for (const col of CATALOG_COLLECTIONS) {
      await assertFails(fs.doc(`${col}/doc1`).set({ name: 'hijack' }, { merge: true }));
    }
    await assertFails(fs.doc('promo_codes/code1').set({ percentOff: 99 }, { merge: true }));
  });

  // ── Unauthenticated denied entirely ────────────────────────────────────────
  it('unauthenticated cannot read catalog or promo_codes', async () => {
    const env = await getEnv();
    const fs = env.unauthenticatedContext().firestore();
    await assertFails(fs.doc('base_services/doc1').get());
    await assertFails(fs.doc('promo_codes/code1').get());
  });
});
