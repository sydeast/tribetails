# Notification Template Ingest — Phase 1

**Date:** 2026-05-16
**Status:** Approved (pending spec review)
**Phase:** 1 of 2 (Phase 2 = trigger parity audit, scoped separately)

## Goal

Load 34 catalog-keyed notification templates × 3 channels (email/sms/push) into Firestore so the MyTribe dispatcher senders can render Handlebars output for every catalog row that has a content template authored on disk.

## Context

- MyTribe dispatcher (`functions/src/notifications/dispatcher.ts`) fans notifications across enabled channels per `catalog.ts` definition (35 keys).
- Channel senders read template docs from Firestore:
  - `emailTemplates/{key}` → `{subject, body, html?, updatedAt}`
  - `smsTemplates/{key}` → `{text, updatedAt}`
  - `pushTemplates/{key}` → `{title, body, updatedAt}`
- Existing `MyTribe/scripts/seedEmailTemplates.ts` seeds 9 ops templates (errors/invites/recovery/share) from `MyTribe/seeds/emailTemplates/*.json`. None of the 34 catalog keys are seeded yet.
- 34 dirs of authored content live at `AuntieOS/Tribe_Tails_Pet_Care_Complete_Templates/{key_underscored}/`, each with 4 files: `email.html`, `email.txt`, `push.txt`, `sms.txt`.
- Catalog dir-name diff: 34/34 disk dirs match a catalog key. 1 catalog key has no disk template: `auth.password.reset` (handled by Firebase Auth built-in console template; no dispatcher enqueue site exists).
- Per `feedback_fail_loud_policy`: malformed templates abort batch; never silent-default.

## Architecture

```
MyTribe/seeds/notificationTemplates/{catalog.key.dotted}/
  ├─ email.html        → emailTemplates/{key}.html
  ├─ email.txt         → split: "Subject: <line>\n\n<body>" → .subject + .body
  ├─ sms.txt           → smsTemplates/{key}.text
  └─ push.txt          → split on first ".": title (no period) + body (trimmed) → pushTemplates/{key}

MyTribe/scripts/seedNotificationTemplates.ts
  reads each dir → 3 Firestore set() ops → idempotent (disk = truth)
```

## Components

### 1. Move source

Move (not copy) `AuntieOS/Tribe_Tails_Pet_Care_Complete_Templates/{key_underscored}/` → `MyTribe/seeds/notificationTemplates/{key.dotted}/`. Dotted names match catalog keys exactly. Delete the AuntieOS folder once move is verified in the MyTribe repo.

Reason: dispatcher repo owns templates → single source of truth → future operator edits land in the same repo as the code that reads them.

### 2. Seed script

`MyTribe/scripts/seedNotificationTemplates.ts`:

CLI:
- `--dry-run` — parse + print planned writes, no Firestore mutation
- `--key <dotted.key>` — process one key only (test path)
- (no flag) — full batch

Behavior:
- Loads catalog (import from `functions/src/notifications/catalog.ts`) to get authoritative key list
- For each dir in `seeds/notificationTemplates/`:
  - Validate dir name ∈ catalog keys (throw on unknown)
  - Validate all 4 files present (throw on missing)
  - Run parsers (see helpers)
  - Write 3 docs with `updatedAt: serverTimestamp()`
  - `.set()` semantics — full doc overwrite (disk = truth)
- For each catalog key without a dir: log warn, skip (non-fatal — `auth.password.reset` falls here)

### 3. Pure parser helpers (extracted for testability)

```ts
parseEmailTxt(raw: string): { subject: string; body: string }
  // First line MUST start with literal "Subject: " (case-sensitive, single space)
  // Subject value = remainder of first line, trimmed
  // Body = everything after first blank line (single \n\n separator), preserved verbatim
  // Throws if first line doesn't start with "Subject: " or if body is empty

parsePushTxt(raw: string): { title: string; body: string }
  // Locate the index of the first literal "." (period char, U+002E) in raw.trim()
  // title = substring before that index, trimmed (no trailing period)
  // body = substring after that index, trimmed (keeps internal periods)
  // Throws if no period in input, or if body (after trim) is empty
  // Note: variables like {{kinName}} cannot contain a period, so split is deterministic;
  //   if future templates introduce period-bearing rendered values, this heuristic must be revisited
```

**Validated against existing 34 push.txt files**: every file matches the pattern `{title sentence}. Tap to see details.` — split-on-first-period produces clean `{title, body}` pairs with non-empty bodies for all 34.

### 4. Tests (vitest)

`MyTribe/scripts/__tests__/seedNotificationTemplates.test.ts`:
- `parseEmailTxt`: valid input, missing `Subject:` prefix throws, multi-line body preserved
- `parsePushTxt`: valid single-period input, no period throws, period with no body throws, period in middle of body splits at first occurrence
- Dir validation: unknown key throws; missing file throws
- (No Firestore integration test — covered by manual dry-run before prod execution)

## Data flow

1. Operator runs `npx ts-node scripts/seedNotificationTemplates.ts --dry-run` locally
2. Reviews printed planned writes (102 docs: 34 keys × 3 channels)
3. Re-runs without `--dry-run` against prod (with `GOOGLE_APPLICATION_CREDENTIALS` set)
4. Dispatcher already wired — next notification enqueue uses fresh template

## Error handling

Per `feedback_fail_loud_policy`:
- Missing dir for catalog key → log warn, skip (catalog may have unimplemented keys; not fatal). Surfaced in final summary as "skipped catalog keys: [...]".
- Missing file in dir → throw before Firestore write (fail before batch starts)
- Malformed file content (no Subject line, no period in push) → throw with file path + reason
- Firestore write failure → bubble up, abort remaining batch (no silent partial seed)
- Final summary always printed: `seeded=N skipped=M errors=K` — operator sees what landed

## Out of scope (deferred)

- Operator UI for template editing (Firestore Console suffices for now)
- `notificationTemplateBindings` overrides (separate operator feature)
- Trigger wiring parity audit + fixes (Phase 2)
- `auth.password.reset` template authoring (Firebase Auth built-in; catalog row should be marked external in Phase 2)
- Migration of the 9 existing `seedEmailTemplates` ops templates into the new layout (different schema, separate concern)

## Phase 2 follow-ups to capture

- Audit catalog rows vs MyTribe enqueue sites — which keys never fire from MyTribe code paths but exist for AuntieOS-side firing?
- Mark `auth.password.reset` catalog row as external (Firebase Auth handled) or remove
- Decide template binding UX (Firestore Console vs admin web)
