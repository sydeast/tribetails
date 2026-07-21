package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.TrainingDocAttachment
import com.tribetails.auntieos.web.data.TrainingDocument
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.screens.trainingdocs.TrainingDocsDataSource
import com.tribetails.auntieos.web.screens.trainingdocs.TrainingDocumentsViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeTrainingDocsDataSource : TrainingDocsDataSource {
    private val _docs = MutableStateFlow<FirestoreResult<List<TrainingDocument>>>(FirestoreResult.Loading)
    fun emit(result: FirestoreResult<List<TrainingDocument>>) { _docs.value = result }
    override fun trainingDocsStream(): Flow<FirestoreResult<List<TrainingDocument>>> = _docs.asStateFlow()

    var kinfolk: List<Kinfolk> = emptyList()
    var kinForKinfolk: Map<String, List<Kin>> = emptyMap()
    var uploadResult: WriteResult<MediaFile> = WriteResult.Ok(MediaFile(storageUrl = "https://res.cloudinary.com/x/a.jpg", cloudinaryPublicId = "x/a", fileType = "IMAGE", mimeType = "image/jpeg", originalFileName = "a.jpg"))
    var createResult: WriteResult<String> = WriteResult.Ok("new1")
    var updateResult: WriteResult<Unit> = WriteResult.Ok(Unit)
    var deleteResult: WriteResult<Unit> = WriteResult.Ok(Unit)

    var lastCreateTargetType: String? = null
    var lastCreateKinfolkId: String? = null
    var lastCreateKinId: String? = null
    var lastDeletedId: String? = null

    override fun kinfolkStream(): Flow<FirestoreResult<List<Kinfolk>>> = flowOf(FirestoreResult.Data(kinfolk))
    override fun kinStream(kinfolkId: String): Flow<FirestoreResult<List<Kin>>> =
        flowOf(FirestoreResult.Data(kinForKinfolk[kinfolkId] ?: emptyList()))

    override suspend fun uploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String) = uploadResult

    override suspend fun createTrainingDocument(
        title: String, content: String, notes: String, communicationType: String,
        targetType: String, targetKinfolkId: String, targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
    ): WriteResult<String> {
        lastCreateTargetType = targetType
        lastCreateKinfolkId = targetKinfolkId
        lastCreateKinId = targetKinId
        return createResult
    }

    override suspend fun updateTrainingDocument(
        docId: String, title: String, content: String, notes: String, communicationType: String,
        targetType: String, targetKinfolkId: String, targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
    ): WriteResult<Unit> = updateResult

    override suspend fun deleteTrainingDocument(docId: String): WriteResult<Unit> {
        lastDeletedId = docId
        return deleteResult
    }
}

class TrainingDocumentsViewModelTest {

