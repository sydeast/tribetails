package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.ui.admin.AdminSettingsViewModel
import com.tribetails.auntieos.ui.admin.DayHoursKind
import com.tribetails.auntieos.ui.admin.WeeklyHoursRow
import com.tribetails.auntieos.ui.admin.services.ServiceManagementViewModel
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1764: the weekly hours have ONE store, `business_settings.businessHours`.
 *
 * Android used to read and write a `business_hours` collection nothing else
 * read, and seeded it with seven default rows on an empty read. These drive the
 * REAL [AuntieRepository] (Firestore and the callable mocked underneath) through
 * both editors' load and save, and check the collection is never named.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BusinessHoursOneStoreTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var firestore: FirebaseFirestore
    private lateinit var functions: FirebaseFunctions
    private val payload = slot<Any>()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        // Relaxed, so any read this test did not stub returns a mock rather than
        // throwing; the verify below is what decides the test.
        firestore = mockk(relaxed = true)
        val collection = mockk<CollectionReference>()
        val doc = mockk<DocumentReference>()
        val snapshot = mockk<DocumentSnapshot>()
        every { firestore.collection("business_settings") } returns collection
        every { collection.document("business_settings") } returns doc
        every { doc.get() } returns Tasks.forResult(snapshot)
        every { snapshot.exists() } returns true
        every { snapshot.toObject(BusinessSettings::class.java) } returns
            BusinessSettings(businessName = "Den", businessHours = mapOf("Monday" to "09:00-17:00"))

        functions = mockk()
        val ref = mockk<HttpsCallableReference>()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { ref.call(capture(payload)) } returns Tasks.forResult(result)
        every { functions.getHttpsCallable("saveBusinessSettings") } returns ref
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun repository(): AuntieRepository {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        return AuntieRepository(
            n8n = mockk<N8nApi>(),
            authGate = gate,
            functionsOverride = functions,
            firestoreProvider = { firestore },
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun sentChanges(): Map<String, Any?> =
        (payload.captured as Map<String, Any?>)["changes"] as Map<String, Any?>

    @Test
    fun `the Settings panel loads and saves without naming business_hours`() = runTest(testDispatcher) {
        val vm = AdminSettingsViewModel(repository = repository())
        vm.loadBusinessSettings()
        advanceUntilIdle()
        assertEquals(DayHoursKind.OPEN, vm.uiState.value.businessHours[0].kind)
        assertEquals(DayHoursKind.NOT_SET, vm.uiState.value.businessHours[1].kind)

        vm.setBusinessHourRow(WeeklyHoursRow(2, DayHoursKind.OPEN, "10:00", "16:00"))
        vm.saveBusinessHours()
        advanceUntilIdle()

        assertTrue(vm.uiState.value.saveSuccess)
        assertEquals(mapOf("businessHours" to mapOf("Tuesday" to "10:00-16:00")), sentChanges())
        verify(exactly = 0) { firestore.collection("business_hours") }
    }

    @Test
    fun `the Services dialog loads and saves without naming business_hours`() = runTest(testDispatcher) {
        val services = mockk<ServiceRepository>()
        coEvery { services.getBaseServices(any()) } returns Result.success(emptyList())
        coEvery { services.getSupplementalServices(any()) } returns Result.success(emptyList())
        coEvery { services.getSurcharges(any()) } returns Result.success(emptyList())
        coEvery { services.getDiscounts(any()) } returns Result.success(emptyList())
        coEvery { services.getPromoCodes(any()) } returns Result.success(emptyList())
        val vm = ServiceManagementViewModel(serviceRepository = services, auntieRepository = repository())
        advanceUntilIdle()

        vm.updateBusinessHours(WeeklyHoursRow(7, DayHoursKind.CLOSED))
        advanceUntilIdle()

        assertEquals(mapOf("businessHours" to mapOf("Sunday" to "")), sentChanges())
        verify(exactly = 0) { firestore.collection("business_hours") }
    }

    @Test
    fun `neither repository has a business_hours reader or writer any more`() {
        val names = (AuntieRepository::class.java.declaredMethods + ServiceRepository::class.java.declaredMethods)
            .map { it.name }
            .filter { it.contains("BusinessHours") }
        assertEquals(emptyList<String>(), names)
    }
}
