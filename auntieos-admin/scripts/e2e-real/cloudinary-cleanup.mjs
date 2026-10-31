/**
 * Empties the Cloudinary `e2e/` folder at the end of a real-services run
 * (#1196, operator ruling D3, 2026-10-01: "Cloudinary uploads into an `e2e/`
 * folder, emptied at the end of each run").
 *
 * `run.sh` calls it from its EXIT trap, so it runs whatever the run did. It
 * never decides the run's verdict: a failed delete is printed and the script
 * exits 1, and `run.sh` reports that and keeps the exit code it already had.
 *
 * WHAT IT MAY TOUCH. Only `e2e/` and folders under it, on the TEST credentials
 * (`E2E_CLOUDINARY_*`). Every request goes through `guardedRequest`, which
 * refuses any delete whose target is not under `e2e/`. Three passes:
 *   1. delete by public-id prefix `e2e/` for image, video and raw uploads
 *      (fixed-folder accounts, where the folder is part of the public id);
 *   2. delete what each folder under `e2e` holds by asset folder
 *      (dynamic-folder accounts, where the public id can be anything and the
 *      folder is a separate `asset_folder` field). Only resources whose
 *      `asset_folder` is `e2e` or under it are deleted;
 *   3. delete the now-empty folders, deepest first, `e2e` last.
 *
 * NO CREDENTIALS IS A SKIP. With any of the three variables unset it prints
 * one line naming them and exits 0.
 *
 * SELF-CONTAINED ON PURPOSE. No import outside Node's standard library and no
 * path into auntieos-admin, so the portal's copy of run.sh
 * (`mytribe/web/scripts/e2e-real/`, #1194) can call this file where it is or
 * copy it unchanged.
 */

/** The only folder this script deletes from. Never configurable. */
export const E2E_FOLDER = 'e2e';
const RESOURCE_TYPES = ['image', 'video', 'raw'];
/** Cloudinary's ceiling for one delete-by-public-ids call. */
const IDS_PER_DELETE = 100;
const API = 'https://api.cloudinary.com/v1_1';

/** True for `e2e` itself and anything under `e2e/`. */
export function isUnderE2e(path) {
  const p = String(path ?? '').replace(/^\/+/, '');
  return p === E2E_FOLDER || p.startsWith(`${E2E_FOLDER}/`);
}

/** The env variables the script reads. Same names as preflight.mjs's VENDOR_SECRETS.cloudinary. */
export const ENV_NAMES = ['E2E_CLOUDINARY_CLOUD_NAME', 'E2E_CLOUDINARY_API_KEY', 'E2E_CLOUDINARY_API_SECRET'];

/**
 * Empties `e2e/`. Never throws for an HTTP failure: every failure is collected
 * in `errors` so the caller can report it.
 *
 * Returns `{ skipped, missing, deleted, foldersDeleted, errors }`.
 */
