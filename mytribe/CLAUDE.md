# MyTribe (Kinfolk portal + shared Cloud Functions)

`mytribe/` is the Kinfolk portal, the client-facing side of Tribe Tails Pet Care.
Kinfolk sign in here to read their Kin's tales, invoices, and bookings. The live
site is kinfolk.tribetails.com, a React app (Vite + TanStack Router/Query) in
`web/`. `functions/` is the Cloud Functions backend, Firebase codebase `mytribe`,
and most of the callables the AuntieOS admin invokes live here, not next door.

The Compose `src/` tree is the older Android/desktop build, NOT the portal. When
you mean the portal, you mean `web/`.

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

## Vocabulary (the voice depends on it)

Kin is a pet. Kinfolk is a client or household. Tribe means the client, never the
household. Auntie is the caregiver. Review enforces these; they are not
stylistic preferences.

No em dashes in user-facing copy.
