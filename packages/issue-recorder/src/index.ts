import { record } from 'rrweb';
import { PassiveCapture, describeElement } from './capture';
import { mountOverlay } from './overlay';
import { exportWalk, saveWalk } from './store';
import { CAPTURE_FORMAT_VERSION, type CapturedWalk, type Mark, type RecordedApp } from './types';

export type { CapturedWalk, Mark, RecordedApp } from './types';
export { loadWalks, deleteWalk, exportWalk } from './store';

/**
 * Start recording a walk.
 *
 * WHAT THIS IS FOR. Issues in these two apps get found faster than they get
 * written down, because writing one down means explaining why a screen is wrong
 * to somebody who was not looking at it. So they stop getting written down, and
 * the same defect gets rediscovered a month later. This records the walk
 * instead: rrweb keeps a replayable copy of everything on screen, and each mark
 * pins a moment to the route, the console, the callables and the element. The
 * explanation stops being something the operator has to type.
 *
 * DEV AND BOOKMARKLET ONLY, NEVER A PRODUCTION BUILD. The apps call this behind
 * `import.meta.env.VITE_ISSUE_RECORDER`, which nothing in the deploy path sets,
 * so Vite folds the branch and this module out of the bundle exactly the way the
 * emulator gate in `firebase.ts` folds. The live sites get the same recorder
 * from a bookmarklet the operator triggers, which is the only way to walk
 * production without shipping the recorder to every kinfolk.
 */
export interface RecorderConfig {
  app: RecordedApp;
  /** Email or uid of whoever is signed in, when the app knows. Never a token. */
  identity?: string | null;
}

export interface Recorder {
  stop: () => Promise<void>;
  walk: () => CapturedWalk;
}

export function startRecorder(config: RecorderConfig): Recorder {
  const startedAt = Date.now();
  const events: unknown[] = [];
  const marks: Mark[] = [];

  const walk = (): CapturedWalk => ({
    meta: {
      id: `${config.app}-${new Date(startedAt).toISOString()}`,
      formatVersion: CAPTURE_FORMAT_VERSION,
      app: config.app,
      origin: window.location.origin,
      startedIso: new Date(startedAt).toISOString(),
      endedIso: null,
      userAgent: navigator.userAgent,
      identity: config.identity ?? null,
    },
    marks,
    events,
  });

  const passive = new PassiveCapture();
  passive.start();

  /**
   * `checkoutEveryNms` is what makes a long walk replayable from any mark.
   *
   * rrweb records one full DOM snapshot and then a stream of mutations, so
   * seeking to minute 40 means replaying forty minutes of mutations unless the
   * recording takes periodic full snapshots. One a minute keeps a seek cheap at
   * a size cost that gzip mostly absorbs.
   */
  const stopRecording = record({
    emit: (event) => {
      events.push(event);
    },
    checkoutEveryNms: 60_000,
    // Passwords are masked by rrweb by default; this masks every input's value.
    // A walk crosses real household data on the live sites, and a replay is a
    // file that gets attached to a GitHub issue.
    maskAllInputs: true,
    recordCanvas: false,
    collectFonts: false,
  });

  /** Persisted on a timer so a reload mid-walk costs at most this much. */
  const persist = window.setInterval(() => {
    void saveWalk(walk());
  }, 10_000);

  const unmount = mountOverlay({
    markCount: () => marks.length,
    onMark: (note, element) => {
      const drained = passive.drain();
      marks.push({
        id: `mark-${marks.length + 1}`,
        at: Date.now() - startedAt,
        isoTime: new Date().toISOString(),
        route: window.location.pathname + window.location.search,
        fullUrl: window.location.href,
        note,
        element: describeElement(element),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        console: drained.console,
        network: drained.network,
        replayIndex: events.length,
      });
      void saveWalk(walk());
    },
    onExport: async () => {
      const finished = walk();
      finished.meta.endedIso = new Date().toISOString();
      await saveWalk(finished);
      return exportWalk(finished);
    },
  });

  return {
    walk,
    stop: async () => {
      window.clearInterval(persist);
      stopRecording?.();
      passive.stop();
      unmount();
      await saveWalk(walk());
    },
  };
}