export async function cleanupE2eFolder({ env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const missing = ENV_NAMES.filter((k) => (env[k] ?? '') === '');
  if (missing.length > 0) {
    return { skipped: true, missing, deleted: 0, foldersDeleted: [], errors: [] };
  }
  const cloud = env.E2E_CLOUDINARY_CLOUD_NAME;
  const auth = `Basic ${Buffer.from(`${env.E2E_CLOUDINARY_API_KEY}:${env.E2E_CLOUDINARY_API_SECRET}`).toString('base64')}`;
  const errors = [];
  let deleted = 0;
  const foldersDeleted = [];

  /**
   * Every call to Cloudinary. A DELETE must name its target under `e2e/` in a
   * way this function can read back from the URL, or it is refused here.
   */
  async function guardedRequest(method, path, params = new URLSearchParams(), allowedIds = null) {
    if (method === 'DELETE') {
      const prefix = params.get('prefix');
      const ids = params.getAll('public_ids[]');
      const folderMatch = path.match(/^\/folders\/(.+)$/);
      const ok =
        (prefix !== null && prefix === `${E2E_FOLDER}/` && ids.length === 0) ||
        (folderMatch !== null && isUnderE2e(decodeURIComponent(folderMatch[1])) && prefix === null) ||
        (ids.length > 0 && prefix === null && allowedIds !== null && ids.every((id) => allowedIds.has(id)));
      if (!ok) throw new Error(`refused: DELETE ${path}?${params} is not confined to ${E2E_FOLDER}/`);
    }
    const query = params.toString();
    const url = `${API}/${encodeURIComponent(cloud)}${path}${query ? `?${query}` : ''}`;
    const res = await fetchImpl(url, { method, headers: { Authorization: auth } });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  }

  function describe(what, r) {
    const msg = r.body?.error?.message ?? '';
    return `${what}: HTTP ${r.status}${msg ? ` ${msg}` : ''}`;
  }

  function countDeleted(body) {
    return Object.values(body?.deleted ?? {}).filter((v) => v === 'deleted').length;
  }

  // 1. By public-id prefix. `partial` means more than one call's worth is left.
  for (const rt of RESOURCE_TYPES) {
    let cursor = null;
    for (let page = 0; page < 1000; page++) {
      const params = new URLSearchParams({ prefix: `${E2E_FOLDER}/` });
      if (cursor) params.set('next_cursor', cursor);
      let r;
      try {
        r = await guardedRequest('DELETE', `/resources/${rt}/upload`, params);
      } catch (err) {
        errors.push(`delete ${rt} by prefix: ${err.message}`);
        break;
      }
      if (!r.ok) {
        errors.push(describe(`delete ${rt} by prefix ${E2E_FOLDER}/`, r));
        break;
      }
      deleted += countDeleted(r.body);
      if (!r.body?.partial || !r.body?.next_cursor) break;
      cursor = r.body.next_cursor;
    }
  }

  // The folder tree under e2e, parents before children. 404 on e2e means no folder.
  const tree = [];
  const queue = [E2E_FOLDER];
  while (queue.length > 0) {
    const folder = queue.shift();
    let r;
    try {
      r = await guardedRequest('GET', `/folders/${folder.split('/').map(encodeURIComponent).join('/')}`);
    } catch (err) {
      errors.push(`list folder ${folder}: ${err.message}`);
      continue;
    }
    if (r.status === 404) {
      if (folder !== E2E_FOLDER) errors.push(describe(`list folder ${folder}`, r));
      continue;
    }
    if (!r.ok) {
      errors.push(describe(`list folder ${folder}`, r));
      continue;
    }
    tree.push(folder);
    for (const sub of r.body?.folders ?? []) {
      if (isUnderE2e(sub.path) && sub.path !== folder) queue.push(sub.path);
    }
  }

  // 2. By asset folder, for dynamic-folder accounts.
  for (const folder of tree) {
    let cursor = null;
    for (let page = 0; page < 1000; page++) {
      const params = new URLSearchParams({ asset_folder: folder, max_results: '500' });
      if (cursor) params.set('next_cursor', cursor);
      let r;
      try {
        r = await guardedRequest('GET', '/resources/by_asset_folder', params);
      } catch (err) {
        errors.push(`list assets in ${folder}: ${err.message}`);
        break;
      }
      if (!r.ok) {
        // A fixed-folder account may not answer this listing at all, and pass
        // 1 already emptied it. Not an error by itself: pass 3 is the check,
        // because Cloudinary refuses to delete a folder that still holds anything.
        log(`cloudinary-cleanup: ${describe(`list assets in ${folder}`, r)}; relying on the prefix pass`);
        break;
      }
      // Group by resource type and delivery type: the delete URL carries both.
      const groups = new Map();
      for (const res of r.body?.resources ?? []) {
        if (!isUnderE2e(res.asset_folder) || typeof res.public_id !== 'string') continue;
        const key = `${res.resource_type ?? 'image'}/${res.type ?? 'upload'}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(res.public_id);
      }
      for (const [key, ids] of groups) {
        for (let i = 0; i < ids.length; i += IDS_PER_DELETE) {
          const chunk = ids.slice(i, i + IDS_PER_DELETE);
          const params2 = new URLSearchParams();
          for (const id of chunk) params2.append('public_ids[]', id);
          try {
            const d = await guardedRequest('DELETE', `/resources/${key}`, params2, new Set(chunk));
            if (!d.ok) errors.push(describe(`delete ${chunk.length} ${key} in ${folder}`, d));
            else deleted += countDeleted(d.body);
          } catch (err) {
            errors.push(`delete ${key} in ${folder}: ${err.message}`);
          }
        }
      }
      if (!r.body?.next_cursor) break;
      cursor = r.body.next_cursor;
    }
  }

  // 3. The folders, deepest first.
  for (const folder of [...tree].sort((a, b) => b.split('/').length - a.split('/').length)) {
    try {
      const r = await guardedRequest('DELETE', `/folders/${folder.split('/').map(encodeURIComponent).join('/')}`);
      if (r.ok || r.status === 404) foldersDeleted.push(folder);
      else errors.push(describe(`delete folder ${folder}`, r));
    } catch (err) {
      errors.push(`delete folder ${folder}: ${err.message}`);
    }
  }

  log(`cloudinary-cleanup: deleted ${deleted} assets and ${foldersDeleted.length} folders under ${E2E_FOLDER}/ on ${cloud}`);
  return { skipped: false, missing: [], deleted, foldersDeleted, errors };
}

/** CLI: exit 0 on success or skip, 1 when any request failed. */
async function main() {
  const result = await cleanupE2eFolder();
  if (result.skipped) {
    console.log(`cloudinary-cleanup: skipped, ${result.missing.join(', ')} not set`);
    return 0;
  }
  if (result.errors.length > 0) {
    console.error(`cloudinary-cleanup: FAILED to empty ${E2E_FOLDER}/ (${result.errors.length}):`);
    for (const e of result.errors) console.error(`  - ${e}`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
