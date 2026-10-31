import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { cleanupE2eFolder, isUnderE2e } from './cloudinary-cleanup.mjs';

/**
 * The cleanup runs with real Cloudinary credentials at the end of every
 * real-services run (#1196). The properties that matter: it deletes nothing
 * outside `e2e/`, it is a clean skip without credentials, and a failure is
 * reported without changing the run's exit code.
 */

const ENV = {
  E2E_CLOUDINARY_CLOUD_NAME: 'testcloud',
  E2E_CLOUDINARY_API_KEY: 'key',
  E2E_CLOUDINARY_API_SECRET: 'secret',
};

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * A fake Admin API holding assets in `e2e`, `e2e/sub` and, deliberately, in
 * folders that must never be touched. [overrides] maps `METHOD path` to a
 * response for failure cases.
 */
function fakeCloudinary(overrides = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace('/v1_1/testcloud', '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path, params: u.searchParams, url, auth: init?.headers?.Authorization });
    const key = `${method} ${path}`;
    if (overrides[key]) return overrides[key]({ params: u.searchParams, calls });
    if (method === 'DELETE' && path === '/resources/image/upload' && u.searchParams.get('prefix')) {
      // First call reports more left, as Cloudinary does past 1000 assets.
      const first = !u.searchParams.get('next_cursor');
      return json(200, { deleted: { 'e2e/a': 'deleted', 'e2e/b': 'deleted' }, partial: first, next_cursor: first ? 'c1' : undefined });
    }
    if (method === 'DELETE' && path.startsWith('/resources/') && u.searchParams.get('prefix')) return json(200, { deleted: {}, partial: false });
    if (method === 'GET' && path === '/folders/e2e') {
      // A malformed answer naming a folder outside e2e must not be followed.
      return json(200, { folders: [{ path: 'e2e/sub' }, { path: 'kin-photos' }] });
    }
    if (method === 'GET' && path === '/folders/e2e/sub') return json(200, { folders: [] });
    if (method === 'GET' && path === '/resources/by_asset_folder') {
      const folder = u.searchParams.get('asset_folder');
      return json(200, {
        resources: [
          { public_id: `dyn-${folder}`, asset_folder: folder, resource_type: 'image', type: 'upload' },
          // Listed by a misbehaving API under the wrong folder: never deleted.
          { public_id: 'kin-photo-real', asset_folder: 'kin-photos', resource_type: 'image', type: 'upload' },
        ],
      });
    }
    if (method === 'DELETE' && path === '/resources/image/upload') {
      return json(200, { deleted: Object.fromEntries(u.searchParams.getAll('public_ids[]').map((id) => [id, 'deleted'])) });
    }
    if (method === 'DELETE' && path.startsWith('/folders/')) return json(200, { deleted: [path] });
    return json(404, { error: { message: 'not found' } });
  });
  return { fetchImpl, calls };
}

describe('isUnderE2e', () => {
  it('admits e2e and its subfolders only', () => {
    for (const p of ['e2e', 'e2e/', 'e2e/sub', '/e2e/x']) expect(isUnderE2e(p), p).toBe(true);
    for (const p of ['', 'e2e2', 'e2e-old', 'kin-photos', 'x/e2e', undefined]) expect(isUnderE2e(p), String(p)).toBe(false);
  });
});

