# Issue recorder

Walk the app. Hit `Ctrl+Shift+X` when something is wrong. Keep walking.

## Why it exists

Issues in these two apps get found faster than they get written down, because
writing one down means explaining to somebody who was not looking at the screen
why the screen is wrong. So they stop getting written down, the same defect gets
rediscovered a month later, and the test suite stays green over both.

This records the walk instead. rrweb keeps a replayable copy of everything that
was on screen, and each mark pins a moment to the route, the console, the
callables and their responses, and the element under the cursor. The explanation
stops being something anyone has to type.

## Using it

Locally, on either app:

```bash
npm --prefix mytribe/web run dev:record        # portal
npm --prefix auntieos-admin run dev:record     # admin
```

A dot appears bottom right. `Ctrl+Shift+X` or click it, type three words or
nothing at all, press Enter. The counter on the dot goes up. At the end of the
walk, "End walk & export" drops one `.json.gz` in Downloads.

Note that `dev:record` does NOT set the emulator variable, so a local walk talks
to production Firebase. That is deliberate: the defects worth recording are the
ones that happen against real data.

## On the live sites

Save this as a bookmark, once per browser. The name is up to you; the URL is
the whole tool.

```
javascript:(function(){var s=document.createElement('script');s.src='/__recorder.js?'+Date.now();document.body.appendChild(s)})()
```

Open auntie.tribetails.com or kinfolk.tribetails.com, click the bookmark, and
the same dot appears. It works on preview channels too.

Three things make that one line enough:

- `/__recorder.js` is served by the site itself. Both sites send a CSP whose
  `script-src` is `'self'` plus a few Google hosts, so a bookmarklet that
  fetched a script from anywhere else, or tried to eval a bundle inline, is
  refused. Each app's `prebuild` copies the bundle into its `public/`, so it
  ships as a static asset the app never references and never loads on its own.
  It is excluded from the portal's service-worker precache, so no kinfolk
  downloads it.
- The cache-buster is not decoration. Hosting serves assets with a long
  max-age, and a recorder pinned in the disk cache is one that never picks up
  a fix.
- Clicking the bookmark twice does nothing the second time. There is no visible
  difference between a page where it has been clicked and one where it has not
  until the dot appears, so a double click is the expected accident, and a
  second recorder would double every rrweb event.

The bookmarklet also reads the signed-in email out of Firebase's own IndexedDB,
since it runs beside the app rather than inside it and has no handle on
`auth.currentUser`. The email says which household was on screen. Never the
token, which sits in the same record.

## What a mark actually carries

| | |
|---|---|
| route | pathname and query at the moment of the mark |
| element | CSS selector, tag, visible text, viewport box |
| console | `error` and `warn` since the previous mark, not since page load |
| network | every request since the previous mark, with the callable's name and a truncated body both ways |
| replayIndex | where to seek in the rrweb stream |

Console and network are drained per mark on purpose. A mark that carried every
error of the whole walk would bury the one that belongs to this screen.

## What it never records

Input values are masked (`maskAllInputs`), because a walk on the live sites
crosses real household data and the export ends up attached to a GitHub issue.
Bodies are truncated at 4 KB for the same reason. `identity` is an email or uid
when the app supplies one, never a token.

## Never in an app bundle

The apps call `startRecorder` behind `import.meta.env.VITE_ISSUE_RECORDER`,
which nothing in the deploy path sets, through a dynamic import. A hosting build
folds the branch to a constant false and drops rrweb with it. Verified after
`npm run build` on BOTH apps: `dist/assets/*.js` contains zero occurrences of
`rrweb`, `issue-recorder`, `VITE_ISSUE_RECORDER` or `startRecorder`
(2026-08-16). Redo that grep if the gate is ever rewritten to read a runtime
value, because a runtime read cannot be folded.

`dist/__recorder.js` IS present, and that is the separate, deliberate thing: a
standalone 190 KB file the app never loads, sitting there so the bookmarklet can
fetch it from the site's own origin. Visiting the site does not download it. The
portal's service worker is told to skip it (`globIgnores` in
`mytribe/web/vite.config.ts`); without that line the precache went from 69
entries and 1827 KiB to 70 and 2024 KiB, which would have pushed the recorder
through every kinfolk's service worker.

## Size

A short walk on the sign-in screen: 116 KB of JSON, 18 KB gzipped. rrweb takes
a full DOM snapshot once a minute (`checkoutEveryNms`) so that seeking to a mark
forty minutes in does not mean replaying forty minutes of mutations.
