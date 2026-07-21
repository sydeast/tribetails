# n8n Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## ⚑ EXECUTION STATUS (updated 2026-06-21)
> **Phase A (A1-A7) is DONE and green; nothing deployed (operator-gated).** Executed subagent-driven. See `docs/archive/handoffs/HANDOFF_2026-06-21-n8n-retirement-EXECUTED.md`.
> - A1 done (+ a review fix: the `UNSUBSCRIBE_FOOTER` is now skipped for transactional emails). A2/A3/A4 (web) done. A5 (android) done (+ repaired 6 existing tests the repoint broke + a pre-existing test-module compile error). A6 (android) done.
> - **NEW task A6b** (not in the original plan): the android "Refresh intelligence" button's only action was an n8n synthesis ping. Operator chose "keep it, build a callable." Built `synthesize_kinfolk_profile` (python `reconcile` codebase, admin-gated, reuses `reconcile_pass(kinfolk_id_filter=…)`) + repointed android. This removed the last android `updateProfiles` call. Web/desktop parity for this button is a spawned follow-up (it was android-only; not an n8n dependency).
> - A7 sweep green: MyTribe vitest 917, web jvmTest+wasm, android 1023 (2 known pre-existing failures), python 19.
> - **A8 now needs TWO deploys**, not one: `functions:mytribe:sendExternalMessage` AND `functions:reconcile` (the new python callable). The android button fails loud until the python deploy lands.
> - **Phase B addition (B2):** also delete the now-dead `AuntieRepository.sendMessage` method (still calls `n8n.sendMessage`, uncalled) - deleting `N8nApi` without it breaks compile.
> - Deferred (separate effort): de-gate the `communicateGenerateViaFunction` flag + the inert `generate(useFunction)` param.

**Goal:** Make AuntieOS call zero n8n by routing the Inbox/Messaging 1:1 reply through the existing direct `sendExternalMessage` callable (with a transactional flag that skips the marketing-suppression gate), then delete every n8n endpoint, client, and config.

**Architecture:** Add a `transactional` flag to the deployed `sendExternalMessage` callable (MyTribe) that skips the `message_suppressions` consent gate for 1:1 replies (Twilio still enforces carrier STOP). Repoint the web (`commonMain`) and android Inbox/Messaging reply call sites from the n8n proxy to that callable. Drop the redundant profile-update ping and the dead generate-n8n fallback. After a prod verify gate, delete the n8n server functions, client plumbing, and stale config.

**Tech Stack:** Firebase Functions v2 (TypeScript, MyTribe), Kotlin Compose Multiplatform (web/wasm + desktop/jvm, commonMain), Kotlin Android, vitest, Kotlin test (jvmTest), android unit test.

**Repo note:** NONE of the trees are git repos yet (verified 2026-06-21: no `.git` in AuntieOS, MyTribe, `web/functions`, or `web/functions-python`). So there are NO commit steps anywhere - every task ends at "tests/build green" as its checkpoint. Git will be initialized later (after the operator clears secrets/PII per the prior review), at which point all of this lands in the first commit. Run AuntieOS python/test tooling with `android/.venv` where noted; run gradle from the relevant module dir; run MyTribe vitest from `MyTribe/functions`.

**Order:** Do Phase A fully (incl. the A8 prod verify gate) before any Phase B deletion. Spec: `docs/superpowers/specs/2026-06-19-n8n-retirement-design.md`.

---

## Phase A - go direct (n8n stays live as hot fallback)

### Task A1: Backend `transactional` flag on `sendExternalMessage` (MyTribe)

**Files:**
- Modify: `functions/src/admin/sendExternalMessage.ts` (Args schema ~48-71; handler suppression gate ~150-155; external_messages doc ~193-207)
- Test: `functions/test/sendExternalMessage.test.ts` (add to existing suite)

- [ ] **Step 1: Write the failing tests**

