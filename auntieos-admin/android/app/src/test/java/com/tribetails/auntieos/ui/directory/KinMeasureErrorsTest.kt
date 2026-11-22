package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.domain.validateKinAge
import com.tribetails.auntieos.domain.validateKinWeight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1851: the message beside Save named Age only when Weight was refused too.
 * `all` is what the Edit kin save shows; `first` stays for the line under the row.
 */
class KinMeasureErrorsTest {
    @Test
    fun `all names both refusals`() {
        val errors = KinMeasureErrors(age = validateKinAge("abc-5"), weight = validateKinWeight("heavy-ish"))
        val all = errors.all!!
        assertTrue(all, all.contains("Age is a number"))
        assertTrue(all, all.contains("Weight is a number"))
    }

    @Test
    fun `all is the one refusal when only one is refused`() {
        val errors = KinMeasureErrors(age = null, weight = validateKinWeight("heavy-ish"))
        assertEquals(errors.weight, errors.all)
    }

    @Test
    fun `all is null when nothing is refused`() {
        assertNull(KinMeasureErrors().all)
    }
}
