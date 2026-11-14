package com.tribetails.auntieos.web.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * #2058, operator ruling 2026-11-12 (stamp at send): the console sends through
 * the `sendKinTaleReport` callable, which stamps the tale's own copy of its care
 * tasks in the same write, and a SENT tale renders off that copy, so a template
 * edited or deleted afterwards never changes it.
 */
class KinTaleSentCareTasksTest {
    @AfterTest fun tearDown() { JvmFirestoreFixtures.clear() }

    private val copy = CareTaskCopy(
        v = 1,
        templateId = "tpl-walk",
        templateName = "Dog Walk",
        source = "template",
        items = listOf(
            ChecklistItem(key = "moment_walk", text = "Long walk in the park", scope = "PER_PET", order = 0),
            ChecklistItem(key = "moment_mail", text = "Brought the mail in", scope = "PER_VISIT", order = 1),
        ),
        done = listOf(CareTaskDone(key = "moment_walk", kinId = "dog1", text = "Long walk in the park")),
    )

    private val sentTale = KinCareReport(
        _id = "r1",
        sessionId = "s1",
        kinfolkId = "kf1",
        templateId = "tpl-walk",
        kinIds = listOf("dog1"),
        status = "SENT",
        sentAt = "2026-11-12T10:00:00Z",
        fieldResponses = mapOf(
            "dog1|moment_walk" to FieldResponse(fieldKey = "moment_walk", kinId = "dog1", boolValue = true),
            "moment_mail" to FieldResponse(fieldKey = "moment_mail", kinId = "", boolValue = true),
        ),
        careTasks = copy,
    )

    @Test fun aSentTaleRendersItsOwnCopyAfterTheTemplateIsDeleted() {
        // The template is gone, so the stream falls back to the built-in.
        val shown = DefaultKinTaleTemplate.template.forKinTale(sentTale)
        val resolved = resolveSentChecklist(shown, sentTale, mapOf("dog1" to Kin(_id = "dog1")))
        assertEquals(listOf("Long walk in the park"), resolved.perKin.single().items.map { it.label })
        assertEquals(listOf("Brought the mail in"), resolved.perVisit.map { it.label })
    }

    @Test fun anEditedTemplateDoesNotRelabelASentTale() {
        val renamed = KinTaleTemplate(
            _id = "tpl-walk",
            name = "Dog Walk",
            checklistItems = listOf(ChecklistItem(key = "moment_walk", text = "Renamed later")),
        )
        assertEquals(
            listOf("Long walk in the park", "Brought the mail in"),
            renamed.forKinTale(sentTale).checklistItems.map { it.text },
        )
    }

    @Test fun aDraftAndAnUnstampedTaleFollowTheTemplate() {
        val tpl = DefaultKinTaleTemplate.template
        assertSame(tpl, tpl.forKinTale(sentTale.copy(status = "DRAFT", sentAt = "")))
        assertSame(tpl, tpl.forKinTale(sentTale.copy(careTasks = null)))
        assertSame(tpl, tpl.forKinTale(sentTale.copy(careTasks = copy.copy(v = 2))))
    }

    @Test fun theCopyDecodesOffTheStoredDocument() {
        val json = Json { ignoreUnknownKeys = true; isLenient = true }
        val decoded = json.decodeFromString(
            KinCareReport.serializer(),
            """{"status":"SENT","careTasks":{"v":1,"templateName":"Dog Walk","items":[{"key":"a","text":"A","order":0}],"done":[{"key":"a","kinId":"","text":"A","note":""}],"futureField":true}}""",
        )
        assertEquals("A", decoded.careTasks!!.items.single().text)
        assertNull(json.decodeFromString(KinCareReport.serializer(), """{"status":"DRAFT"}""").careTasks)
    }

    @Test fun theSendGoesThroughTheCallable() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "sendKinTaleReport" to """{"ok":true,"reportId":"r1","alreadySent":false}""",
        )
        val r = FirestoreClient().markKinTaleReportSent("r1", "s1", "pending", "")
        assertEquals(WriteResult.Ok(Unit), r)
        assertEquals("sendKinTaleReport", JvmFirestoreFixtures.lastCallableName)
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("r1", sent["reportId"]?.jsonPrimitive?.content)
        assertEquals("pending", sent["sentVia"]?.jsonPrimitive?.content)
    }

    @Test fun aRefusedSendSurfacesTheServersWords() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf(
            "sendKinTaleReport" to "The visit this KinTale belongs to no longer exists.",
        )
        val r = FirestoreClient().markKinTaleReportSent("r1", "s1", "pending", "")
        assertTrue(r is WriteResult.Err)
        assertTrue((r as WriteResult.Err).message.contains("no longer exists"))
    }

    @Test fun aBlankIdNeverReachesTheServer() = runBlocking {
        val r = FirestoreClient().markKinTaleReportSent("", "s1", "pending", "")
        assertTrue(r is WriteResult.Err)
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }
}
