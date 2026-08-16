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

Locally, on the portal:

```bash
npm --prefix mytribe/web run dev:record
```

A dot appears bottom right. `Ctrl+Shift+X` or click it, type three words or
nothing at all, press Enter. The counter on the dot goes up. At the end of the
walk, "End walk & export" drops one `.json.gz` in Downloads.

On the live sites, the same recorder arrives from a bookmarklet rather than from
the app: shipping it to every kinfolk to catch the operator's bugs is the wrong
trade, and the sites' CSP would refuse an injected script anyway.

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

## Never in a production build

The apps call `startRecorder` behind `import.meta.env.VITE_ISSUE_RECORDER`,
which nothing in the deploy path sets, through a dynamic import. A hosting build
folds the branch to a constant false and drops rrweb with it. Verified after
`npm run build`: `mytribe/web/dist/assets/*.js` contains zero occurrences of
`rrweb`, `issue-recorder`, `VITE_ISSUE_RECORDER` or `startRecorder`
(2026-08-16). Redo that grep if the gate is ever rewritten to read a runtime
value, because a runtime read cannot be folded.

## Size

A short walk on the sign-in screen: 116 KB of JSON, 18 KB gzipped. rrweb takes
a full DOM snapshot once a minute (`checkoutEveryNms`) so that seeking to a mark
forty minutes in does not mean replaying forty minutes of mutations.
