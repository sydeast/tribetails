# Kinfolk see a real map

**Date:** 2026-08-21  
**Status:** implemented. All three PRs below shipped: #531 (token plumbing +
AuntieOS Android), #550 (kinfolk web), #570 (portal Android).  
**Issue:** #520  
**Operator ruling:** kinfolk must see an actual map for the KinCare route, not a line drawing.

## The problem

`RouteMap` renders a bare polyline on a blank background. `RouteMap.tsx` draws an SVG
`<path>`; `RouteMap.kt` draws a Compose `Canvas` path. Neither loads a basemap, so a
kinfolk watching a KinCare visit or reading a KinTale sees a route shape floating in
empty space, with no street, landmark or context telling them where their Kin actually
went.

Both files say so in their own comments ("no map SDK, no token"), and the absence is
structural rather than a stale note: there is no `mapbox-gl` or `maplibre` dependency in
any `package.json` in the repository, and no tile or static-image URL anywhere under
`mytribe/` or `packages/`.

### The wider finding: no surface renders a map today

This was expected to be "give kinfolk what AuntieOS already has". It is not.

`auntieos-admin/android` has the Mapbox Maps SDK wired (`mapbox-maps-android 11.10.0`)
and two screens that build real `MapView`s, `LiveTrackingScreen.kt` and
`RouteViewerScreen.kt`. Nothing gives those views a runtime access token:

| Where a runtime token could live | Present |
|---|---|
| `MapboxOptions.accessToken` / `setAccessToken` | no |
| `mapbox_access_token` string resource | no (`res/values` holds only `themes.xml`) |
| `manifestPlaceholders` / `resValue` / `buildConfigField` | no (only `SENTRY_DSN`) |
| `AndroidManifest.xml` | no |

`MAPBOX_DOWNLOADS_TOKEN` is a maven repository credential in `settings.gradle.kts`
(`credentials.password`) that downloads the SDK at build time. It cannot authenticate a
`MapView`.

### The map was never wired, and the July security fix is not why

`MapboxConfig.kt` records that a live Mapbox key compiled into the APK was removed on
2026-07-25, which invites the conclusion that the removal broke the map. It did not, and
the distinction matters because it changes what this spec is doing.

Commit `ae18968` is narrow and correct. Before it, `MapboxConfig.ACCESS_TOKEN` had exactly
one reader:

```
AddressAutocompleteField.kt:41
    geocodingApi.suggest(query = value, token = MapboxConfig.ACCESS_TOKEN)
```

A client calling the Mapbox geocoding API directly with a compiled-in key, where a server
could call it instead. The fix deleted the constant, deleted `MapboxGeocodingApi.kt` and
the Retrofit builder, and moved address lookup onto the `mapboxSearch` / `mapboxRetrieve`
callables that hold the token as a Functions secret. It recorded that deleting the constant
does not un-publish the key. Its checks: `compileDebugKotlin` clean, `testDebugUnitTest`
1530 passed.

The `MapView` screens never read that constant. `MapboxOptions`, `setAccessToken` and a
`mapbox_access_token` string resource have never existed anywhere in this repository's
Android history; the only `mapbox_access_token` occurrences at the initial commit are
`defineSecret('MAPBOX_ACCESS_TOKEN')` in server-side `web/functions/index.js`.

So the map has never been authenticated. The SDK is wired and the screens are written, and
the credential was never provisioned. It is unfinished rather than regressed, and the July
fix neither caused that nor touched it.

**So the operator's live-tracking and route-viewer maps are almost certainly blank in
production, and always have been.** This is inference from source, not observed
telemetry; a Sentry query for map-load errors timed out and is worth re-running. The
screens subscribe to `subscribeMapLoadingError` under a stated fail-loud policy, so if the
inference is right, those errors are already being logged.

The credential problem therefore has to be solved once, for three surfaces, not one.

## Operator actions, in order

These gate implementation and only the operator can do them.

1. **Revoke the leaked token first.** `MapboxConfig.kt` says it "should still be ROTATED
   in the Mapbox console: it was in git history, so deleting the constant does not
   un-publish it." Nothing in the repository indicates that rotation happened. Until it
   does, assume the old key is live and billable. Revoke before provisioning anything new.
2. **Create TWO public tokens**, both `pk.*` with exactly the scopes `styles:tiles`,
   `styles:read` and `fonts:read` (not `datasets:read`, which nothing uses):
   - `web-maps-public`, **URL-restricted** to `kinfolk.tribetails.com` and
     `auntie.tribetails.com`.
   - `mobile-maps-public`, **with no URL restriction at all**.
