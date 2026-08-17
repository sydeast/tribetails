import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

/**
 * Replays a recorded walk and photographs each marked moment.
 *
 * This is what stops an issue needing a description. The operator pressed
 * Ctrl+Shift+X because something on the screen was wrong; a picture of that
 * screen, with a ring around the thing they were pointing at, says more than a
 * paragraph they did not have time to type.
 *
 * IT REPLAYS, IT DOES NOT RE-VISIT. Nothing here loads the app or talks to a
 * backend. rrweb recorded the DOM, so the picture is what WAS on screen at that
 * moment, including the data that was in it. Re-visiting the route would
 * photograph a different day's data and quietly answer a different question.
 */

const require = createRequire(import.meta.url);

/**
 * rrweb's replayer, read off disk and inlined into the page.
 *
 * The UMD build rather than the ESM one because the replay page is a `data:`
 * document with no module resolution of its own, and inlined rather than served
 * because a `file://` script tag is the sort of thing that works on one machine
 * and not the next.
 */
function replayerSource() {
  // THE PATH IS DERIVED FROM `dist/style.css`, which is the only thing besides
  // the package root that rrweb's `exports` map exposes. Asking for
  // `rrweb/dist/rrweb.umd.min.cjs` directly throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // even though the file is right there, and the error names the subpath rather
  // than the export map, which reads like a missing file. Once the directory is
  // known the bundle is read with `fs`, which the export map does not police.
  const dist = dirname(require.resolve('rrweb/dist/style.css'));
  return {
    js: readFileSync(join(dist, 'rrweb.umd.min.cjs'), 'utf8'),
    css: readFileSync(join(dist, 'style.min.css'), 'utf8'),
  };
}

/**
 * Where in the recording a mark happened.
 *
 * `mark.replayIndex` is the count of events at the moment of the mark, so the
 * event just before it is the last thing that had happened. Its timestamp is
 * what the replayer seeks on. `mark.at` is NOT used: it is milliseconds since
 * the walk started by the browser's clock, while rrweb timestamps are absolute,
 * and the two only agree if nothing ever paused. Deriving the time from the
 * event stream cannot drift from the stream it is seeking in.
 */
function seekOffsetFor(walk, mark) {
  const events = walk.events;
  if (events.length === 0) return 0;
  const first = events[0]?.timestamp ?? 0;
  const index = Math.min(Math.max(mark.replayIndex - 1, 0), events.length - 1);
  const at = events[index]?.timestamp ?? first;
  return Math.max(at - first, 0);
}

/**
 * The page the replay happens in.
 *
 * `pointer-events: none` on the wrapper and a hidden replayer chrome, because a
 * screenshot of the app should not have a scrub bar across it. The ring is
 * drawn as a sibling overlay rather than by styling the element itself: the
 * element is inside rrweb's iframe, and reaching into it would mean mutating
 * the DOM being photographed.
 */
function replayPage({ js, css }, events) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}
  html, body { margin: 0; padding: 0; background: #fff; }
  .replayer-wrapper { position: fixed; inset: 0; }
  .rr-controller, .replayer-mouse, .replayer-mouse-tail { display: none !important; }
  #ring { position: fixed; border: 3px solid #e11d48; border-radius: 4px;
          box-shadow: 0 0 0 3px rgba(225,29,72,.25); pointer-events: none; display: none; z-index: 2147483647; }
