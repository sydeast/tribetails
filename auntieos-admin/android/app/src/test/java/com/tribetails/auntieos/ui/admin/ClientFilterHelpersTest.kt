package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.FormSchemaSummary
import com.tribetails.auntieos.data.model.TrainingDocAttachment
import com.tribetails.auntieos.data.model.TrainingDocument
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.admin.formschemas.formSchemaDeleteErrorMessage
import com.tribetails.auntieos.ui.admin.formschemas.formSchemaDeleteTargetLabel
import com.tribetails.auntieos.ui.admin.formschemas.formSchemaSearchFilter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper coverage for the client-side filters/echoes wired into the Android
 * admin screens (mirroring the web counterparts). These narrow only the already
 * loaded list / echo only a genuine override; no server search exists.
 */
class ClientFilterHelpersTest {

    // ── Template Bank search ────────────────────────────────────────────────
    private fun tpl(id: String, title: String) = TemplateRepository.EmailTemplate(
        templateId = id, subject = "", body = "", html = null,
        title = title, description = null, tags = emptyList(), category = null,
    )

    private val templates = listOf(
        tpl("booking.confirmed", "Booking confirmed"),
        tpl("invoice.sent", "Invoice is ready"),
        tpl("kintale.ready", "Your KinTale"),
    )

    @Test fun templateBank_blankQueryReturnsAll() {
        assertEquals(templates, templateBankSearchFilter(templates, "   "))
    }

    @Test fun templateBank_matchesTitleAndKeyCaseInsensitive() {
        assertEquals(listOf(templates[0]), templateBankSearchFilter(templates, "BOOKING"))
        assertEquals(listOf(templates[1]), templateBankSearchFilter(templates, "invoice"))
        assertEquals(listOf(templates[2]), templateBankSearchFilter(templates, "kintale"))
    }

    @Test fun templateBank_nonMatchIsEmpty() {
        assertEquals(emptyList<TemplateRepository.EmailTemplate>(), templateBankSearchFilter(templates, "zzz-nope"))
    }

    // ── FormSchema list search ──────────────────────────────────────────────
    private fun schema(id: String, name: String) = FormSchemaSummary(
        id = id, name = name, version = 1, updatedAt = "", updatedBy = "",
    )

    private val schemas = listOf(
        schema("intake-kin", "Kin intake"),
        schema("vet-history", "Vet history"),
    )

    @Test fun formSchema_blankQueryReturnsAll() {
        assertEquals(schemas, formSchemaSearchFilter(schemas, ""))
    }

    @Test fun formSchema_matchesNameOrIdCaseInsensitive() {
        assertEquals(listOf(schemas[0]), formSchemaSearchFilter(schemas, "INTAKE"))
        assertEquals(listOf(schemas[1]), formSchemaSearchFilter(schemas, "vet"))
    }

    @Test fun formSchema_nonMatchIsEmpty() {
        assertEquals(emptyList<FormSchemaSummary>(), formSchemaSearchFilter(schemas, "qqq"))
    }

    // ── Row-delete confirm / error helpers ──────────────────────────────────
    @Test fun formSchemaDelete_targetLabelPrefersName() {
        assertEquals("Kin intake", formSchemaDeleteTargetLabel(schema("intake-kin", "Kin intake")))
    }

    @Test fun formSchemaDelete_targetLabelFallsBackToIdWhenNameBlank() {
        assertEquals("intake-kin", formSchemaDeleteTargetLabel(schema("intake-kin", "")))
    }

    @Test fun formSchemaDelete_errorMessageCarriesCause() {
        val msg = formSchemaDeleteErrorMessage("Kin intake", RuntimeException("permission-denied"))
        assertTrue(msg.contains("Kin intake"))
        assertTrue(msg.contains("permission-denied"))
    }

    @Test fun formSchemaDelete_errorMessageFallsBackToClassNameWhenBlank() {
        val msg = formSchemaDeleteErrorMessage("vet-history", RuntimeException())
        assertTrue(msg.contains("vet-history"))
        assertTrue(msg.contains("RuntimeException"))
    }

    // ── Training docs comm-type filter ──────────────────────────────────────
    private val docs = listOf(
        TrainingDocument(id = "a", title = "A", communicationType = "Email"),
        TrainingDocument(id = "b", title = "B", communicationType = "SMS"),
        TrainingDocument(id = "c", title = "C", communicationType = "Email"),
    )

    @Test fun trainingDocs_nullSelectionReturnsAll() {
        assertEquals(docs, trainingDocsCommTypeFilter(docs, null))
    }

    @Test fun trainingDocs_keepsOnlyExactCommType() {
        assertEquals(listOf(docs[0], docs[2]), trainingDocsCommTypeFilter(docs, "Email"))
        assertEquals(listOf(docs[1]), trainingDocsCommTypeFilter(docs, "SMS"))
    }

    @Test fun trainingDocs_unknownCommTypeIsEmpty() {
        assertEquals(emptyList<TrainingDocument>(), trainingDocsCommTypeFilter(docs, "Push"))
    }

    // ── Tribal Intel junk-row filter ────────────────────────────────────────
    @Test fun trainingDocs_dropsRowsWithNoTitleNoContentNoAttachment() {
        val real = TrainingDocument(id = "real", title = "Gate code", content = "")
        val junk = TrainingDocument(id = "junk", title = "", content = "")
        assertEquals(listOf(real), dropEmptyTrainingDocs(listOf(real, junk)))
    }
    @Test fun trainingDocs_treatsWhitespaceOnlyTextAsEmpty() {
        val junk = TrainingDocument(id = "junk", title = "   ", content = "\n")
        assertEquals(emptyList<TrainingDocument>(), dropEmptyTrainingDocs(listOf(junk)))
    }
    @Test fun trainingDocs_keepsAnAttachmentOnlyRow() {
        // The deployed callable accepts "title OR content OR at least one
        // attachment", so a photo-only entry is a legitimately saved one.
        val photoOnly = TrainingDocument(
            id = "photo",
            title = "",
            content = "",
            attachments = listOf(
                TrainingDocAttachment(
                    storageUrl = "https://res.cloudinary.com/x/image/upload/v1/a.jpg",
                    cloudinaryPublicId = "a",
                    fileType = "IMAGE",
                    mimeType = "image/jpeg",
                    fileName = "a.jpg",
                ),
            ),
        )
        assertEquals(listOf(photoOnly), dropEmptyTrainingDocs(listOf(photoOnly)))
    }
    // ── Template assignment trigger-override echo ───────────────────────────
    @Test fun triggerOverride_nullWhenBlankOrAbsent() {
        assertNull(genuineTriggerOverride(null, "booking.confirmed"))
        assertNull(genuineTriggerOverride("", "booking.confirmed"))
        assertNull(genuineTriggerOverride("   ", "booking.confirmed"))
    }

    @Test fun triggerOverride_nullWhenEqualsCatalogKey() {
        // Server defaults a blank triggerKey to the catalogKey; that is not an override.
        assertNull(genuineTriggerOverride("booking.confirmed", "booking.confirmed"))
    }

    @Test fun triggerOverride_returnsGenuineOverride() {
        assertEquals("custom.trigger", genuineTriggerOverride("custom.trigger", "booking.confirmed"))
    }
}