3. **Distribute them.** The mobile token to `~/.gradle/gradle.properties` as
   `MAPBOX_PUBLIC_TOKEN` and as the `MAPBOX_PUBLIC_TOKEN` repository secret; the web
   token as the `VITE_MAPBOX_PUBLIC_TOKEN` repository secret and in the web build
   environment.
4. **Add `MAPBOX_DOWNLOADS_TOKEN` to each self-hosted runner's `.env`.** It exists as a
   repository secret but not on the runners, and the portal Android build will need it
   once the SDK is a dependency.

## The security tradeoff, stated plainly

This ships an extractable key in two APKs. That resembles the 2026-07-25 incident and is
worth being explicit about, but it is not a reversal of it, and an earlier draft of this
spec was wrong to call it one.

July's decision was: do not ship a key so a client can call an API the server can call for
it. That stands here untouched. Address verification stays on the `mapboxSearch` /
`mapboxRetrieve` callables, and no client regains a geocoding key.

This is a different question, which July never asked. The Maps SDK fetches vector tiles on
the device, so a token has to be on the device; there is no server-proxy alternative for a
basemap the way there is for a geocoding request. The choice is a scoped client token or no
map at all.

What makes it defensible is not concealment, which is impossible on Android, but blast
radius: a read-only token cannot write to the account, and a rotation schedule bounds what
an extracted one is worth. This is Mapbox's own intended posture for public tokens. Web
gets URL restriction on top, on its own token; Android cannot be referer-locked at all,
so scope and rotation are the whole of the mobile token's protection.

The rejected alternative was server-minted temporary tokens, mirroring
`mintVoiceAccessToken`. It was rejected because Mapbox temporary tokens cap at one hour
while KinCare visits run longer, which forces mid-session rotation logic into both SDKs,
and because it makes the map unopenable whenever the callable is unreachable, cutting
against the Unreachable-tolerance work in #494 and #502.

## Architecture

Two tokens, three surfaces, injected by each platform's existing config mechanism. No new
callable and no backend change: `gpsRoute` (`{lat, lng, t?}`) already ships on
`getMyKinTales` and `getMyVisits`, and live breadcrumbs already stream to the portal.
This is a rendering change with a credential behind it.

### Why two tokens and not one

An earlier draft of this spec said one token, URL-restricted, would serve all three
surfaces. It would not, and the failure would have been a puzzling 403 rather than a
clear error.

Mapbox URL restrictions are validated from a browser `Referer`. Mapbox's own
documentation states they do not support "requests from mobile applications built with
the Mapbox Maps or Navigation SDKs", and such a request is answered `403 Forbidden`. A
single restricted token would therefore have left both Android maps exactly as blank as
they are now, with a new cause.

So the web token carries the restriction and the mobile token cannot. That split is also
worth having on its own terms: the extractable one is the mobile token, and it can be
revoked and reissued without touching the web maps.

| Surface | Token | Injection | Mirrors |
|---|---|---|---|
| `mytribe/web` | web (URL-restricted) | `VITE_MAPBOX_PUBLIC_TOKEN` | existing `VITE_SENTRY_DSN` |
| portal Android (`com.kinfolk.portal`) | mobile (unrestricted) | gradle property -> `buildConfigField` -> `MapboxOptions.accessToken` at startup | `SENTRY_DSN` in `auntieos-admin/android/app/build.gradle.kts` |
| AuntieOS Android (`com.tribetails.auntieos`) | mobile (unrestricted) | same | same |

### The fallback survives, deliberately

The SVG and Canvas polyline renderers are NOT deleted. They become the fallback for three
real cases: no token configured, tile loading failed, and the Compose `js`/`jvm` targets
where no Mapbox SDK exists.

This is the difference between a missing token degrading to today's line drawing and a
missing token producing a blank box, which is exactly the failure this spec exists to fix.
`packages/geo` (`projectRoute`, `totalDistanceMeters`, `durationFromPoints`) stays exactly
as it is and keeps its tests.

## Components

### `mytribe/web`: `RouteMap.tsx`

Renders a real map when a token is configured, the existing SVG when not.

