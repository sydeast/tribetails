# Task 2.1 Micro-Plan: Communicate defaults to the Auntie voice generator (#4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Communicate open on the Auntie voice generator (the archive's Personalize composer), rebuild that composer to the archive's field set with a recipient typeahead that resolves a real `kinfolkId`, and restore the missing channels and options around it (Broadcast saved segments + in-app channel + per-channel tally, and a "Send outside the tribe" external Email/Text panel with a real opt-out path).

**Architecture:** All decision logic lands in pure `src/lib/*.ts` modules that are unit-tested without React. The `src/api/*` layer owns exactly one wire contract each. Screens are thin. The one server change is additive: `generateAuntieCopy` learns an optional `kinfolk_id` so the client's resolved id short-circuits the server's fuzzy name match instead of relying on it.

**Tech Stack:** React 19 + Vite 6 + Firebase 11 + Zod 4 + Vitest 2.1.8 (web); Node 22 + `node --test` (the AuntieOS `web/functions` codebase); Jetpack Compose + Kotlin (Android).

## Global Constraints

- Branch is `feat/communicate-voice-generator`. NEVER commit on `main`.
- No em dashes in user-facing copy. DenScreenKit voice ("The Den · X" kickers, fail-loud banners).
- Never fabricate a count, an id, or a success. A failed load stays a named error.
- Client validation MIRRORS the server's; the server stays authoritative.
- Web checks per commit, from `auntieos-admin/`: `npx tsc --noEmit`, `npx vitest run`, `npx vite build`.
- `web/functions` checks: `cd auntieos-admin/web/functions && npm test` (`node --test`).
- Android: report changed Kotlin files. DO NOT run gradle.
- DO NOT DEPLOY. Deploy commands go in the PR body.

## Settled rulings (do not re-litigate)

1. **"Auntie voice generator" = the archive's Personalize composer.** Brand-voice COPY generation, not text to speech.
2. **KinTale is a MESSAGE TYPE, not a broadcast channel.** `broadcastMessage`'s zod enum is frozen at `['inapp','email','sms','push']`. The archive's `MessageType.Visit` ("Visit report") only sets `communication_type: 'visit_report'` on the generate call. We ship it as the message type labelled "KinTale report" and add NO broadcast channel the dispatcher cannot deliver.
3. **Approve ordering.** Firestore write on `generated_drafts/{draftId}` must SUCCEED before anything downstream runs. Then the audit entry. Then, only for a deliverable message type, the actual send. A failed write means no audit and no send.

## Archive findings that CORRECT the task brief

- The archive had **two** modes (Personalize default, Broadcast). "Recent" was a collapsible right-hand panel, not a tab. This plan ships three tabs because the React port already made Recent a full screen; that is an intentional divergence, not a restoration.
- The archive's recipient picker **did not send a kinfolkId**. It picked a `Kinfolk` object and then transmitted `recipient = displayName`, and the server fuzzy-matched it (`matchKinfolk` in `generate.js`). The archive's own header comment claiming otherwise was false. Task 3 below makes the comment true for the first time.
- The archive's "downstream ping" (`N8nClient.pingProfileUpdate`) was **dead code, never called**. This plan gives the ordering rule a real downstream step: the delivery send.
- `generateAuntieCopy` already accepts tone and length, under the names `tone_hint` and `max_length`, and the message type under `communication_type`. It does **not** accept `kinfolk_id`. That is the only gap.

---

## File structure

**Pure logic (new)**
- `src/lib/personalizeCompose.ts` — message type / tone / length tables, recipient filtering, blockers, generate-payload builder.
- `src/lib/externalSend.ts` — email + E.164 pre-flight, blockers, `recipient_opted_out` copy.
- `src/lib/audienceSegmentEdit.ts` — segment save blockers + criteria/segment mutual exclusion.

**API (new)**
- `src/api/communicateApprove.ts` — the ordered approve: write, audit, deliver.
- `src/api/audienceSegments.ts` — list/save/delete saved segments.
- `src/api/externalSend.ts` — `sendExternalMessage` + `suppressExternalRecipient`.

**API (modified)**
- `src/api/communicateGenerate.ts` — `kinfolk_id` on `GenerateDraftArgs`.
- `src/api/communicateWrite.ts` — `inapp` channel, `segmentId` path, `perChannel` typed over all four channels.

