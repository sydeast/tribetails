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

## DESIGN AUTHORITY: ui-ideas, and three of its files are invisible in a clone

Portal mockups are `mytribe/ui-ideas/*.html`, 22 flat files, all stamped
`2026-05-31` in their names. There is no `mytribe/page-specs/`, and the admin's
`auntieos-admin/ui-ideas/` and `page-specs/` describe a different application.
Never answer a portal screen from the admin tree, or the reverse.

The portal has no rejected-designs directory, so unlike the admin tree,
everything here is live. Filenames are `mytribe-{screen}-{date}.html`, and
**anything after the date is a directive: the limitation or the need, written by
the operator, and part of the spec.** Read it as a requirement, not a label.

    -NoRefundtoOP-onlyAccountCredit    a refund never goes back to the original
                                       payment method; it becomes account credit
    -justNeedsExpansionForEachSection  the design is right, it needs per-section
      ForGrandularModification         expansion for granular modification
    -ADMINONLY                         this variant of the screen is admin-gated

Where a directive file and a plain file describe the same screen, the directive
file wins. The plain one is the earlier version without the ruling.

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