- `mapbox-gl` loaded through a dynamic `import()`, never a static one. The portal's bundle
  size has been fought over before (290MB to 193MB of imports on the functions side, and
  the admin's 49% code-split reduction); a ~800KB map library must not land in the initial
  chunk for screens that may never show a route.
- Route drawn as a GeoJSON `LineString` layer, start and end markers preserved, camera
  `fitBounds` to the route with padding.
- Distance / duration / ping statistics below the map are unchanged.
- Call sites unchanged: `Schedule.tsx:133` (live), `Schedule.tsx:228` (per-visit),
  `KinTales.tsx:263` (recorded). The component's props stay the same.

### Compose portal: `RouteMap.kt`

Becomes `expect`/`actual` in `commonMain`:

- `androidMain`: Mapbox `MapView`, same approach as `RouteViewerScreen.kt` already uses.
- `jsMain` / `jvmMain`: the current Canvas renderer, unchanged.

Call sites unchanged: `ScheduleScreen.kt:172`, `ScheduleScreen.kt:532`,
`KinTalesScreen.kt:332`.

### AuntieOS Android

No renderer change. `LiveTrackingScreen.kt` and `RouteViewerScreen.kt` are already correct
and already wired to the SDK. They receive `MapboxOptions.accessToken`, set once in
`AuntieOSApp.onCreate` (`AuntieOSApp.kt:118`) before any map is constructed, and start
working.

## Build and CI

`mytribe/settings.gradle.kts` has `google()`, `mavenCentral()` and the Compose dev
repository, and no Mapbox repository at all, so the portal cannot resolve the SDK today.
It needs the same block `auntieos-admin/android/settings.gradle.kts` already carries: the
`api.mapbox.com/downloads/v2/releases/maven` repository, username `mapbox`, password from
`MAPBOX_DOWNLOADS_TOKEN`, failing loudly when absent.

**The CI consequence is the part most likely to be missed.** The `Portal shared (jvm +
android unit + js)` job runs `testDebugUnitTest` with no Mapbox gate, because the portal
has never needed the SDK. Once `androidMain` depends on it, that job cannot resolve
dependencies without the token and will fail rather than skip. It needs the same gate the
`android` job already has: check for `MAPBOX_DOWNLOADS_TOKEN`, run the android step only
when present, and emit a `::warning` naming what did not run when absent. A green skip that
silently drops coverage is the failure mode that gate was written to avoid.

`MAPBOX_DOWNLOADS_TOKEN` exists as a repository secret (set 2026-07-21) but is absent from
all three self-hosted runners' `.env` files, so it must be added there too.

## Error handling

| Condition | Behaviour |
|---|---|
| No token configured | Fallback polyline renders. No error shown to a kinfolk. |
| Tile / style load fails | Fallback polyline renders. Error logged, not surfaced. |
| Empty `gpsRoute` | Nothing renders, as today (`route.length === 0` returns null). |
| Compose `js` / `jvm` target | Canvas renderer, permanently. |

A kinfolk never sees a map error. They see the route drawn the old way, which is strictly
what they get today, so every failure path is a degradation rather than a regression.

## Testing

- **Web:** `RouteMap` renders the fallback when no token is configured, and takes the map
  path when one is, with `mapbox-gl` mocked. No test may require a network tile fetch.
- **Compose:** `jvm` keeps the existing Canvas tests untouched, which is what
  `:jvmTest` already covers. The `androidMain` actual is thin enough that its value is in
  compiling, which `testDebugUnitTest` provides.
- **AuntieOS Android:** a test that `MapboxOptions.accessToken` is set before any map is
  constructed. The bug being fixed is precisely that it was not.
- **No backend tests:** no callable changes.

## Sequencing

Three PRs, one concern each. Token infrastructure lands first because two surfaces depend
on it, and it is validated on the surface that already has the SDK wired.

| PR | Scope | Why this order | Shipped |
|---|---|---|---|
| 1 | Token plumbing + AuntieOS Android | Fixes a screen blank in production today. Proves the credential model on the one surface already wired, before anything else depends on it. | #531 |
| 2 | Kinfolk web (`mapbox-gl`, lazy) | The ruling that started this. Independent of PR 3. | #550 |
| 3 | Portal Android (maven repo, SDK, `actual`, CI gate) | Largest build-surface change. Benefits from the model being proven twice. | #570 |

All three merged.

## Out of scope

- **Mapbox address-verification duplication.** `mapboxSearch`/`mapboxRetrieve` (mytribe,
  callable) and `searchMapbox`/`retrieveMapbox` (auntieos-admin, https) hit the same two
  Search Box endpoints from two codebases: four deployed functions doing one job. Real, and
  a separate issue.
- **Interactive live-tracking refinements** (follow-the-Auntie camera, clustering,
  smoothing). This spec puts a real basemap under the existing route; it does not redesign
  the live experience.
- **`packages/geo`.** Unchanged, and still needed for the fallback.

## Open question

The Sentry query for map-load errors timed out. Re-running it against the AuntieOS Android
project would convert "the operator's map is almost certainly blank" from inference into
observed fact. It does not block PR 1, whose fix is correct either way, but it would
confirm the diagnosis before the fix ships.
