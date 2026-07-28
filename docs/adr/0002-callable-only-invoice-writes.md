# ADR-0002: Invoice writes are callable-only; the server persists invoice state

Date: 2026-07-28
Status: Accepted.

## Context

`firestore.rules:242-247` allows `isAuntie()` and `testOwns*` client-side
writes on `/invoices`, and Android uses them (`AuntieRepository.kt:1809`
merge-write, `:1823` field update). Because two clients read invoices straight
from Firestore, invoice status and edit affordance are re-derived client-side:
one precedence rule written five times at three different state cardinalities
(server 8, Android 7, portal 5), with refusal copy already diverging between
server and admin.

## Decision

1. Every invoice write, production and TestMode sandbox alike, goes through a
   callable. Client-side create/update/delete on `/invoices` is revoked in
   rules once the last direct writer is migrated.
2. Money-touching callables persist the Invoice State Classifier's output
   (`status`, `editScope`) onto the invoice doc on every write.
3. Clients render the persisted state. The four client classifiers and the
   admin `invoiceEditPolicy` mirror are deleted; the portal's 5-state
   `resolveStatus` retires in favor of the stored field.

Funneling the sandbox too keeps TestMode a faithful rehearsal of the
production write path, and it is why no trigger backstop is needed: with the
rules revoked, no write path exists that skips state computation.

## Consequences

- Callables become TestMode-aware (scoped writes server-side).
- A migration precedes the rules change: inventory the client-direct write
  sites, add the missing callables, re-point Android and admin, then revoke.
- Invoice state bugs get locality: one module, one test suite, on the server.
- Pre-migration docs need a one-time backfill of `status`/`editScope`.