    @Test
    fun `loads training documents from data source`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        ds.emit(FirestoreResult.Data(listOf(
            TrainingDocument(_id = "1", title = "Doc A"),
            TrainingDocument(_id = "2", title = "Doc B"),
        )))
        assertEquals(2, vm.uiState.value.displayedDocs.size)
    }

    @Test
    fun `search filters by title`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        ds.emit(FirestoreResult.Data(listOf(
            TrainingDocument(_id = "1", title = "Alpha Guide"),
            TrainingDocument(_id = "2", title = "Beta Manual"),
        )))
        vm.search("Alpha")
        assertEquals(1, vm.uiState.value.displayedDocs.size)
        assertEquals("Alpha Guide", vm.uiState.value.displayedDocs[0].title)
    }

    @Test
    fun `search filters by communicationType`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        ds.emit(FirestoreResult.Data(listOf(
            TrainingDocument(_id = "1", title = "Doc A", communicationType = "sms"),
            TrainingDocument(_id = "2", title = "Doc B", communicationType = "email"),
        )))
        vm.search("email")
        assertEquals(1, vm.uiState.value.displayedDocs.size)
        assertEquals("Doc B", vm.uiState.value.displayedDocs[0].title)
    }

    @Test
    fun `search blank shows all`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        ds.emit(FirestoreResult.Data(listOf(
            TrainingDocument(_id = "1", title = "Doc A"),
            TrainingDocument(_id = "2", title = "Doc B"),
        )))
        vm.search("some query")
        vm.search("")
        assertEquals(2, vm.uiState.value.displayedDocs.size)
    }

    @Test
    fun `isLoading true while stream not yet emitting Data`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        assertTrue(vm.uiState.value.isLoading)
        assertTrue(vm.uiState.value.displayedDocs.isEmpty())
    }

    @Test
    fun `error state set on FirestoreResult Error`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        ds.emit(FirestoreResult.Error("boom"))
        assertFalse(vm.uiState.value.isLoading)
        assertNotNull(vm.uiState.value.errorMessage)
        assertEquals("boom", vm.uiState.value.errorMessage)
    }

    // ---- Tribal Intel write tool (spec 23) ----

    @Test
    fun `cannot save without a target`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        vm.updateDraft { it.copy(content = "intel") }
        assertFalse(vm.uiState.value.draft.canSave)
        vm.saveDraft()
        assertNotNull(vm.uiState.value.errorMessage)
        assertNull(ds.lastCreateTargetType)  // no callable hit
    }

    @Test
    fun `cannot save KIN target without a pet selected`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        vm.updateDraft { it.copy(content = "intel", targetType = "KIN", selectedKinfolkId = "kf1") }
        assertFalse(vm.uiState.value.draft.canSave)
    }

    @Test
    fun `createDoc success sets queued state and clears draft`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        vm.updateDraft { it.copy(content = "Side gate is 4321", selectedKinfolkId = "kf1") }
        vm.saveDraft()
        val s = vm.uiState.value
        assertNull(s.errorMessage)
        assertNotNull(s.queuedMessage)
        assertTrue(s.queuedMessage!!.contains("reconcile", ignoreCase = true))
        assertEquals("", s.draft.content)
        assertEquals("KINFOLK", ds.lastCreateTargetType)
        assertEquals("kf1", ds.lastCreateKinfolkId)
        assertNull(ds.lastCreateKinId)
    }

    @Test
    fun `KIN target passes selected kin id to callable`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        ds.kinForKinfolk = mapOf("kf1" to listOf(Kin(_id = "k1", name = "Rex")))
        val vm = TrainingDocumentsViewModel(ds)
        vm.selectKinfolk("kf1")
        vm.updateDraft { it.copy(content = "allergy", targetType = "KIN", selectedKinId = "k1") }
        vm.saveDraft()
        assertEquals("KIN", ds.lastCreateTargetType)
        assertEquals("k1", ds.lastCreateKinId)
    }

    @Test
    fun `createDoc error surfaces fail-loud message`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        ds.createResult = WriteResult.Err("permission-denied")
        val vm = TrainingDocumentsViewModel(ds)
        vm.updateDraft { it.copy(content = "intel", selectedKinfolkId = "kf1") }
        vm.saveDraft()
        assertEquals("permission-denied", vm.uiState.value.errorMessage)
        assertNull(vm.uiState.value.queuedMessage)
    }

    @Test
    fun `attach upload failure surfaces error and adds no attachment`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        ds.uploadResult = WriteResult.Err("Admin sign-in required before media upload")
        val vm = TrainingDocumentsViewModel(ds)
        vm.attachFile(ByteArray(0), "", "")
        assertTrue(vm.uiState.value.draft.attachments.isEmpty())
        assertNotNull(vm.uiState.value.errorMessage)
    }

    @Test
    fun `attach upload success adds an attachment`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        vm.attachFile(ByteArray(0), "image/jpeg", "a.jpg")
        assertEquals(1, vm.uiState.value.draft.attachments.size)
        assertEquals("x/a", vm.uiState.value.draft.attachments[0].cloudinaryPublicId)
    }

    @Test
    fun `delete routes the doc id to the callable`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        vm.deleteDoc("d9")
        assertEquals("d9", ds.lastDeletedId)
    }

    @Test
    fun `editing prefills the draft and switches to update`() = runTest {
        val ds = FakeTrainingDocsDataSource()
        val vm = TrainingDocumentsViewModel(ds)
        vm.startEdit(TrainingDocument(_id = "d1", content = "old", targetType = "KINFOLK", targetKinfolkId = "kf1"))
        assertEquals("d1", vm.uiState.value.draft.editingId)
        assertEquals("old", vm.uiState.value.draft.content)
        vm.saveDraft()
        // update path used (create not hit)
        assertNull(ds.lastCreateTargetType)
    }
}