describe('cleanupE2eFolder', () => {
  it('skips with the missing variables named, and calls nothing, when credentials are absent', async () => {
    const { fetchImpl } = fakeCloudinary();
    const r = await cleanupE2eFolder({ env: { E2E_CLOUDINARY_CLOUD_NAME: 'testcloud' }, fetchImpl, log: () => {} });
    expect(r.skipped).toBe(true);
    expect(r.missing).toEqual(['E2E_CLOUDINARY_API_KEY', 'E2E_CLOUDINARY_API_SECRET']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('deletes only under e2e/: every DELETE names the e2e/ prefix, an e2e folder, or an asset listed in one', async () => {
    const { fetchImpl, calls } = fakeCloudinary();
    const r = await cleanupE2eFolder({ env: ENV, fetchImpl, log: () => {} });
    expect(r.errors).toEqual([]);
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) {
      const prefix = d.params.get('prefix');
      const ids = d.params.getAll('public_ids[]');
      const folder = d.path.match(/^\/folders\/(.+)$/)?.[1];
      if (prefix !== null) expect(prefix, d.url).toBe('e2e/');
      else if (folder) expect(isUnderE2e(decodeURIComponent(folder)), d.url).toBe(true);
      else expect(ids.every((id) => id.startsWith('dyn-e2e')), d.url).toBe(true);
    }
    const allIds = deletes.flatMap((d) => d.params.getAll('public_ids[]'));
    expect(allIds).not.toContain('kin-photo-real');
    expect(calls.some((c) => c.path.includes('kin-photos'))).toBe(false);
    // Prefix pass on all three resource types, following the cursor.
    expect(deletes.filter((d) => d.path === '/resources/image/upload' && d.params.get('prefix')).length).toBe(2);
    expect(deletes.some((d) => d.path === '/resources/video/upload')).toBe(true);
    expect(deletes.some((d) => d.path === '/resources/raw/upload')).toBe(true);
    // Folders deepest first, e2e last.
    expect(deletes.filter((d) => d.path.startsWith('/folders/')).map((d) => d.path)).toEqual(['/folders/e2e/sub', '/folders/e2e']);
    expect(r.foldersDeleted).toEqual(['e2e/sub', 'e2e']);
    expect(r.deleted).toBe(6);
    // The test credentials, as Basic auth.
    expect(calls[0].auth).toBe(`Basic ${Buffer.from('key:secret').toString('base64')}`);
  });

  it('reports a failed delete without throwing', async () => {
    const { fetchImpl } = fakeCloudinary({
      'DELETE /folders/e2e': () => json(400, { error: { message: 'Folder is not empty' } }),
      'DELETE /resources/video/upload': () => json(500, { error: { message: 'internal' } }),
    });
    const r = await cleanupE2eFolder({ env: ENV, fetchImpl, log: () => {} });
    expect(r.errors).toEqual([
      'delete video by prefix e2e/: HTTP 500 internal',
      'delete folder e2e: HTTP 400 Folder is not empty',
    ]);
  });

  it('treats a missing e2e folder as nothing to do', async () => {
    const { fetchImpl } = fakeCloudinary({ 'GET /folders/e2e': () => json(404, { error: { message: 'not found' } }) });
    const r = await cleanupE2eFolder({ env: ENV, fetchImpl, log: () => {} });
    expect(r.errors).toEqual([]);
    expect(r.foldersDeleted).toEqual([]);
  });
});

describe('run.sh on_exit', () => {
  /**
   * Runs run.sh's real `on_exit` function (extracted from the file, not a
   * copy) with a `node` on PATH that fails the way a failed cleanup does, and
   * checks the exit code the run already had comes out unchanged.
   */
  function runOnExit(exitCode) {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'run.sh'), 'utf8');
    const fn = src.match(/^on_exit\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(fn, 'on_exit in run.sh').toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), 'e2e-real-onexit-'));
    const fakeNode = join(dir, 'node');
    writeFileSync(fakeNode, '#!/bin/sh\necho "fake node $*"\nexit 1\n');
    chmodSync(fakeNode, 0o755);
    const script = [
      'set -euo pipefail',
      `SCRIPT_DIR=${JSON.stringify(here)}`,
      `REAL_DIR=${JSON.stringify(dir)}`,
      `VERDICT=${JSON.stringify(join(dir, 'verdict.json'))}`,
      `RESULTS=${JSON.stringify(join(dir, 'results.json'))}`,
      `LOG=${JSON.stringify(join(dir, 'emulators.log'))}`,
      `SECRETS_FILE=${JSON.stringify(join(dir, 'none'))}`,
      fn,
      'trap on_exit EXIT',
      `exit ${exitCode}`,
    ].join('\n');
    return spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' });
  }

  it('keeps the run’s exit code when the cleanup fails, and says so', () => {
    for (const code of [0, 1, 7]) {
      const r = runOnExit(code);
      expect(r.status, `exit ${code}`).toBe(code);
      expect(r.stderr).toMatch(/Cloudinary cleanup FAILED/);
      expect(r.stdout).toMatch(/fake node .*cloudinary-cleanup\.mjs/);
    }
  });
});