Append to `functions/test/sendExternalMessage.test.ts` (reuses the file's existing `req`, `cleanDb`, `buildDbMock`, `mocks`):

```typescript
describe('sendExternalMessage transactional flag (1:1 inbox reply)', () => {
  it('default (no flag) still blocks a suppressed recipient', async () => {
    const ctx = buildDbMock({ docs: { 'message_suppressions/+14155552671': { channel: 'sms' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendExternalMessageHandler(req({ channel: 'sms', to: '+14155552671', body: 'hi' })),
    ).rejects.toMatchObject({ message: 'recipient_opted_out' });
    expect(mocks.twilioCreate).not.toHaveBeenCalled();
  });

  it('transactional=true sends to a suppressed recipient (1:1 reply bypasses marketing opt-out)', async () => {
    const ctx = buildDbMock({ docs: { 'message_suppressions/+14155552671': { channel: 'sms' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendExternalMessageHandler(
      req({ channel: 'sms', to: '+14155552671', body: 'hi', transactional: true }),
    );
    expect(res.providerMessageId).toBe('SM123');
    expect(mocks.twilioCreate).toHaveBeenCalledTimes(1);
  });

  it('records the transactional classification on the external_messages doc', async () => {
    const ctx = cleanDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await sendExternalMessageHandler(req({ channel: 'sms', to: '+14155552671', body: 'hi', transactional: true }));
    const added = ctx.added('external_messages');
    expect(added[0]).toMatchObject({ transactional: true });
  });
});
```

If `buildDbMock` does not expose an `added(collection)` helper, open `functions/test/_helpers/mockDb.ts`, confirm how `.add()` payloads are captured, and adapt the third test's assertion to that helper's API (e.g. inspect the recorded add calls). Do not invent an API - match the helper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && npx vitest run test/sendExternalMessage.test.ts`
Expected: FAIL (the two new transactional tests fail: suppressed+transactional currently throws `recipient_opted_out`; no `transactional` field on the doc).

- [ ] **Step 3: Add `transactional` to the Args schema**

In `functions/src/admin/sendExternalMessage.ts`, in the `Args` zod object (the `.object({...})` before `.superRefine`), add:

```typescript
    transactional: z.boolean().default(false),
```

- [ ] **Step 4: Skip the suppression gate when transactional**

Replace the consent-gate block (currently):

```typescript
  // Consent gate: refuse to send to a suppressed recipient.
  const suppressionRef = db().collection('message_suppressions').doc(suppressionDocId(normalized));
  const suppressionSnap = await suppressionRef.get();
  if (suppressionSnap.exists) {
    throw new HttpsError('failed-precondition', 'recipient_opted_out');
  }
```

with:

```typescript
  // Consent gate: refuse to send to a suppressed recipient. Skipped for a
  // transactional 1:1 reply (Inbox/Messaging): the recipient is an active
  // conversation, not marketing outreach, so the marketing opt-out does not
  // apply. Twilio still enforces a hard carrier-level STOP regardless.
  if (!args.transactional) {
    const suppressionRef = db().collection('message_suppressions').doc(suppressionDocId(normalized));
    const suppressionSnap = await suppressionRef.get();
    if (suppressionSnap.exists) {
      throw new HttpsError('failed-precondition', 'recipient_opted_out');
    }
  }
```

- [ ] **Step 5: Record the classification on the external_messages doc**

In the `.collection('external_messages').add({ ... })` object, add the field (next to `channel`):

```typescript
      transactional: args.transactional,
```

And in the `writeAuditEntry` `payload`, add `transactional: args.transactional` so the audit row distinguishes the two send modes.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && npx vitest run test/sendExternalMessage.test.ts && npx tsc --noEmit`
Expected: PASS (all existing + 3 new). tsc clean.

- [ ] **Step 7: Checkpoint (no commit - MyTribe is not a git repo)**

Confirm `npx vitest run test/sendExternalMessage.test.ts` is fully green and `npx tsc --noEmit` is clean. That green state is this task's checkpoint; do not run git.

---

### Task A2: Web - extract a testable external-send payload builder + add `transactional` param

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt:230-248`
- Create: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/communicate/ExternalSendPayload.kt`
- Test: `web/composeApp/src/jvmTest/kotlin/com/tribetails/auntieos/web/screens/communicate/ExternalSendPayloadTest.kt`

- [ ] **Step 1: Write the failing test**

Create `ExternalSendPayloadTest.kt`:

```kotlin
package com.tribetails.auntieos.web.screens.communicate

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.Json

class ExternalSendPayloadTest {
    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test fun sms_reply_is_transactional_and_omits_subject() {
        val o = obj(externalSendPayloadJson("sms", "+14155552671", subject = null, body = "hi", transactional = true))
        assertEquals("sms", o["channel"]!!.jsonPrimitive.content)
        assertEquals("+14155552671", o["to"]!!.jsonPrimitive.content)
        assertEquals("hi", o["body"]!!.jsonPrimitive.content)
        assertEquals(true, o["transactional"]!!.jsonPrimitive.content.toBoolean())
        assertFalse(o.containsKey("subject"))
    }

    @Test fun oneoff_email_keeps_subject_and_defaults_non_transactional() {
        val o = obj(externalSendPayloadJson("email", "a@b.com", subject = "Hi", body = "x", transactional = false))
        assertEquals("Hi", o["subject"]!!.jsonPrimitive.content)
        assertEquals(false, o["transactional"]!!.jsonPrimitive.content.toBoolean())
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web && ./gradlew :composeApp:jvmTest --tests "com.tribetails.auntieos.web.screens.communicate.ExternalSendPayloadTest"`
Expected: FAIL (compile error: `externalSendPayloadJson` unresolved).

- [ ] **Step 3: Create the pure payload builder**

Create `ExternalSendPayload.kt`:

```kotlin
package com.tribetails.auntieos.web.screens.communicate

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Pure builder for the sendExternalMessage callable payload. Subject is included
 * only for email with a non-blank value (matches the server). `transactional`
 * marks a 1:1 reply (Inbox/Messaging) so the server skips the marketing
 * suppression gate; false (default) is one-off outreach that honors opt-outs.
 */
fun externalSendPayloadJson(
    channel: String,
    to: String,
    subject: String?,
    body: String,
    transactional: Boolean,
): String {
    val payload: JsonObject = buildJsonObject {
        put("channel", JsonPrimitive(channel))
        put("to", JsonPrimitive(to))
        if (channel == "email" && !subject.isNullOrBlank()) put("subject", JsonPrimitive(subject))
        put("body", JsonPrimitive(body))
        put("transactional", JsonPrimitive(transactional))
    }
    return Json.encodeToString(JsonObject.serializer(), payload)
}
```

- [ ] **Step 4: Use the builder in FirestoreClient + add the param**

In `FirestoreClient.kt`, change the method signature and body (lines 230-248):

```kotlin
    suspend fun sendExternalMessage(
        channel: String,
        to: String,
        subject: String?,
        body: String,
        transactional: Boolean = false,
    ): WriteResult<com.tribetails.auntieos.web.screens.communicate.ExternalSendResult> {
        val payloadJson = com.tribetails.auntieos.web.screens.communicate
            .externalSendPayloadJson(channel, to, subject, body, transactional)
        return when (val r = platformInvokeCallable("sendExternalMessage", payloadJson)) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(com.tribetails.auntieos.web.screens.communicate.decodeExternalSendResult(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "external send decode failed") }
        }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web && ./gradlew :composeApp:jvmTest --tests "com.tribetails.auntieos.web.screens.communicate.ExternalSendPayloadTest"`
Expected: PASS.

- [ ] **Step 6: Checkpoint (no commit - AuntieOS not a git repo)**

Confirm `:composeApp:jvmTest` for this test class is green. Existing CommunicateScreen call `firestore.sendExternalMessage(channel.wire, recipient, subject, body)` still compiles (transactional defaults false).

---

### Task A3: Web - repoint Inbox reply to the direct callable

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/inbox/InboxScreen.kt` (reply block ~303-337; `val n8n` ~113; imports ~54-56)

- [ ] **Step 1: Replace the n8n reply call**

In the reply `scope.launch { try { ... } }` block, replace:

```kotlin
                                                    val response = n8n.sendMessage(
                                                        SendMessageRequest(
                                                            channel = "sms",
                                                            message_body = body,
                                                            kinfolk_id = entry.kinfolkId,
                                                            recipient_phone = entry.replyTargetPhone,
                                                        )
                                                    )
                                                    if (entry.channel == Channel.Voicemail) {
                                                        when (val write = client.markVoicemailReplied(
                                                            voicemailId = entry.id,
                                                            repliedAtIso = nowIso(),
                                                            replyLogId = response.deliveryIdOrBlank(),
                                                        )) {
```

with (route through the direct callable; map provider id to the reply log id; surface a send failure fail-loud before any status write):

```kotlin
                                                    val sent = client.sendExternalMessage(
                                                        channel = "sms",
                                                        to = entry.replyTargetPhone,
                                                        subject = null,
                                                        body = body,
                                                        transactional = true,
                                                    )
                                                    val providerId = when (sent) {
                                                        is WriteResult.Ok -> sent.value.providerMessageId
                                                        is WriteResult.Err -> {
                                                            showToast("Reply failed: ${sent.message}", ToastKind.Error)
                                                            return@launch
                                                        }
                                                    }
                                                    if (entry.channel == Channel.Voicemail) {
                                                        when (val write = client.markVoicemailReplied(
                                                            voicemailId = entry.id,
                                                            repliedAtIso = nowIso(),
                                                            replyLogId = providerId,
                                                        )) {
```

(`client` is the existing `FirestoreClient` in this screen - verify its local name; if the screen uses a different identifier for the FirestoreClient instance, use that. The screen already calls `client.markVoicemailReplied`, so the same instance has `sendExternalMessage`.)

- [ ] **Step 2: Remove the now-unused n8n wiring**

Delete the line `val n8n = remember { N8nClient() }` (~113) IF no other `n8n.` usage remains in `InboxScreen.kt` (grep to confirm). Remove the now-unused imports `com.tribetails.auntieos.web.data.N8nClient` and `com.tribetails.auntieos.web.data.SendMessageRequest`.

Run: `grep -n "n8n\.\|N8nClient\|SendMessageRequest" web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/inbox/InboxScreen.kt`
Expected: no matches after edits.

- [ ] **Step 3: Build to verify it compiles (web + desktop share commonMain)**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web && ./gradlew :composeApp:compileKotlinWasmJs :composeApp:compileKotlinJvm`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Checkpoint (no commit)** - compile green; reply now routes to `sendExternalMessage(transactional=true)`.

---

### Task A4: Web - drop the profile-update ping (generate already Function-only)

**Files:**
- Modify: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/screens/communicate/CommunicateScreen.kt:253`

- [ ] **Step 1: Remove the ping call**

Delete the line:

```kotlin
                n8n.pingProfileUpdate(draftId, r.kinfolk_id ?: selectedKinfolk?._id)
```

(and any now-dead surrounding `draftId`/comment that exists only to feed it; keep the draft-id handling the UI still uses). Leave `n8n.generate(...)` at line 196 as-is (it already routes to the Function via `useFunction=true`).

- [ ] **Step 2: Build to verify**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web && ./gradlew :composeApp:compileKotlinWasmJs :composeApp:compileKotlinJvm`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Checkpoint (no commit).**

---

### Task A5: Android - `transactional` param on repo + repoint Inbox & Messaging replies

**Files:**
- Modify: `android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt:565-583` (sendExternalMessage)
- Modify: `android/app/src/main/java/com/tribetails/auntieos/ui/inbox/InboxViewModel.kt:178-195`
- Modify: `android/app/src/main/java/com/tribetails/auntieos/ui/communicate/MessagingViewModel.kt:80-95`
- Test: `android/app/src/test/java/com/tribetails/auntieos/ui/inbox/InboxViewModelReplyTest.kt`

- [ ] **Step 1: Write the failing VM test (fake repo records the transactional reply)**

Create `InboxViewModelReplyTest.kt`. Use the project's existing android test conventions (look at `android/app/src/test/java/com/tribetails/auntieos/ui/communicate/CommunicateViewModelTest.kt` for the fake-repo + coroutine-dispatcher setup and copy that harness exactly). The test must:
- construct an `InboxViewModel` with a fake `AuntieRepository` whose `sendExternalMessage(channel, to, subject, body, transactional)` records its args and returns `Result.success(ExternalSendResult("sms", "SMxyz", "+1******2671"))`;
- call the reply function with a phone + body;
- assert the fake recorded `channel == "sms"`, `to == <phone>`, `transactional == true`, and that `repo.sendMessage(SendMessageRequest)` was NOT called.

Mirror the assertion style and dispatcher rule (`Dispatchers.setMain`) from `CommunicateViewModelTest.kt`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/android && ./gradlew :app:testDebugUnitTest --tests "com.tribetails.auntieos.ui.inbox.InboxViewModelReplyTest"`
Expected: FAIL (reply still calls `repo.sendMessage`; fake records nothing / wrong method).

- [ ] **Step 3: Add the `transactional` param to the repo method**

In `AuntieRepository.kt`, change `sendExternalMessage` (line 565):

```kotlin
    suspend fun sendExternalMessage(
        channel: String,
        to: String,
        subject: String?,
        body: String,
        transactional: Boolean = false,
    ): Result<ExternalSendResult> = runCatching {
        ensureAuthenticated()
        val payload = buildMap<String, Any?> {
            put("channel", channel)
            put("to", to)
            put("body", body)
            if (channel == "email" && !subject.isNullOrBlank()) put("subject", subject)
            put("transactional", transactional)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("sendExternalMessage")
            .call(payload)
            .await().data as? Map<String, Any?>
        decodeExternalSendResult(raw, channel)
    }.onFailure { AuntieLog.e("sendExternalMessage failed (channel=$channel)", it) }
```

- [ ] **Step 4: Repoint InboxViewModel reply**

In `InboxViewModel.kt`, replace the `SendMessageRequest` + `repository.sendMessage(request)` block (178-195) with:

```kotlin
            repository.sendExternalMessage(
                channel = "sms",
                to = recipientPhone,
                subject = null,
                body = body,
                transactional = true,
            ).onSuccess { result ->
                if (!voicemailId.isNullOrBlank()) {
                    repository.markVoicemailReplied(voicemailId, result.providerMessageId).onFailure {
                        _error.value = it.message ?: "Reply sent but voicemail status update failed"
                    }
                }
                _actionResult.tryEmit("Reply sent")
            }.onFailure { _error.value = it.message ?: "Failed to send reply" }
```

Remove the now-unused `import com.tribetails.auntieos.data.model.SendMessageRequest`.

- [ ] **Step 5: Repoint MessagingViewModel send**

In `MessagingViewModel.kt`, replace the `SendMessageRequest` + `repo.sendMessage(request)` block (80-95) with:

```kotlin
            repo.sendExternalMessage(
                channel = "sms",
                to = kinfolk.phoneNumber,
                subject = null,
                body = body,
                transactional = true,
            ).onSuccess {
                AuntieLog.i("Message sent successfully")
                _uiState.update { it.copy(isSending = false, currentInput = "") }
            }.onFailure { e ->
                AuntieLog.e("Failed to send message", e)
                _uiState.update { it.copy(isSending = false, error = e.message ?: "Failed to send") }
            }
```

Remove the now-unused `import com.tribetails.auntieos.data.model.SendMessageRequest`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/android && ./gradlew :app:testDebugUnitTest --tests "com.tribetails.auntieos.ui.inbox.InboxViewModelReplyTest"`
Expected: PASS.

- [ ] **Step 7: Checkpoint (no commit).**

---

### Task A6: Android - remove the profile-update ping + dead generate n8n branch

**Files:**
- Modify: `android/app/src/main/java/com/tribetails/auntieos/data/repository/AuntieRepository.kt` (the `updateProfiles` caller + any `n8n.generate` legacy branch)

- [ ] **Step 1: Find the callers**

Run: `grep -rn "updateProfiles\|n8n.generate\|generateViaFunction" android/app/src/main/java/com/tribetails/auntieos`
Note each call site.

- [ ] **Step 2: Remove the redundant profile-update call**

Delete the `n8n.updateProfiles(...)` invocation (the fire-and-forget profile refresh; reconcile owns this now). If it sits in a function whose only purpose was the ping, remove the function and its callers.

- [ ] **Step 3: Ensure generate uses the Function only**

If a generate path still branches to `n8n.generate(...)`, delete that branch so only `generateViaFunction(...)` remains.

- [ ] **Step 4: Build + full android unit tests**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/android && ./gradlew :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, all tests pass.

- [ ] **Step 5: Checkpoint (no commit).**

---

### Task A7: Full green sweep across all three platforms

- [ ] **Step 1: MyTribe**

Run: `cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe/functions && npx tsc --noEmit && npx vitest run`
Expected: tsc clean, all vitest pass.

- [ ] **Step 2: Web + desktop**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web && ./gradlew :composeApp:jvmTest :composeApp:compileKotlinWasmJs`
Expected: jvmTest green, wasm compiles.

- [ ] **Step 3: Android**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`
Expected: tests pass, APK builds.

- [ ] **Step 4: Confirm zero live n8n calls remain in clients**

Run: `grep -rn "n8n.sendMessage\|pingProfileUpdate\|updateProfiles\|auntie-send-message\|auntie-update-profiles" web/composeApp/src/commonMain android/app/src/main | grep -v "/build/"`
Expected: no matches (N8nClient/N8nApi definitions may still exist; they are deleted in Phase B).

---

### Task A8: Deploy backend + production verify gate (MUST pass before Phase B)

- [ ] **Step 1: Deploy the updated callable**

Run: `cd /Users/sydeast/Projects/testai/CascadeProjects/MyTribe && firebase deploy --only functions:mytribe:sendExternalMessage`
Expected: `Successful update operation` for `sendExternalMessage(us-central1)`.

- [ ] **Step 2: Live e2e on web, desktop, android (operator-assisted)**

For each platform, with a real admin login, send an Inbox SMS reply to a test phone and (where the UI supports email reply) an email reply to a test address. Verify: message delivered; `external_messages` doc written with `transactional: true`; audit row present. Then confirm a one-off Communicate send (transactional=false) to a SUPPRESSED test recipient is still blocked with `recipient_opted_out`, while an Inbox reply to that same suppressed recipient succeeds.

- [ ] **Step 3: Gate**

Only proceed to Phase B once Step 2 passes on all three platforms. If anything regresses, the n8n `sendMessage` endpoint is still live; temporarily revert the client reply call to `n8n.sendMessage` while fixing.

---

## Phase B - decommission (only after A8 passes)

### Task B1: Delete the n8n-only server functions + hosting rewrite (AuntieOS web/functions)

**Files:**
- Modify: `web/functions/index.js` (remove `sendMessage`, `writeDraft`, `getDraft`, `getTrainingDoc`, `N8N_SEND_URL`, `N8N_SHARED_SECRET`, `n8nKeyAuth`, `n8nIpAllowed`, `N8N_RATE_*`)
- Modify: `web/firebase.json` (remove the `/api/send-message` rewrite)

- [ ] **Step 1: Pre-check nothing else depends on them**

Run: `grep -rn "N8N_SHARED_SECRET\|writeDraft\|getDraft\|getTrainingDoc\|n8nIpRateLimits\|N8N_SEND_URL" web/functions web/composeApp/src android/app/src | grep -v "/build/\|/node_modules/"`
Expected: only the definitions in `web/functions/index.js` (no live consumers; generate writes `generated_drafts` directly; reconcile reads `training_documents` directly). If any consumer appears, STOP and resolve before deleting.

- [ ] **Step 2: Delete the exports + helpers**

Remove from `web/functions/index.js`: the `exports.sendMessage`, `exports.writeDraft`, `exports.getDraft`, `exports.getTrainingDoc` blocks, the `N8N_SEND_URL` const, the `N8N_SHARED_SECRET = defineSecret(...)`, `n8nKeyAuth`, `n8nIpAllowed`, and the `N8N_RATE_WINDOW_MS`/`N8N_RATE_LIMIT` consts. Keep `generate`, `signCloudinaryUpload`, `searchMapbox`, `retrieveMapbox`, `setAdminClaim`, and `requireAdminToken`.

- [ ] **Step 3: Remove the rewrite**

In `web/firebase.json`, delete the rewrite line: `{ "source": "/api/send-message", "function": "sendMessage" }`. Keep `/api/generate`, `/api/cloudinary/sign-upload`, `/api/mapbox/*`.

- [ ] **Step 4: Lint/build the functions**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web/functions && npm run lint 2>/dev/null || node -e "require('./index.js')"`
Expected: loads without referencing deleted symbols (no ReferenceError).

- [ ] **Step 5: Deploy functions + hosting**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web && firebase deploy --only functions,hosting:auntieos-ttpc --project auntieos-ttpc`
Expected: deploy succeeds; deleted functions are removed (firebase will prompt/auto-delete `sendMessage`/`writeDraft`/`getDraft`/`getTrainingDoc` - confirm deletion).

- [ ] **Step 6: Checkpoint (no commit).**

---

### Task B2: Delete client n8n plumbing; make generate Function-only

**Files:**
- Create: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/GenerateClient.kt`
- Delete: `web/composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/N8nClient.kt`
- Delete: `android/app/src/main/java/com/tribetails/auntieos/data/api/N8nApi.kt`
- Modify: `android/app/src/main/java/com/tribetails/auntieos/data/api/RetrofitClient.kt` (remove `buildN8n`)
- Modify: generate call sites (`CommunicateScreen.kt`, `KinTaleComposeScreen.kt`, android repo/VM) to use the Function-only client
- Modify/Delete: `android/.../data/model/Models.kt` `SendMessageRequest`/related if unused

- [ ] **Step 1: Create a Function-only generate client (web)**

Create `GenerateClient.kt` containing the Function-only `generate(req): GenerateResponse` (the body of the current `N8nClient.generate` `useFunction=true` branch, the POST to `https://auntieos-ttpc.web.app/api/generate` with the Bearer token) plus the `GenerateRequest`/`GenerateResponse`/`CommunicationType` data classes moved from `N8nClient.kt`. Do not include any `n8n.tribetails.com` host or `sendMessage`/`pingProfileUpdate`.

- [ ] **Step 2: Repoint web generate call sites**

In `CommunicateScreen.kt` and `KinTaleComposeScreen.kt`, replace `val n8n = remember { N8nClient() }` + `n8n.generate(...)` with `val gen = remember { GenerateClient() }` + `gen.generate(...)`. Delete `N8nClient.kt`.

- [ ] **Step 3: Delete android n8n plumbing**

Delete `N8nApi.kt`. In `RetrofitClient.kt`, remove `buildN8n`. Move `generateViaFunction` to a small `GenerateApi` (or fold the generate call into the existing functions/repo path) so nothing imports `N8nApi`. Delete `SendMessageRequest`/`SendMessageResponse`/`ProfileUpdateRequest` from `Models.kt` if now unreferenced (grep first).

- [ ] **Step 4: Build all platforms**

Run:
```
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/web && ./gradlew :composeApp:jvmTest :composeApp:compileKotlinWasmJs
cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS/android && ./gradlew :app:testDebugUnitTest :app:assembleDebug
```
Expected: all green.

- [ ] **Step 5: Confirm no n8n symbols remain**

Run: `grep -rn "N8nClient\|N8nApi\|n8n.tribetails\|buildN8n\|SendMessageRequest" web/composeApp/src android/app/src | grep -v "/build/"`
Expected: no matches.

- [ ] **Step 6: Checkpoint (no commit).**

---

### Task B3: Repo + config cleanup

**Files:**
- Delete: `create_n8n_workflows.py`, `_workflow_snapshots/` (also removes the leaked Anthropic key from the tree)
- Modify: `AuntieOS_n8n_to_Functions_Migration_Plan.md` (mark DONE, point to this plan + the spec)
- Operator: `.env` (remove `BASEROW_*`, `N8N_*`)

- [ ] **Step 1: Delete stale artifacts**

Run: `cd /Users/sydeast/Documents/TribeTails_Docs/Communication/AuntieOS && rm -f create_n8n_workflows.py && rm -rf _workflow_snapshots __pycache__/create_n8n_workflows.cpython-*.pyc`

- [ ] **Step 2: Mark the old migration plan done**

Edit `AuntieOS_n8n_to_Functions_Migration_Plan.md`: set `**Status:** DONE 2026-06-19` and add a top line: `Executed by docs/superpowers/plans/2026-06-19-n8n-retirement.md. n8n retired; server decommissioned.`

- [ ] **Step 3: Operator action (record, do not perform)**

Note for the operator: remove `BASEROW_*` and `N8N_*` keys from `AuntieOS/.env` (secrets, operator-owned).

- [ ] **Step 4: Checkpoint (no commit).**

---

### Task B4: Decommission the server (operator)

- [ ] **Step 1:** Operator shuts down the Debian box, the Docker n8n stack, and the Cloudflare tunnel for `n8n.tribetails.com`. Record completion. No code action.

---

## Verification matrix (defaults-to-functions criteria)

- Unit: A1 (suppression skip/honor + classification), A2 (payload builder), A5 (VM reply routing).
- Integration/build: A7 (3-platform green + APK), B2 (3-platform green after deletions).
- E2E (prod): A8 Step 2 - Inbox SMS/email reply on web+desktop+android; suppressed-recipient transactional vs one-off behavior.
- Contract: `external_messages` rows carry `transactional`; audit payload carries `transactional`.

## Feature-loss check (must stay green)

generate (Function), broadcast (direct), notifications email/sms/push (direct), one-off outreach send (direct, suppression honored), Inbox/Messaging 1:1 reply (now direct, suppression bypassed transactionally), dossier/411 refresh (reconcile). Nothing dropped.