**Components / screens**
- `src/components/ExternalSendPanel.tsx` + `.css` (new).
- `src/screens/CommunicatePersonalize.tsx` (rewrite) + `.css`.
- `src/screens/CommunicateCompose.tsx` (segment picker, in-app channel, tally rows).
- `src/screens/Communicate.tsx` (three-mode switch, Personalize default).

**Server**
- `web/functions/generate.js` — optional `kinfolk_id`.
- `web/functions/test/generate.test.js` — coverage for it.

**Android**
- `data/model/Models.kt`, `data/AuntieRepository.kt`, `ui/communicate/CommunicateViewModel.kt`, `ui/communicate/CommunicateScreen.kt`, `ui/communicate/ExternalSendCopy.kt` (new), `util/FieldValidators.kt`, plus tests.

---

## Task 1: Pure Personalize composer logic

**Files:** Create `src/lib/personalizeCompose.ts`, `src/lib/personalizeCompose.test.ts`.

**Interfaces produced:**
```ts
export interface PersonalizeMessageType {
  key: GenerateCommunicationType;   // 'visit_report' | 'sms' | 'email' | 'blog_post'
  label: string;
  needsRecipient: boolean;
  /** true when approving can actually deliver the copy to someone. */
  deliverable: false | 'email' | 'sms';
}
export const PERSONALIZE_MESSAGE_TYPES: readonly PersonalizeMessageType[];
export const PERSONALIZE_TONES: readonly { key: string; label: string }[];
export const PERSONALIZE_LENGTHS: readonly { key: string; label: string }[];
export function messageTypeDef(key: string): PersonalizeMessageType;
export function filterRecipients(rows: Kinfolk[], query: string, limit?: number): Kinfolk[];
export function generateBlocker(s: PersonalizeFormState): string | null;
export function approveBlocker(s: PersonalizeFormState, draftId: string | null, draftText: string): string | null;
export function buildGeneratePayload(s: PersonalizeFormState, kf: Kinfolk | undefined, avoidOpening: string | null): GenerateDraftArgs;
```

- [ ] Step 1: failing tests — chip label/wire tables, `filterRecipients` (archived excluded, name+email case-insensitive match, sorted, capped), `generateBlocker` (blank notes first, then missing recipient, only for `needsRecipient` types), `approveBlocker` (no draft id, empty body, deliverable-type missing contact, email missing subject), `buildGeneratePayload` (includes `kinfolk_id`, omits `recipient` for Blog, omits empty optionals, `want_title` only for email).
- [ ] Step 2: `npx vitest run src/lib/personalizeCompose.test.ts` — FAIL (module not found).
- [ ] Step 3: implement.
- [ ] Step 4: rerun — PASS.
- [ ] Step 5: commit.

## Task 2: Pure external-send logic

**Files:** Create `src/lib/externalSend.ts`, `src/lib/externalSend.test.ts`.

**Interfaces produced:**
```ts
export type ExternalChannel = 'email' | 'sms';
export type RecipientValidation = 'valid' | 'empty' | 'bad-email' | 'bad-phone';
export function isValidExternalEmail(raw: string): boolean;   // mirrors /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function isValidExternalPhone(raw: string): boolean;    // E.164-shaped, 8..15 digits
export function validateExternalRecipient(channel: ExternalChannel, raw: string): RecipientValidation;
export function externalSendBlocker(channel: ExternalChannel, to: string, subject: string, body: string): string | null;
export function externalSuppressBlocker(channel: ExternalChannel, to: string): string | null;
export function isOptedOutError(message: string): boolean;     // case-insensitive substring 'recipient_opted_out'
export function externalSendErrorText(message: string): string;
```

- [ ] Step 1: failing tests, including `+447700900123` accepted (12 digits), `555 1234` rejected (7 digits), `FAILED_PRECONDITION: recipient_opted_out` recognised, non-opt-out messages passed through verbatim.
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run — PASS.
- [ ] Step 5: commit.

## Task 3: `generateAuntieCopy` learns `kinfolk_id`

**Files:** Modify `web/functions/generate.js`, `web/functions/test/generate.test.js`; modify `src/api/communicateGenerate.ts` + `src/api/communicateGenerate.test.ts`.

Server change, additive and backwards compatible:
- `validateRequest` returns `kinfolk_id` (string or null).
- `resolveContext`: when `kinfolk_id` is present, `db.collection('kinfolk').doc(id).get()`. Missing doc is a 404 `No Kinfolk with id "<id>"`. When absent, the existing full-scan `matchKinfolk` path is unchanged.
- `generated_drafts` write is unchanged in shape.

