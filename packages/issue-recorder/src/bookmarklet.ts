import { startRecorder } from './index';
import type { RecordedApp } from './types';

/**
 * The entry point the BOOKMARKLET loads, and the only way to record a walk on
 * the live sites.
 *
 * WHY NOT JUST SHIP THE RECORDER. The apps mount it behind
 * `VITE_ISSUE_RECORDER`, which no deploy sets, so a production bundle contains
 * none of this. Putting it in the bundle instead would hand every kinfolk a
 * hundred kilobytes of session recorder to catch the operator's bugs.
 *
 * WHY A SAME-ORIGIN FILE AND NOT AN INLINE BOOKMARKLET. Both sites send a
 * strict CSP whose `script-src` is `'self'` plus a short list of Google hosts
 * (auntieos-admin/firebase.json, mytribe/firebase.json). A bookmarklet that
 * tried to inject a remote script, or to eval a bundle inline, is refused by
 * that policy. A `<script src="/__recorder.js">` is same-origin, so `'self'`
 * covers it, and the file ships as a plain static asset the app never
 * references and never loads on its own.
 *
 * THE BOOKMARK ITSELF, saved once per browser:
 *
 *   javascript:(function(){var s=document.createElement('script');s.src='/__recorder.js?'+Date.now();document.body.appendChild(s)})()
 *
 * The cache-buster matters: Hosting serves assets with a long max-age, and a
 * recorder pinned in the disk cache is one that never picks up a fix.
 */

declare global {
  interface Window {
    __ttIssueRecorder?: { stop: () => Promise<void> };
  }
}

/**
 * Which app is being walked.
 *
 * Hostname first, because it is the one signal that is right before React has
 * rendered anything. Falls back to the document title, which covers preview
 * channels (`auntieos-ttpc--pr365-....web.app`) whose hostname says nothing
 * about which app it serves. A wrong answer here only mislabels the walk, so
 * defaulting to 'portal' is a labelling bug rather than a broken recording.
 */
function detectApp(): RecordedApp {
  const host = window.location.hostname;
  if (host.includes('auntie')) return 'admin';
  if (host.includes('kinfolk') || host.includes('mytribe')) return 'portal';
  return document.title.includes('AuntieOS') ? 'admin' : 'portal';
}

/**
 * The signed-in identity, read off Firebase's own IndexedDB rather than out of
 * the app.
 *
 * The bookmarklet runs beside the app, not inside it, so there is no handle to
 * `auth.currentUser`. An email in the walk is worth a small amount of
 * screen-scraping: it says which household the operator was looking at when the
 * screen was wrong. Never the token, which sits in the same record.
 */
async function detectIdentity(): Promise<string | null> {
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('firebaseLocalStorageDb');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<Array<{ value?: { email?: string; uid?: string } }>>((resolve, reject) => {
      const request = db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const row of rows) {
      const email = row.value?.email ?? row.value?.uid;
      if (typeof email === 'string') return email;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Clicking the bookmark twice is the expected accident, not an edge case: there
 * is no visible difference between a page where it has been clicked and one
 * where it has not, until the dot appears. A second recorder would double every
 * rrweb event and split the marks across two walks.
 */
if (window.__ttIssueRecorder === undefined) {
  void detectIdentity().then((identity) => {
    window.__ttIssueRecorder = startRecorder({ app: detectApp(), identity });
  });
}
