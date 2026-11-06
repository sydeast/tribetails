package com.tribetails.auntieos.web.data
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertEquals
import kotlin.test.assertTrue
class KinTaleTemplateRemovalTest {
    @AfterTest fun tearDown() { JvmFirestoreFixtures.clear() }
    @Test fun theEntryPointIssuesADocumentDeleteAgainstKinTaleTemplates() = runBlocking {
        FirestoreClient().removeKinTaleTemplate("walk.standard")
        val write = assertNotNull(JvmFirestoreFixtures.lastWrite, "no REST write was attempted")
        assertEquals("DELETE", write.op)
        assertEquals("kintale_templates", write.collection)
        assertEquals("walk.standard", write.id)
    }
    private fun usage(kintaleCount: Int = 0, isDefault: Boolean = false, others: Int = 2) =
        KinTaleTemplateUsage("t1", true, "Dog walk recap", isDefault, true, kintaleCount, others)
    @Test fun nothingDependingOnTheTemplateSaysNothing() =
        assertTrue(kinTaleTemplateRemovalImpact(usage()).isEmpty())
    @Test fun namesTheKinTalesThatUseItSingularAndPlural() {
        assertTrue(kinTaleTemplateRemovalImpact(usage(kintaleCount = 1)).first().startsWith("1 KinTale was written from it"))
        assertTrue(kinTaleTemplateRemovalImpact(usage(kintaleCount = 3)).first().startsWith("3 KinTales were written from it"))
    }
    @Test fun saysWhatLosingTheDefaultMeans() {
        assertTrue(kinTaleTemplateRemovalImpact(usage(isDefault = true)).first().contains("default template"))
        assertTrue(kinTaleTemplateRemovalImpact(usage(isDefault = true, others = 0)).first().contains("only active one"))
    }
    @Test fun decodesTheCallablePayload() {
        val u = decodeKinTaleTemplateUsage(
            """{"templateId":"t1","exists":true,"name":"Dog walk recap","isDefault":true,"isActive":false,"kintaleCount":4,"otherActiveTemplateCount":1}""",
        )
        assertEquals(KinTaleTemplateUsage("t1", true, "Dog walk recap", true, false, 4, 1), u)
    }
    @Test fun anEmptyPayloadReadsAsNothingUsesIt() {
        val u = decodeKinTaleTemplateUsage("{}")
        assertEquals(0, u.kintaleCount)
        assertTrue(!u.exists)
    }
}