</style></head>
<body><div id="ring"></div><script>${js}</script>
<script>
  window.__events = ${JSON.stringify(events)};
  window.__replayer = new rrweb.Replayer(window.__events, {
    root: document.body,
    speed: 1,
    skipInactive: false,
    showWarning: false,
    showDebug: false,
    mouseTail: false,
    UNSAFE_replayCanvas: false,
    // Nothing may be fetched while replaying. A snapshot that reached for a
    // font or an image would make the picture depend on the network, and on
    // whatever that URL serves today rather than on the day of the walk.
    blockClass: 'rr-block',
  });
  /**
   * Injected into the replayed page itself, after the seek.
   *
   * TWO THINGS, both learned from screenshots that came out wrong.
   *
   * ANIMATIONS LAND ON THEIR END STATE. A paused replay renders the DOM at one
   * instant with the clock stopped, so an element revealed by a CSS animation
   * sits at the animation's FIRST frame forever. The portal's sign-in card is
   * opacity 0 until its fade-in runs, and the first screenshots of it were a
   * blank page with the background gradient and nothing else. Zeroing the
   * duration and the delay, rather than setting animation to none, is what
   * makes a forwards fill snap the element to where it ends up. Setting none
   * would leave the opacity at the rule's own starting value, which is the
   * blank page again.
   *
   * THE RECORDER IS NOT PART OF THE SCREEN. blockSelector already keeps its
   * subtree out of the recording, but rrweb still replays a placeholder where
   * it stood, and a grey box in the corner of every issue screenshot is noise
   * that has to be explained to whoever reads it.
   *
   * NOTE FOR ANYONE EDITING THIS FILE: everything from here to the closing
   * backtick lives inside a template literal, so a backtick in a comment ends
   * the string and the module dies at parse time with a syntax error pointing
   * at prose. That happened once already.
   */
  window.__settle = () => {
    const doc = window.__replayer.iframe && window.__replayer.iframe.contentDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent =
      '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important}' +
      '[data-issue-recorder],.rr-block{display:none!important}';
    doc.head ? doc.head.appendChild(style) : doc.documentElement.appendChild(style);
  };

  window.__seek = (offset) => new Promise((resolve) => {
    window.__replayer.pause(offset);
    window.__settle();
    // One frame after the seek: rrweb applies the mutations synchronously but
    // the browser has not laid them out or painted yet, and a screenshot taken
    // in the same tick photographs the previous frame.
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60)));
  });
  window.__ring = (rect) => {
    const ring = document.getElementById('ring');
    if (!rect) { ring.style.display = 'none'; return; }
    ring.style.display = 'block';
    ring.style.left = rect.x + 'px';
    ring.style.top = rect.y + 'px';
    ring.style.width = rect.width + 'px';
    ring.style.height = rect.height + 'px';
  };
</script></body></html>`;
}

/**
 * One PNG per mark, written to `outDir/<markId>.png`.
 *
 * NEVER THROWS FOR ONE BAD MARK. A walk is twenty minutes of the operator's
 * attention; losing the other nineteen pictures because the fourth one failed
 * to seek would be the worst possible trade. Each failure is returned with its
 * reason, and `index.mjs` prints them beside the ones that worked.
 */
export async function renderMarks(walk, outDir) {
  mkdirSync(outDir, { recursive: true });
  const results = [];
  if (walk.marks.length === 0) return results;

  const source = replayerSource();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    // Belt and braces with the CSP-free data page above: a replay must not be
    // able to reach the network at all, so nothing outside the recording can
    // change what the picture shows.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) return route.continue();
      return route.abort();
    });

    for (const mark of walk.marks) {
      const pngPath = join(outDir, `${mark.id}.png`);
      const page = await context.newPage();
      try {
        // The viewport the operator actually had. A mark made on a phone must
        // not be photographed at desktop width, or the picture shows a layout
        // nobody saw.
        await page.setViewportSize({
          width: Math.max(Math.round(mark.viewport?.width ?? 1280), 320),
          height: Math.max(Math.round(mark.viewport?.height ?? 800), 400),
        });
        await page.setContent(replayPage(source, walk.events), { waitUntil: 'domcontentloaded' });
        await page.evaluate((offset) => window.__seek(offset), seekOffsetFor(walk, mark));
        await page.evaluate((rect) => window.__ring(rect), mark.element?.rect ?? null);
        await page.screenshot({ path: pngPath });
        results.push({ markId: mark.id, pngPath, ok: true, error: null });
      } catch (err) {
        results.push({
          markId: mark.id,
          pngPath,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return results;
}
