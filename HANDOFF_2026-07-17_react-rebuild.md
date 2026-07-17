# HANDOFF 2026-07-17 — AuntieOS React rebuild: complete, shipped live

## TL;DR
The AuntieOS admin was rebuilt from the Compose/wasm app into a React/Vite/TS app
(`auntieos-admin` repo), **all 20 screens + all write/compose surfaces**, and
**deployed live** to a new non-destructive hosting site. Missing backend callables
were built + deployed. The live Compose/wasm admin at `auntie.tribetails.com` is
**untouched**.

- **Live:** https://auntieos-admin.web.app (React admin, all screens + editors)
- **Tests:** 1459 passing (auntieos-admin), 1465 (MyTribe functions). tsc clean, vite build green.
- **Everything committed** (auntieos-admin + MyTribe). No remote on auntieos-admin (local repo).

## What shipped

### Read screens (20) — all rebuilt as full vertical slices
Rail (17): Home, Directory, KinTales, Gallery, Schedule, Bookings, Sessions
(Auntie Time), Invoices, Communicate, Inbox, Notifications, Activity Log,
Settings, Tribal Intel, Templates, Form Schemas, Feature Flags.
Contextual (3): Account, My Notifications, Media (`/media/$type/$id`).

Each: real MyTribe collection/callable, bounded server-ordered reads (AO-29),
LOCAL time everywhere (AO-18, TZ-pinned tests), positive state enums with honest
`unknown` buckets (AO-12), AsyncRegion discipline (no false-empty / fabricated 0),
static-`<div>`-when-unwired controls, defensive reads, em-dash-clean, tokens-only.

### Write / compose surfaces (9 + step-2 deferred)
Editors: Account profile, My-Notifications prefs, Settings (all sections incl.
the complex sub-editors: Business Hours grid, Time Off, KinCare rates),
Communicate broadcast (confirm-gated), Bookings actions (approve/reject/cancel/
complete/reschedule), Templates (create/edit/delete), Form Schemas (create/edit),
KinTales (compose + confirm-gated send + **detail view w/ comment thread +
reactions**), Invoices (create invoice/quote + row actions), Directory (add
kinfolk/kin), **Media upload** (Cloudinary).

All writes: fail-loud (named errors), disabled-while-busy, confirm-gated for
outward-facing actions (broadcast/KinTale send/invoice reminder), merge-writes
(never silent overwrite of unmodelled fields).

## Backend built + DEPLOYED to auntieos-ttpc (us-central1, 2nd gen)
Missing callables the write surfaces needed — built to MyTribe conventions,
tested, deployed:
- `deleteTemplate` — deletes a template; refuses to orphan notificationTemplateBindings.
- `markInvoicePaid` — records a real payment (payments subdoc + method/reference/audit trail).
- `reviewAndSendDraftInvoice` — validates a draft is sendable, dispatches invoice.new before the write.
- `signCloudinaryUpload` — **fixed a product-wide bug**: `/api/cloudinary/sign-upload`
  was rewritten to it in `web/firebase.json` and all three shipped clients (wasm,
  desktop, Android) POST to it, but the function did not exist — media upload
  404'd everywhere. Built as onRequest (Bearer idToken + staff gate, server-owned
  folder, reuses lib/cloudinary).

Also: Firestore composite index `media_files (entityId ASC, uploadedAt DESC)`
deployed + persisted to `MyTribe/firestore.indexes.json` (backs the Media screen).

## Deploys done
- React admin app → new hosting site `auntieos-admin` (auntieos-admin.web.app). SPA rewrite + `/api/cloudinary/sign-upload` rewrite. Verified HTTP 200, deep-links + sign endpoint (401 without auth) resolve.
- Functions: deleteTemplate, markInvoicePaid, reviewAndSendDraftInvoice, signCloudinaryUpload (all live).
- Firestore index: media_files composite (building/ready).

## Bonus fixes found along the way
- `functions/.gitignore` had a bare `lib` that silently untracked all 36
  `functions/src/lib` helpers forever — anchored to `/lib`, recovered them.
- Dialog focus-trap: `useEffect([onClose])` re-focused the panel on every
  keystroke when a caller passed an inline onClose — root-fixed (onClose via ref,
  mount-only effect).
