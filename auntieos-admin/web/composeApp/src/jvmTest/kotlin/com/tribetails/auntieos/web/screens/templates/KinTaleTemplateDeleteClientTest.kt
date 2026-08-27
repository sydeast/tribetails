package com.tribetails.auntieos.web.screens.templates

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull

/**
 * ISSUE #616: the desktop admin's KinTale template delete removes the document.
 *
 * WHAT THIS GUARDS. The jvm actual used to be
 * `patchFields("kintale_templates", id, {"deleted": true})`, a soft-delete flag
 * nothing in the repo reads — not `api/kinTaleTemplates.ts`, not
 * `TemplateService.kt`, not Android's `TemplateRepository.kt`. So the press
 * reported success, the row survived, and the template kept appearing in every
 * picker on every client. `KinTaleTemplateDiff.kt` had already written the
 * symptom down in prose ("a desktop-deleted template is still listed on the
 * phone") without anything firing on it.
 *
 * #577 fixed exactly this in the two media deletes eleven lines above the one
 * this pins, and missed this one. The test is here so a third miss cannot be
 * silent.
 *
 * WHY A HARD DELETE IS RIGHT HERE, where #577's answer was a callable:
 * `media_files` has `deleteMediaFile`, which also clears a profile photo still
 * pointing at the file and writes the audit entry, so only the callable holds
 * the whole operation. `kintale_templates` has no callable at all — see
 * `api/kinTaleTemplatesWrite.ts`, and `allow write: if isAuntie()` in
 * firestore.rules, which covers delete. Android has always issued a plain
 * client delete against this collection. Desktop now matches it.
 *
 * HOW IT ASSERTS WITHOUT A NETWORK. `JvmFirestoreRest` records the write it was
 * asked to perform on `JvmFirestoreFixtures.lastWrite` before it fetches an auth
 * token. No token exists under test, so the call returns false and never leaves
 * the process — but the intent is captured, and the intent is the thing #616 was
 * about. jvm IS the desktop target (#513 retired wasm), so this is the shipped
 * path.
 */
class KinTaleTemplateDeleteClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.clear() }

    @Test
    fun deleteIssuesADocumentDeleteAgainstKinTaleTemplates() = runBlocking {
        FirestoreClient().deleteKinTaleTemplate("walk.standard")

        val write = assertNotNull(JvmFirestoreFixtures.lastWrite, "no REST write was attempted")
        assertEquals("DELETE", write.op)
        assertEquals("kintale_templates", write.collection)
        assertEquals("walk.standard", write.id)
    }

    @Test
    fun deleteWritesNoFieldsAtAllAndNeverTheDeadSoftDeleteFlag() = runBlocking {
        FirestoreClient().deleteKinTaleTemplate("walk.standard")

        val write = assertNotNull(JvmFirestoreFixtures.lastWrite)
        // A DELETE carries no field set. Naming `deleted` specifically because
        // that is the flag whose write was the whole bug: it is not enough that
        // the operation changed, the dead field must be gone from the wire.
        assertEquals(emptySet(), write.fields)
        assertFalse("deleted" in write.fields)
    }

    @Test
    fun aDeleteWithoutCredentialsFailsLoudRatherThanReportingSuccess() = runBlocking {
        // No auth token under test, so the REST call cannot be made. The old
        // implementation would have reported `Err` here too — but for the wrong
        // reason, and its SUCCESS path was the lie. This pins that the failure
        // path stays honest now that the success path is real.
        val result = FirestoreClient().deleteKinTaleTemplate("walk.standard")
        assertFalse(result is WriteResult.Ok<Unit>)
    }
}
