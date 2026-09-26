# Domain glossary

Terms used across tribetails. Architecture reviews, ADRs, and PRs use these
names exactly; if a concept is missing, add it here in the PR that names it.

- **Callable Contract**: the request/response shapes of the `onCall`
  functions in `mytribe/functions` (232 as of 2026-09-26). Four clients call
  them: the kinfolk portal web app, the kinfolk portal Android app, the admin
  web app, and the admin Android app. Authority is the server zod schema.
  Formerly hand-mirrored per client under the 2026-07-18 Option C ruling;
  superseded by ADR-0001 (generated contracts).

- **Contracts module**: the generated artifacts produced from server zod:
  TypeScript types for both web clients, Kotlin data classes and decoders for
  the admin Android app. Committed to the repo; CI regenerates and fails on any
  diff. See ADR-0001. Generation targets three of the four clients
  (`mytribe/functions/scripts/contracts/artifacts.ts`); the kinfolk portal
  Android app calls callables through `GitliveFunctionsClient` and is not
  generated into yet.

- **Invoice State Classifier**: the single server-side derivation of an
  invoice's `status` (8 states) and `editScope`. Precedence: an explicit
  stored status wins, then a negative balance means credit, then money places
  the row. Runs in `invoiceEditPolicy` and is persisted onto the invoice doc
  by every money-touching callable. Clients render the persisted state and
  never classify. See ADR-0002.

- **editScope**: which parts of an invoice remain editable given its state
  (from `invoiceEditPolicy`). Persisted field on the invoice doc; client
  affordances read it instead of recomputing policy.

- **AuthGate**: the Android seam every domain repo sits behind for the two
  questions it asks before touching Firebase: is an admin signed in (one
  user-facing failure sentence, one definition) and which sandbox is that admin
  in (the `testTribeId` claim, read and cached once per session for the whole
  app). Sources TestMode; does not apply it. `AuthGate.shared` is the
  process-wide instance every repo takes as a constructor default, because a
  second instance would mean a second claim cache.

- **ScopedFirestore**: the Android seam that applies TestMode scoping to every
  kinfolk-scoped read, count, and query. An injected wrapper exposing
  `scopedQuery` / `scopedRead` / `scopedCount` that holds the mode itself, so
  a call site cannot forget it. Replaces the hand-inlined `if (mode.active)`
  forks and absorbs the `scopedByKinfolk` extension.

- **TestMode**: the operator sandbox that scopes actions to test data.
  Decision logic lives in Android `domain.TestMode`. Under ADR-0002, sandbox
  invoice writes take the same callable path as production writes.

- **Domain repos**: the per-domain Android repositories replacing the
  `AuntieRepository` god-file (Invoice, KinCare, Comms, Location, Directory,
  Dashboard, Notification, Settings, Auth, Media). Each owns its own payload
  decoders; ViewModels inject the repo they use, not a facade.
