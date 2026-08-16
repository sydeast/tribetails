import type { CapturedWalk } from './types';

/**
 * Where a walk lives until it becomes issues.
 *
 * IndexedDB rather than memory, because the walks this recorder is for involve
 * reloading, signing in again, and following a link that hard-navigates. A
 * recorder that lost the walk on any of those would be marked once and then
 * never trusted again.
 *
 * One record per session, rewritten as it grows. rrweb events are the bulk of
 * it, and IndexedDB stores structured clones, so no serialisation happens on
 * the write path.
 */

const DB_NAME = 'tribetails-issue-recorder';
const STORE = 'walks';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'meta.id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
      }),
  );
}

export function saveWalk(walk: CapturedWalk): Promise<IDBValidKey> {
  return tx('readwrite', (store) => store.put(walk));
}

export function loadWalks(): Promise<CapturedWalk[]> {
  return tx<CapturedWalk[]>('readonly', (store) => store.getAll() as IDBRequest<CapturedWalk[]>);
}

export function deleteWalk(id: string): Promise<undefined> {
  return tx('readwrite', (store) => store.delete(id) as IDBRequest<undefined>);
}

/**
 * Hands the walk to the operator as one file.
 *
 * A DOWNLOAD RATHER THAN AN UPLOAD, and that is the only thing that works
 * everywhere. On the live sites the page is https and a POST to a localhost
 * collector is blocked as mixed content, so there is no server to send it to;
 * on a dev walk a download is the same two seconds. The file goes to Downloads
 * and the issue-filing step reads it from there.
 *
 * Gzipped through `CompressionStream`, which every browser this ships to has:
 * an hour of rrweb events is tens of megabytes raw and about a tenth of that
 * compressed, and nobody wants to hand a 40 MB JSON around.
 */
export async function exportWalk(walk: CapturedWalk): Promise<string> {
  const json = JSON.stringify(walk);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(stream).blob();

  const filename = `walk-${walk.meta.app}-${walk.meta.startedIso.replace(/[:.]/g, '-')}.json.gz`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a timer rather than immediately: Safari cancels an in-flight
  // download when the object URL is released synchronously after the click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return filename;
}
