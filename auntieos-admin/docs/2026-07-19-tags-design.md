# Tags — design spec (2026-07-19)

Status: approved design, pre-implementation. Built React-first on `auntieos-admin`.

## Summary

A tagging system for **kinfolk** (households) and **kin** (pets). Tags are a **hybrid**
vocabulary: a managed suggestion list lives in Business settings, but operators can
also type free-form tags on a profile. Each vocabulary tag is a rich object
(`name` + `color` + `icon`); icon is an **emoji** in v1, with the model shaped so a
custom icon library can slot in later. Household and pet vocabularies are **separate**.

## Goals

- Define + manage two tag vocabularies (household, pet) in Business settings.
- Assign tags on the kinfolk profile and the kin/pet profile (hybrid: pick-from-vocab or free-form).
- Render rich chips (color + emoji), resolving name → color/icon from the vocab.
- Light up the existing consumers for free: broadcast audience targeting and the KinTale `KINFOLK_TAG` condition already read `kinfolk.tags` by name.

## Non-goals (v1, explicit)

- Pet-tag conditions in the KinTale engine (household-tag conditions already exist; pet is later).
- Custom icon library / uploaded icons (emoji only; model is forward-compatible).
- Bulk tagging, tag analytics, tag-based automations beyond the existing broadcast/condition consumers.
- Renaming a vocabulary tag in place (see Data model note); v1 is add / edit-color-and-icon / remove.

## Data model

**Vocabulary** (persisted on `business_settings/business_settings`):
- `householdTags: TagDef[]`
- `petTags: TagDef[]`
- `TagDef = { name: string; color: string; icon: string }`
  - `name`: unique within its own list, trimmed, 1..40 chars. It is the **key** that
    assignments reference.
  - `color`: a token from a fixed palette (a small preset set defined in the React
    admin's tokens; not free hex in v1).
  - `icon`: an emoji string now. Kept a plain string so a future `iconType`
    discriminator (`'emoji' | 'library' | 'image'`) + a library-key/URL value can be
    added without migrating existing `{name,color,icon}` docs. Default `iconType` when
    absent is `emoji`.

**Assignment** (tag NAMES only, backward-compatible):
- `kinfolk.tags: string[]` — household tag names. **Already exists** (Kotlin
  `Kinfolk.tags: List<String>`, React `KinfolkProfile.tags`). Unchanged.
- `kin.tags: string[]` — pet tag names. **NEW**. Reads default to `[]`; writes are
  merge, so legacy docs without the field are unaffected. Add the field to the React
  `KinDetail` type and (for cross-platform parity, later) the Kotlin `Kin` model.

**Chip resolution** (pure, tested): given a tag name + the relevant vocabulary,
resolve `{ color, icon }`. A name not in the vocab (free-form or a removed vocab tag)
renders a **neutral default chip** (no color, no emoji) — never an error.

## Backend / write paths (verified integration points)

- **Vocabulary write**: `src/api/settingsWrite.ts#saveBusinessSettings(patch)` already
  does a rules-backed `setDoc(business_settings, {merge:true})`. Persist the vocab via
  `saveBusinessSettings({ householdTags, petTags })`. No new callable.
- **kin.tags write**: extend the kin update in `src/api/directoryWrite.ts` (the kin
  write module) to carry `tags`. Rules already allow `isAuntie` write on the kin doc.
- **kinfolk.tags write**: **new** — `kinfolkProfile.ts` is read-only today. Add a
  small `kinfolkProfileWrite.ts` (or extend directoryWrite) that does a rules-backed
  `updateDoc` of `{ tags }` on the kinfolk doc (KinEdit pattern). Rules allow `isAuntie`
  write on kinfolk.
- All writes fail loud (surface the error; never swallow).

## UI

### Manage — Business settings → Tags (new panel)

A "Tags" panel reachable from `Settings.tsx` (same in-place open pattern the other
Settings panels use). Two subsections: **Household tags**, **Pet tags**. Each lists its
`TagDef`s (emoji + color swatch + name) with:
- **Add**: name input + palette color picker + emoji picker.
- **Edit**: change an existing tag's color and/or emoji (name is the key; see note).
- **Remove**: drops the vocab entry. Existing assignments to that name still render
  (as default chips) — no cascade rewrite in v1.

Note on rename: because `name` is the assignment key, renaming in place would orphan
assignments. v1 avoids this: to "rename," remove + add (old assignments become default
chips). Editing color/icon is safe and allowed. Revisit rename-with-cascade later if needed.

### Assign — kinfolk profile + kin/pet profile

- **Kinfolk profile**: a Tags row — current tags as colored emoji chips (× to remove) +
  an "Add tag" input that **autocompletes from `householdTags`** and lets you type a new
  free-form name. A new name offers "add to household vocabulary" (creates a `TagDef`
  with a default color and no emoji, editable later in Settings). Saves `kinfolk.tags`.
- **Kin/pet profile**: same, using `petTags`, saving `kin.tags`.

## Reuse / downstream consumers (unchanged, get richer chips free)

- Broadcast audience (`CommunicateCompose` `buildCriteria` `tagsRaw`) already filters by
  kinfolk tag name; the tag chips it shows now resolve rich color/emoji.
- KinTale `KINFOLK_TAG` condition (`src/lib/kinTale/engine.ts`) already reads
  `kinfolk.tags` by name; unchanged.

## Testing

- **Pure**: chip resolution (name → `{color,icon}`, default fallback for unknown);
  vocab add/remove/edit transforms; assignment autocomplete filtering; add-new-to-vocab.
- **Component**: Settings Tags panel CRUD saves the right `business_settings` payload;
  profile Tags field adds/removes a tag and creates a vocab entry; `kin.tags` round-trips.
- **Backend/API**: `kin.tags` write; kinfolk-tags write; vocab write payload shape.

## Rollout

- Build on `auntieos-admin` (React) + the `kin.tags` field.
- Deploy: React admin hosting + (if kin.tags needs any rules/callable touch — it does
  not, the existing kin rule covers it) nothing backend beyond data.
- Port to android/Compose later (Kotlin `Kin` gains `tags`; the wasm admin is throwaway).

## Open items folded into the plan (not placeholders)

- Confirm `directoryWrite.ts` exposes a kin-update entry point to extend (vs a new fn).
- Pick the preset color palette tokens (reuse the admin's existing token set).
- Emoji picker: use a lightweight inline picker or a small curated emoji set (no heavy dep).
