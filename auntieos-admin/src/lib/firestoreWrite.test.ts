import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The seam every direct Firestore write in this app now goes through (#807),
 * and the property that makes it worth existing: a write the device cannot
 * acknowledge RETURNS, instead of leaving a spinner on for as long as the tab
 * is open.
 *
 * The Firebase functions are mocked rather than driven against an emulator,
 * because what is being tested is not Firestore. It is this module's contract
 * with the fourteen `api/` modules that import it: the same names, the same
 * signatures, and a promise that settles.
 */

const fb = vi.hoisted(() => ({
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  addDoc: vi.fn(),
  doc: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  setDoc: (...a: unknown[]) => fb.setDoc(...a),
  updateDoc: (...a: unknown[]) => fb.updateDoc(...a),
  deleteDoc: (...a: unknown[]) => fb.deleteDoc(...a),
  addDoc: (...a: unknown[]) => fb.addDoc(...a),
  doc: (...a: unknown[]) => fb.doc(...a),
}));

const { addDoc, setDoc, subjectOf, updateDoc } = await import('./firestoreWrite');
const { queuedWrites, resetQueuedWrites } = await import('./offlineWrite');

/** See offlineWrite.test.ts: node's `navigator` has no `onLine` to spy on. */
function goOffline(): void {
  vi.stubGlobal('navigator', { onLine: false });
}

/** What Firestore hands back offline: never resolves, never rejects. */
function never(): Promise<never> {
  return new Promise<never>(() => {});
}

function docRef(path: string) {
  return { path } as never;
}

beforeEach(() => {
  resetQueuedWrites();
  fb.setDoc.mockResolvedValue(undefined);
  fb.updateDoc.mockResolvedValue(undefined);
  fb.deleteDoc.mockResolvedValue(undefined);
  fb.addDoc.mockResolvedValue(docRef('kin_care_reports/server1'));
  fb.doc.mockReturnValue(docRef('kin_care_reports/new1'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetQueuedWrites();
});

describe('subjectOf', () => {
  it('names a collection the way the banner should read it', () => {
    expect(subjectOf('settings/payMethods')).toBe('your settings');
    expect(subjectOf('kin_care_reports/abc')).toBe('a KinTale');
    expect(subjectOf('kin_care_reports')).toBe('a KinTale');
  });

  /**
   * An unlisted collection falls back to the raw segment: worse copy than a
   * written phrase, never a lie, and visible enough to prompt adding a row.
   */
  it('falls back to the raw collection rather than inventing a phrase', () => {
    expect(subjectOf('some_new_collection/x')).toBe('some_new_collection');
  });
});

describe('the write seam', () => {
  it('behaves exactly as the bare call did when there is a connection', async () => {
    await setDoc(docRef('settings/payMethods'), { a: 1 } as never);
    expect(fb.setDoc).toHaveBeenCalledTimes(1);
    expect(queuedWrites()).toHaveLength(0);
  });

  /**
   * THE DEFECT. `await setDoc(...)` offline never settles, so
   * `screens/settings/sections.tsx`'s "Save payment options" button sat on
   * "Saving…" indefinitely. This returns, and reports the write as queued.
   */
  it('returns offline instead of waiting for an acknowledgement', async () => {
    goOffline();
    fb.setDoc.mockReturnValue(never());

    await setDoc(docRef('settings/payMethods'), { a: 1 } as never);

    expect(queuedWrites().map((q) => q.what)).toEqual(['your settings']);
  });

  it('returns offline for an update too', async () => {
    goOffline();
    fb.updateDoc.mockReturnValue(never());
    await updateDoc(docRef('kin/k1'), { name: 'Bo' } as never);
    expect(queuedWrites().map((q) => q.what)).toEqual(['a Kin']);
  });

  /**
   * Online, `addDoc` IS Firebase's, untouched — which is what lets the fourteen
   * modules' existing specs keep asserting on it, and what keeps this module
   * from making a claim about Firestore's internals on the path that runs every
   * day.
   */
  it('leaves the online add to Firebase, exactly as before', async () => {
    fb.doc.mockClear();
    const ref = await addDoc({ path: 'kin_care_reports' } as never, { body: 'x' } as never);
    expect(fb.addDoc).toHaveBeenCalledTimes(1);
    expect(fb.doc).not.toHaveBeenCalled();
    expect(ref.path).toBe('kin_care_reports/server1');
  });

  /**
   * Offline it is rebuilt on `doc()` + `setDoc()`, and this is why: Firebase's
   * own `addDoc` resolves the reference only once the server has the write, so
   * offline a caller doing `const ref = await addDoc(…); return ref.id` waits
   * forever for an id that was generated on the device before the call was made.
   */
  it('hands back a new document id offline, because the id was never remote', async () => {
    goOffline();
    fb.doc.mockReturnValue(docRef('kin_care_reports/local1'));
    fb.setDoc.mockReturnValue(never());

    const ref = await addDoc({ path: 'kin_care_reports' } as never, { body: 'x' } as never);

    expect(ref.path).toBe('kin_care_reports/local1');
    expect(queuedWrites().map((q) => q.what)).toEqual(['a KinTale']);
  });

  it('keeps a background breadcrumb off the banner', async () => {
    goOffline();
    fb.doc.mockReturnValue(docRef('kin_care_sessions/s1/breadcrumbs/b1'));
    fb.setDoc.mockReturnValue(never());

    await addDoc({ path: 'kin_care_sessions/s1/breadcrumbs' } as never, { lat: 1 } as never);

    // Queued by Firestore all the same; just not worth forty banner rows.
    expect(queuedWrites()).toHaveLength(0);
  });
});
