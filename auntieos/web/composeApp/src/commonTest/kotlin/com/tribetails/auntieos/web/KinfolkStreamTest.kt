package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kinfolk
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

/**
 * Tests for the kinfolk stream state machine as emitted by [FakeAuntieDataSource].
 * Covers Loading → Data, Loading → Error, empty list, multiple kinfolk, and field integrity.
 */
class KinfolkStreamTest {

    @Test
    fun kinfolkStream_initialState_isLoading() = runTest {
        val ds = FakeAuntieDataSource()
        assertIs<FirestoreResult.Loading>(ds.kinfolkStream().first())
    }

    @Test
    fun kinfolkStream_emptyData_noError() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKinfolk(FirestoreResult.Data(emptyList()))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Data<List<Kinfolk>>>(result)
        assertEquals(0, result.value.size)
    }

    @Test
    fun kinfolkStream_populatedList_hasCorrectCount() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKinfolk(FirestoreResult.Data(TestData.kinfolkList))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Data<List<Kinfolk>>>(result)
        assertEquals(2, result.value.size)
    }

    @Test
    fun kinfolkStream_data_containsCorrectIds() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKinfolk(FirestoreResult.Data(TestData.kinfolkList))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Data<List<Kinfolk>>>(result)

        val ids = result.value.map { it._id }
        assertEquals(true, ids.contains(TestData.kinfolk1._id))
        assertEquals(true, ids.contains(TestData.kinfolk2._id))
    }

    @Test
    fun kinfolkStream_data_preservesFieldValues() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKinfolk(FirestoreResult.Data(listOf(TestData.kinfolk1)))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Data<List<Kinfolk>>>(result)

        val kf = result.value.first()
        assertEquals("kf-1", kf._id)
        assertEquals("Rosa", kf.firstName)
        assertEquals("Parks", kf.lastName)
        assertEquals("rosa@parks.example", kf.email)
        assertEquals("active", kf.status)
    }

    @Test
    fun kinfolkStream_error_surfacesMessage() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKinfolk(FirestoreResult.Error("Firestore unavailable"))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Error>(result)
        assertEquals("Firestore unavailable", result.message)
    }

    @Test
    fun kinfolkStream_errorMessageIsNotBlank() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKinfolk(FirestoreResult.Error("permission denied"))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Error>(result)
        assertEquals(false, result.message.isBlank(), "Error message must not be blank")
    }

    @Test
    fun kinfolkStream_transitionsFromLoadingToData() = runTest {
        val ds = FakeAuntieDataSource()
        assertIs<FirestoreResult.Loading>(ds.kinfolkStream().first())

        ds.emitKinfolk(FirestoreResult.Data(TestData.kinfolkList))
        assertIs<FirestoreResult.Data<*>>(ds.kinfolkStream().first())
    }

    @Test
    fun kinfolkStream_transitionsFromLoadingToError() = runTest {
        val ds = FakeAuntieDataSource()
        assertIs<FirestoreResult.Loading>(ds.kinfolkStream().first())

        ds.emitKinfolk(FirestoreResult.Error("network failure"))
        assertIs<FirestoreResult.Error>(ds.kinfolkStream().first())
    }

    @Test
    fun kinfolkStream_displayName_isComputedFromFirstAndLastName() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitKinfolk(FirestoreResult.Data(listOf(TestData.kinfolk1)))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Data<List<Kinfolk>>>(result)

        val kf = result.value.first()
        assertEquals("Rosa Parks", kf.displayName)
    }

    @Test
    fun kinfolkStream_displayName_fallbackWhenNamesBlank() = runTest {
        val ds = FakeAuntieDataSource()
        val nameless = Kinfolk(_id = "kf-99")
        ds.emitKinfolk(FirestoreResult.Data(listOf(nameless)))

        val result = ds.kinfolkStream().first()
        assertIs<FirestoreResult.Data<List<Kinfolk>>>(result)

        assertEquals("Unnamed Kinfolk", result.value.first().displayName)
    }
}