- [ ] Step 1: failing server tests — direct lookup used, no roster scan; 404 on unknown id; name path unchanged when no id; id wins over a conflicting name.
- [ ] Step 2: `cd auntieos-admin/web/functions && npm test` — FAIL.
- [ ] Step 3: implement in `generate.js`.
- [ ] Step 4: rerun — PASS.
- [ ] Step 5: failing client test — `generateDraft` forwards `kinfolk_id` in the POST body.
- [ ] Step 6: add the field to `GenerateDraftArgs`. Run web suite — PASS.
- [ ] Step 7: commit.

## Task 4: The ordered approve

**Files:** Create `src/api/communicateApprove.ts`, `src/api/communicateApprove.test.ts`.

**Interfaces produced:**
```ts
export class ApproveDraftError extends Error {}
export class ApproveDeliveryError extends Error {}
export interface ApproveDraftArgs {
  draftId: string;
  editedCopy: string;
  kinfolkId: string | null;
  subject: string | null;
  /** Runs ONLY after the Firestore write has succeeded. */
  deliver?: () => Promise<string | null>;
}
export interface ApproveDraftResult { ok: true; auditWarning: string | null; providerId: string | null; delivered: boolean; }
export async function approveGeneratedDraft(args: ApproveDraftArgs): Promise<ApproveDraftResult>;
```

Order, non-negotiable:
1. `updateDoc(doc(db,'generated_drafts',draftId), { status:'approved', generatedCopy, approvedAt, approvedBy, ...(subject?{subject}:{}) })`. Failure throws `ApproveDraftError`; nothing else runs.
2. `call('logActivity', { actionType:'DRAFT_APPROVED', description, status:'SUCCESS', targetId: draftId, targetCollection:'generated_drafts' })`. Failure is non-fatal and surfaces as `auditWarning`.
3. `deliver?.()`. Failure throws `ApproveDeliveryError` (the draft IS approved; the message did not go out).

- [ ] Step 1: failing tests — happy path call order asserted via a shared `calls[]` log; write failure means zero audit calls and zero deliver calls; audit failure still delivers and returns a warning; deliver failure throws `ApproveDeliveryError` after a successful write; no `deliver` means `delivered:false`.
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run — PASS.
- [ ] Step 5: **mutation check.** Temporarily move `deliver?.()` above the `updateDoc`. Rerun: the "write failure delivers nothing" test MUST fail. Revert.
- [ ] Step 6: commit.

## Task 5: Audience segments + external send api layers

**Files:** Create `src/api/audienceSegments.ts` (+test), `src/api/externalSend.ts` (+test), `src/lib/audienceSegmentEdit.ts` (+test). Modify `src/api/communicateWrite.ts` (+test).

`communicateWrite.ts` changes: `BROADCAST_CHANNELS = ['inapp','email','sms','push']`; `SendBroadcastArgs` gains optional `segmentId` and makes `criteria` optional; `SendBroadcastResult.perChannel` typed over all four; `describeAudience` unchanged.

- [ ] Step 1: failing tests for all four modules (payload shapes, decode defensiveness, `segmentSaveBlocker`, criteria/segmentId mutual exclusion, in-app requires a subject).
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run — PASS.
- [ ] Step 5: commit.

## Task 6: `ExternalSendPanel` component

**Files:** Create `src/components/ExternalSendPanel.tsx`, `.css`, `.test.tsx`.

Renders: channel radio (Email default / Text), recipient input, subject (email only), body, "Send" and "Opt out recipient". Blocked sends never hit the network. `transactional` is a prop, defaulting to `true` so a 1:1 reply cannot be dropped by a marketing opt-out.

- [ ] Step 1: failing tests — blocked send does not call the api; opt-out error renders the dedicated copy; opt-out button calls `suppressExternalRecipient` and confirms with the redacted recipient; success renders provider id + redacted recipient; `transactional:true` is on the payload.
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run — PASS.
- [ ] Step 5: commit.

## Task 7: Personalize composer rewrite

**Files:** Rewrite `src/screens/CommunicatePersonalize.tsx`, `.css`, `.test.tsx`.

Render order: message-type chips → recipient typeahead (hidden for Blog) → Subject → Notes → Tone chips + Length chips → Generate/Regenerate → draft callout + editable draft → Approve. Approve opens a confirm Dialog for deliverable types.

