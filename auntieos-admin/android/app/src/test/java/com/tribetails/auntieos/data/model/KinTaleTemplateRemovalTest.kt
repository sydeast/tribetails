package com.tribetails.auntieos.data.model
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
class KinTaleTemplateRemovalTest {
    private fun usage(
        kintaleCount: Int = 0,
        isDefault: Boolean = false,
        others: Int = 2,
    ) = KinTaleTemplateUsage("t1", true, "Dog walk recap", isDefault, true, kintaleCount, others)
    @Test
    fun nothingDependingOnTheTemplateSaysNothing() {
        assertTrue(kinTaleTemplateRemovalImpact(usage()).isEmpty())
    }
    @Test
    fun namesTheKinTalesThatUseItSingularAndPlural() {
        assertTrue(kinTaleTemplateRemovalImpact(usage(kintaleCount = 1)).first().startsWith("1 KinTale was written from it"))
        assertTrue(kinTaleTemplateRemovalImpact(usage(kintaleCount = 3)).first().startsWith("3 KinTales were written from it"))
    }
    @Test
    fun saysWhatLosingTheDefaultMeans() {
        assertTrue(kinTaleTemplateRemovalImpact(usage(isDefault = true)).first().contains("default template"))
        assertTrue(kinTaleTemplateRemovalImpact(usage(isDefault = true, others = 0)).first().contains("only active one"))
    }
    @Test
    fun decodesTheCallablePayload() {
        val u = parseKinTaleTemplateUsage(
            mapOf(
                "templateId" to "t1", "exists" to true, "name" to "Dog walk recap", "isDefault" to true,
                "isActive" to false, "kintaleCount" to 4L, "otherActiveTemplateCount" to 1.0,
            ),
        )
        assertEquals(KinTaleTemplateUsage("t1", true, "Dog walk recap", true, false, 4, 1), u)
    }
    @Test
    fun anEmptyPayloadReadsAsNothingUsesIt() {
        val u = parseKinTaleTemplateUsage(emptyMap())
        assertEquals(0, u.kintaleCount)
        assertTrue(!u.exists)
    }
}