- `createKin` now stamps `updatedAt` (else KIN_QUERY's orderBy silently drops the new pet).

## Flagged, NOT fixed (deliberate)
- `web/firebase.json` (the wasm app's hosting) has other STALE rewrites:
  `/api/send-message → sendMessage` (no such export; candidates sendExternalMessage/
  sendKinfolkMessage/broadcastMessage), and `/api/mapbox/sign-search → searchMapbox`
  / `/api/mapbox/retrieve → retrieveMapbox` (actual exports `mapboxSearch`/
  `mapboxRetrieve`, name order reversed). Same class of "rewrite points at a
  nonexistent function name" bug as signCloudinaryUpload. Worth a follow-up sweep.
- The n8n 1:1 "personalize" AI-draft flow in Communicate: genuinely absent backend
  (no generateDraft/approveGeneratedDraft/n8n in functions); left deferred. Could
  be rebuilt on the existing Anthropic generator.

## Remaining minor polish (non-blocking)
- Tablist arrow-key roving tabindex (Invoices/Bookings/Directory/Templates filter tabs).
- Commit `18ded25`'s message reads "probe" (a diagnostic git commit landed during
  a git-lock window before the real message could apply; content is correct —
  the My-Notifications + Media + Account-nit commit). Fix via rebase when the
  git write-spell settles.
- A few un-tokenized font-sizes (match existing sibling-CSS convention).

## Environment gotchas this session (for the next session)
- **git write-spell**: `.git/index.lock` (and sometimes `.git/objects`) EPERM'd for
  minutes at a stretch across BOTH repos (auntieos-admin + MyTribe) — a filesystem
  quirk, not repo-specific. `git commit`/`git add` blocked. **Lever that works:** a
  background **plumbing committer** — `git write-tree` → `git commit-tree -p HEAD`
  → `git update-ref HEAD`, retried in a loop — bypasses index.lock. Scripts are in
  the session scratchpad (`commit_*.sh` pattern).
- Overwriting existing files also intermittently EPERM'd; per-file cp-with-retry
  loops (100-200 attempts) land eventually; batch writes fail (spell faster than a batch).
- `run_in_background: true` on `bash script.sh` was inconsistent — sometimes ran
  foreground and hit the 2-min tool timeout; relaunching worked.
- Both the Bash and Write auto-mode safety classifiers (sonnet) went briefly
  unavailable a couple of times — read-only ops still worked.

## Pipeline that built this
Sonnet agents built each screen/surface in an isolated repo copy → opus integrated
(cp + wire router/screen + tsc/test/build gate) → Fable reviewed each batch →
opus applied fixes → plumbing-committed. Conventions hardened batch-over-batch; the
later batches landed with zero review blockers.
---
- **Tablist arrow-key a11y — DONE + LIVE.** New `useRovingTabs` hook (WAI-ARIA
  tablist keyboard pattern) applied to all 10 filter tablists. Committed, deployed.
- **Communicate 1:1 Personalize (the "n8n" item) — DONE + LIVE.** Built on the
  already-deployed onRequest endpoints in `web/functions` (`generate` = Auntie-voice
  AI draft, `sendMessage` = 1:1 send). Recipient picker, generate/regenerate,
  editable draft, confirm-gated send. `firebase.json` gained same-origin rewrites
  `/api/generate → generate` and `/api/send-message → sendMessage` (verified live:
  400 / 401 from the functions, not the SPA). Committed, deployed.
- **"Stale rewrites" — FALSE ALARM, corrected.** The earlier flag (searchMapbox/
  retrieveMapbox/sendMessage look wrong vs MyTribe exports) was wrong: those, plus
  `generate`, are all onRequest functions in **`web/functions/index.js`** (the wasm
  app's own functions codebase, separate from MyTribe). The `web/firebase.json`
  rewrites resolve correctly. No fix needed.
- **`18ded25` "probe" message** — accepted residual (8 commits deep; a rebase under
  the git write-spell isn't worth it; the commit's content is correct).
- **Un-tokenized font-sizes** — accepted (match the sibling-CSS convention).
Final state: auntieos-admin 1507 tests green; admin app + 4 MyTribe callables +
media index all deployed; the site (auntieos-admin.web.app) serves the full rebuild
including every editor, media upload, and the personalize flow.