- [ ] Step 1: failing tests — default type is "KinTale report"; typeahead search resolves and the payload carries the real `kinfolk_id`; blockers surface before any fetch; Approve calls `approveGeneratedDraft` and, on a write failure, shows the failure and does not claim a send; the audit warning renders; the tone/length chips reach the payload as `tone_hint`/`max_length`.
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run — PASS.
- [ ] Step 5: commit.

## Task 8: Broadcast gets segments, in-app, and a tally table

**Files:** Modify `src/screens/CommunicateCompose.tsx`, `.css`, `.test.tsx`.

- [ ] Step 1: failing tests — segments load and render; picking one hides the ad-hoc builder and sends `segmentId` with no `criteria`; "Ad-hoc" sends `criteria` with no `segmentId`; save + delete round-trip; in-app requires a subject; the result renders one row per channel with sent/skipped/failed.
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run — PASS.
- [ ] Step 5: commit.

## Task 9: Three-mode Communicate, Personalize default

**Files:** Modify `src/screens/Communicate.tsx`, `.css`, `.test.tsx`.

`COMMUNICATE_MODES = [Personalize, Broadcast, Recent]`, default `personalize`. Recent keeps its All/Email/Text/Push filter tablist. `listRecentSends` only loads when Recent is showing.

- [ ] Step 1: failing tests — Personalize renders on mount; the mode tablist has the three tabs in order with Personalize selected; switching to Recent loads sends; the channel filter still works.
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run — PASS; then `npx tsc --noEmit && npx vitest run && npx vite build`.
- [ ] Step 5: commit.

## Task 10: Android parity

**Files:** `data/model/Models.kt`, `data/AuntieRepository.kt`, `ui/communicate/CommunicateViewModel.kt`, `ui/communicate/CommunicateScreen.kt`, `ui/communicate/ExternalSendCopy.kt` (new), `util/FieldValidators.kt`, plus `ui/communicate/CommunicateViewModelTest.kt`, `ui/communicate/ExternalSendValidationTest.kt`, `ui/communicate/ExternalSendCopyTest.kt` (new), `util/FieldValidatorsTest.kt`.

Genuine gaps versus the web slice, all closed here:
1. `GenerateRequest` has no `kinfolk_id`; the resolved id is thrown away and the server re-fuzzy-matches. Add the field and send it.
2. `approveDraft` writes no audit entry, while the screen prints "logs it to the audit trail". Add the `logActivity` call, strictly AFTER the Firestore write, non-fatal.
3. External send has no `recipient_opted_out` copy; the raw token reaches the operator. Add `externalSendErrorText`.
4. Communicate's external send omits `transactional`, defaulting to the marketing path. Pass `true`.
5. `isValidPhone` is US-only and rejects valid E.164 international numbers before the server sees them. Add `isValidE164Phone`.
6. Tone chips are `warm/casual/celebratory/urgent/professional`; the archive and web are `warm/cheerful/professional/playful`. Align.
7. Message type is a dropdown over six types including two the composer cannot use; make it chips over the four real ones with "KinTale report" as the label for `visit_report`.

- [ ] Step 1: write the Kotlin tests first (payload carries `kinfolk_id`; approve emits an audit entry only after a successful write; opt-out copy; E.164 acceptance; chip tables).
- [ ] Step 2: implement.
- [ ] Step 3: commit. Report the Kotlin file list; do not run gradle.

## Task 11: Ship

- [ ] `npx tsc --noEmit && npx vitest run && npx vite build` from `auntieos-admin/`.
- [ ] `cd auntieos-admin/web/functions && npm test`.
- [ ] Push, open the PR with the operator deploy command for `generateAuntieCopy`.

---

## Self-review

**Spec coverage.** Scope 1 → Task 9. Scope 2 → Tasks 1, 3, 4, 7. Scope 3 → Task 3. Scope 4 → Tasks 5, 8. Scope 5 → Tasks 2, 6. KinTale ruling → Task 1's type table plus the ruling above; no broadcast channel added. Android → Task 10. Mutation checks → Task 4 step 5 (write-before-ping) and Task 6 step 1 (opt-out path).

**Deliberately not in this slice.** `RecipientContextPanel` (dossier + Kin411 + last-communication) is listed in the parent plan's Task 2.1 file list but is not in the operator's five-item scope. It depends on the Python-codebase callables `recap_recent_comms` / `synthesize_kinfolk_profile` and is a self-contained read-only panel. It is deferred rather than half-built.
