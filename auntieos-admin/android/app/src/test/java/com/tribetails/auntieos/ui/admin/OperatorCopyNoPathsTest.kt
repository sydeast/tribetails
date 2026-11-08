package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * #1592: Feature Flags and Template Routing printed database paths
 * (`business_settings/feature_flags`, `emailTemplates/<id>`) and a function name
 * (`listCatalogKeys`) as standing copy. None of it is the operator's to read.
 */
class OperatorCopyNoPathsTest {

    private val developerMarks = listOf("business_settings", "auntieos.", "Templates/", "listCatalogKeys", ".ts")

    private fun assertOperatorCopy(text: String) {
        developerMarks.forEach { mark -> assertFalse("\"$text\" carries \"$mark\"", text.contains(mark)) }
    }

    @Test fun featureFlagsHeadingNamesNoPathOrPrefix() {
        assertOperatorCopy(FEATURE_FLAGS_SUBTITLE)
    }

    @Test fun templateRoutingCopyNamesNoPathOrFunction() {
        assertOperatorCopy(TEMPLATE_MISSING_LINE)
        assertOperatorCopy(ROUTING_TABLE_EMPTY)
        assertOperatorCopy(overrideDialogHint())
    }
}
