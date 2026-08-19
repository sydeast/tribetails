# MyTribe (Kinfolk portal + shared Cloud Functions)

`mytribe/` is the Kinfolk portal, the client-facing side of Tribe Tails Pet Care.
Kinfolk sign in here to read their Kin's tales, invoices, and bookings. The live
site is kinfolk.tribetails.com, a React app (Vite + TanStack Router/Query) in
`web/`. `functions/` is the Cloud Functions backend, Firebase codebase `mytribe`,
and most of the callables the AuntieOS admin invokes live here, not next door.

## The portal has two shipping clients, `web/` and `src/`

`web/` is the React site. `src/` is the Compose Multiplatform tree, and its
**android target is the portal's Android app**: `com.kinfolk.portal`, registered
and active in `auntieos-ttpc`, distributed to testers through Firebase App
Distribution by `scripts/release.sh` in the same run that ships the web. Both
surfaces ship. Neither is dead, and a change to a portal contract has to land in
both the way the admin's does.

Say which one you mean. Bare "the portal" means `web/`; the Android client is
"the portal Android app". The `jvm`/desktop target in `src/` is the one that is
**not** a delivery surface. It builds, and the owner ruling holds it back from
release; do not add features to it.

This paragraph used to read "the Compose `src/` tree is the older
Android/desktop build, NOT the portal", which is how the release script came to
build one of the two Android apps and nobody noticed for a week: `src/` was read
as dead, so its versionCode sat at 2 while the web shipped every release.

## Testing `src/`: `:jvmTest` is the task that counts

Two Gradle test tasks run from `mytribe/`, and they are not interchangeable:

```
./gradlew :jvmTest            # commonTest + composeUiTest. The gate.
./gradlew testDebugUnitTest   # commonTest, compiled for Android. Narrower.
```

`:jvmTest` is the one a change to `src/` has to pass. It is the only place the
Compose UI tests execute, because they need a live Compose host and the JVM
target is the only test target that has one.

`testDebugUnitTest` runs the shared tests compiled against Android. The Compose
UI tests are held out of it on purpose: the Android unit-test variant links
against the stub `android.jar`, where `android.os.Build.FINGERPRINT` is null, and
`runComposeUiTest` throws on that before reaching an assertion. Robolectric does
not rescue it either. The activity it would have to launch is declared in a
test-only manifest that never reaches the resource APK Robolectric reads, and
issue #473 has the whole trail. Both tasks run in CI now.

So: **a Compose UI test belongs in `src/composeUiTest`, not `src/commonTest`.**
`ComposeUiTestSourceSetTest` fails if one lands in the wrong place, which is how
143 failures stopped being the normal state of that task.

## A prefix in the monorepo, not a separate repo

`mytribe/` is a sibling prefix of `auntieos-admin/` in the one `tribetails`
repository, merged 2026-07-21. A change here can see the admin tree and vice
versa. Anything that used to say "the other repo" now means the sibling prefix.

## firestore.rules is the source of truth

`mytribe/firestore.rules` governs the shared `auntieos-ttpc` Firestore project.
`auntieos-admin/` carries a MIRROR of it; a test there asserts the two are
byte-identical, and the root pre-commit hook checks it too. Edit the rules HERE,
then re-mirror. Rules deploy ONLY from mytribe, never from the admin tree.

## Deploying functions: the codebase prefix is required

These functions live in codebase `mytribe`, so every deploy has to name it:

```
firebase deploy --only functions:mytribe            # the whole codebase
firebase deploy --only functions:mytribe:<name>     # one function
```

A bare `firebase deploy --only functions:<name>` returns "No function matches",
because Firebase looks in the default codebase and finds nothing there.

## DESIGN AUTHORITY: ui-ideas, and three of its files are invisible in a clone

Portal mockups are `mytribe/ui-ideas/*.html`, 22 flat files, all stamped
`2026-05-31` in their names. There has never been a `mytribe/page-specs/`, and
the admin's `auntieos-admin/ui-ideas/` describes a different application. (The
admin's own `page-specs/` was deleted by the operator on 2026-08-16, so neither
tree has one now; see `auntieos-admin/CLAUDE.md`.)
Never answer a portal screen from the admin tree, or the reverse.

A filename carrying a directive means that directive is part of the spec. The
portal has no rejected-designs directory, so unlike the admin tree, everything
here is live.

**19 of the 22 are tracked. The 3 that are not are exactly the 3 carrying
directives:**

```
mytribe-invoice-detail-2026-05-31-NoRefundtoOP-onlyAccountCredit.html
mytribe-notifications-2026-05-31-justNeedsExpansionForEachSectionForGrandularModification.html
mytribe-tribe-picker-2026-05-31-ADMINONLY.html
```

The root `.gitignore` line is a bare `ui-ideas/`, which matches at any depth. The
other 19 were already tracked when `mytribe/` was added as a subtree (`6737378`,
2026-07-20), and git keeps tracking a file that an ignore rule arrives after.
These three were not, so the rule holds them out.

In a git worktree or a fresh clone the directory therefore reads as complete at
19 files and is not. Open it by absolute path from the main checkout instead.

This matters because the surviving file is the one without the ruling. Plain
`mytribe-invoice-detail-2026-05-31.html` sits right where the NoRefund version is
missing, so an agent that cannot see the directive builds a refund to the
operator, and the diff looks like it followed the mockup.

## Vocabulary (the voice depends on it)

Kin is a pet. Kinfolk is a client or household. Tribe means the client, never the
household. Auntie is the caregiver. Review enforces these; they are not
stylistic preferences.

No em dashes in user-facing copy.
