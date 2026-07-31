import { call } from '../lib/fns';
import { fromOverrides } from '../lib/featureFlagsCatalog';

/** A flag map: dotted `auntieos.*` key -> enabled. */
export type FeatureFlags = Record<string, boolean>;

/**
 * The api/ layer: one thin typed module per callable group, all routed through
 * lib/fns.call() (the single timeout + error seam, lifted from MyTribe). Screens
 * import from here, never from firebase directly. This is band B's data-layer
 * contract; every later screen follows this shape.
 */

/**
 * getFeatureFlags -> { flags }, resolved through the shared catalog before it
 * reaches the caller: every known key comes back populated (an omitted key
 * falls back to its compile-time default, never `undefined`), and an
 * ALWAYS_ON key ignores a remote `false` rather than trusting it (the same
 * immunity the Kotlin registries have carried since the 2026-06-08 prod
 * incident, a stale `broadcast: false` doc that dark-gated a live feature).
 * Unknown remote keys are dropped rather than surfaced.
 *
 * Backend asymmetry, inherited from the wasm admin (not a port bug): the READ
 * merges global `business_settings/feature_flags` with the caller's own
 * `clients/{uid}.featureFlags`, but setFeatureFlags below writes GLOBAL only. So
 * an operator who happens to carry a per-user override can see a toggle appear to
 * revert on the next load. Left faithful; flagged here to save a future debug.
 */
export async function getFeatureFlags(): Promise<FeatureFlags> {
  const res = await call<Record<string, never>, { flags: FeatureFlags }>('getFeatureFlags', {});
  return fromOverrides(res.flags ?? {});
}

/**
 * setFeatureFlags (admin-only) merges `{ key: bool }` into
 * business_settings/feature_flags.flags. Unspecified flags are preserved
 * (Firestore map merge). Returns the flags that were written.
 */
export async function setFeatureFlags(flags: FeatureFlags): Promise<FeatureFlags> {
  const res = await call<{ flags: FeatureFlags }, { ok: true; flags: FeatureFlags }>(
    'setFeatureFlags',
    { flags },
  );
  return res.flags;
}
