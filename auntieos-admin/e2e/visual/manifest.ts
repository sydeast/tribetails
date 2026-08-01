import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reader for `web/visual/manifest.json`, the ONE place the harness's screen list
 * lives. The react surface does not keep a second list; it reads this one and
 * maps each entry's `webRoute` onto the React router (see `routes.ts`).
 *
 * IT TOLERATES TWO MANIFEST SHAPES ON PURPOSE. Today the file is one flat
 * `screens` array of 20. PR #188 repairs it to 13 `screens` plus a new
 * `pendingRemock` array holding the 7 whose mockup the operator withdrew. This
 * reader accepts either, so the surface keeps working whichever lands first and
 * neither PR has to touch the other's file.
 *
 * BOTH LISTS ARE CAPTURED, and that is a deliberate reading of what
 * `pendingRemock` means. It marks a screen with no approved MOCKUP, which
 * matters to `build-report.mjs` (app vs mockup) and not at all to `baseline.mjs`
 * (app vs its own golden). A regression golden needs a shipped screen, not a
 * design to compare against. Capturing only `screens` would silently drop
 * visual coverage of 7 screens that ship today, on the day #188 merges, for a
 * reason that has nothing to do with regression.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = join(here, '..', '..', 'web', 'visual', 'manifest.json');

export interface ManifestScreen {
  readonly screen: string;
  readonly webRoute: string;
  /** Which manifest list this entry came from. Reported, never used to filter. */
  readonly list: 'screens' | 'pendingRemock';
}

export interface Manifest {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly screens: readonly ManifestScreen[];
  /** Counts as read, for the run header. */
  readonly counts: { readonly screens: number; readonly pendingRemock: number };
}

interface RawEntry {
  screen?: unknown;
  webRoute?: unknown;
}

/**
 * Entries that carry both a name and a route. An entry missing either is a
 * manifest bug and is reported by name rather than skipped in silence.
 */
function entries(raw: unknown, list: ManifestScreen['list']): ManifestScreen[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`manifest.${list} is not an array`);
  return raw.map((e: RawEntry, i) => {
    const { screen, webRoute } = e;
    if (typeof screen !== 'string' || screen === '') {
      throw new Error(`manifest.${list}[${i}] has no "screen" name`);
    }
    if (typeof webRoute !== 'string' || webRoute === '') {
      throw new Error(`manifest.${list} entry "${screen}" has no "webRoute"`);
    }
    return { screen, webRoute, list };
  });
}

export function readManifest(path: string = MANIFEST_PATH): Manifest {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    viewport?: { width?: unknown; height?: unknown };
    screens?: unknown;
    pendingRemock?: unknown;
  };

  const width = raw.viewport?.width;
  const height = raw.viewport?.height;
  if (typeof width !== 'number' || typeof height !== 'number') {
    throw new Error('manifest.viewport must declare numeric width and height');
  }

  const screens = entries(raw.screens, 'screens');
  const pending = entries(raw.pendingRemock, 'pendingRemock');
  if (screens.length === 0 && pending.length === 0) {
    throw new Error('manifest declares no screens at all');
  }

  const all = [...screens, ...pending];
  const seen = new Set<string>();
  for (const s of all) {
    if (seen.has(s.screen)) throw new Error(`manifest names "${s.screen}" twice`);
    seen.add(s.screen);
  }

  return {
    viewport: { width, height },
    screens: all,
    counts: { screens: screens.length, pendingRemock: pending.length },
  };
}
