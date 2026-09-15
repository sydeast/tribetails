import { vi } from 'vitest';
import type { SetOptionsLike } from './mockDb';

/**
 * Replaces `db.runTransaction` on a `buildDbMock({ writeThrough: true })` db with
 * one that behaves like Firestore's optimistic transactions, for the #873 review
 * concurrency tests.
 *
 * WHY NOT THE DEFAULT SHIM. `buildDbMock`'s `runTransaction` applies each write
 * as it is staged and never checks what was read, so a row another device adds
 * between the read and the write is dropped under correct code too, and a test
 * of "the transaction keeps it" cannot tell a transaction from no transaction.
 *
 * WHAT THIS MODELS.
 *   - Writes are buffered and applied only at commit.
 *   - A read after a write in the same attempt throws, as Firestore does.
 *   - At commit, if any document the attempt read has changed since, nothing is
 *     applied and the callback runs again from the top. After [maxAttempts] it
 *     rejects with ABORTED.
 *   - `onRead(path, attempt)` runs after each document read returns, so a test
 *     can land another device's write in the window between read and commit, or
 *     check what a retry reads.
 *   - `committed()` lists, in order, the paths written THROUGH the transaction by
 *     the attempt that committed. A write made directly on a ref, inside the
 *     callback or after it, never appears there (#873 second review).
 *
 * NOT MODELLED. Queries are read but not version-checked (only document reads
 * are), and there is no lock or timing: conflicts are detected at commit only.
 */
export function installOptimisticTransactions(
  db: any,
  docs: Record<string, any>,
  opts: { maxAttempts?: number; onRead?: (path: string, attempt: number) => void } = {},
): { attempts: () => number; committed: () => string[] } {
  const maxAttempts = opts.maxAttempts ?? 5;
  let attempts = 0;
  const committedPaths: string[] = [];
  db.runTransaction = vi.fn(async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    for (let i = 0; i < maxAttempts; i += 1) {
      attempts += 1;
      const attempt = attempts;
      const seen = new Map<string, string>();
      const staged: Array<{ path: string; apply: () => Promise<unknown> }> = [];
      const stage = (ref: any, apply: () => Promise<unknown>) => {
        staged.push({ path: ref.path, apply });
      };
      const tx = {
        get: async (target: any) => {
          if (staged.length > 0) {
            throw new Error('Firestore transactions require all reads to be executed before all writes.');
          }
          const snap = await target.get();
          if (typeof target.path === 'string' && snap && 'exists' in snap) {
            seen.set(target.path, JSON.stringify(docs[target.path] ?? null));
            opts.onRead?.(target.path, attempt);
          }
          return snap;
        },
        set: (ref: any, data: any, options?: SetOptionsLike) => stage(ref, () => ref.set(data, options)),
        update: (ref: any, data: any) => stage(ref, () => ref.update(data)),
        create: (ref: any, data: any) => stage(ref, () => ref.create(data)),
        delete: (ref: any) => stage(ref, () => ref.delete()),
      };
      const result = await fn(tx);
      const stale = [...seen].some(([path, json]) => JSON.stringify(docs[path] ?? null) !== json);
      if (stale) continue;
      for (const write of staged) {
        await write.apply();
        committedPaths.push(write.path);
      }
      return result;
    }
    throw Object.assign(new Error('ABORTED: too much contention on these documents'), { code: 10 });
  });
  return { attempts: () => attempts, committed: () => [...committedPaths] };
}
