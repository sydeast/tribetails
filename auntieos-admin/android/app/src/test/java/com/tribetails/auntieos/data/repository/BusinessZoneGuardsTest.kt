package com.tribetails.auntieos.data.repository
import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.model.TimeSlotSource
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.TimeZone
/**
 * #1127: the busy-import guard and the closed-day guard (#1119) read one bare
 * wall-clock visit the same way, in the business zone, on any phone. Every case
 * here sets the PHONE to America/Los_Angeles and the business to
 * America/Chicago. The same bare 23:30 on Jul 4 is 04:30Z Jul 5 read in Chicago
 * and 06:30Z Jul 5 read in Los Angeles, so a guard reading the phone's zone
 * misses a busy block and a closure that the other guard catches.
 */
class BusinessZoneGuardsTest {
    private lateinit var savedZone: TimeZone
    @Before fun phoneIsInLosAngeles() {
        savedZone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"))
    }
    @After fun restorePhoneZone() = TimeZone.setDefault(savedZone)
    // 23:30 CDT on Jul 4, bare (no zone), written by an operator on business time.
    private val bareStart = "2026-07-04T23:30:00"
    private val bareEnd = "2026-07-05T00:30:00"
    private fun mockSlots(firestore: FirebaseFirestore, rows: List<BookingTimeSlot>) {
        val collection = mockk<CollectionReference>()
        val q1 = mockk<Query>()
        val q2 = mockk<Query>()
        val q3 = mockk<Query>()
        val snapshot = mockk<QuerySnapshot>()
        every { firestore.collection("booking_time_slots") } returns collection
        every { collection.whereGreaterThanOrEqualTo("date", any<String>()) } returns q1
        every { q1.whereLessThanOrEqualTo("date", any<String>()) } returns q2
        every { q2.limit(any()) } returns q3
        every { q3.get() } returns Tasks.forResult(snapshot)
        every { snapshot.toObjects(BookingTimeSlot::class.java) } returns rows
    }
    private fun mockSettings(firestore: FirebaseFirestore, holidays: List<String>?, timeZone: String?) {
        val docRef = mockk<DocumentReference>()
        val snapshot = mockk<DocumentSnapshot>()
        every { firestore.document("business_settings/business_settings") } returns docRef
        every { docRef.get() } returns Tasks.forResult(snapshot)
        every { snapshot.get("companyHolidays") } returns holidays
        every { snapshot.get("timeZone") } returns timeZone
    }
    /** 04:00Z to 05:00Z Jul 5 is 23:00 to 24:00 CDT Jul 4: it overlaps the visit in Chicago, and misses it (06:30Z) in Los Angeles. */
    private val busy = BookingTimeSlot(
        id = "gbi-1", date = "2026-07-05", startTime = "04:00", endTime = "05:00",
        source = TimeSlotSource.GOOGLE_BUSY_IMPORT,
    )
    private fun repo(firestore: FirebaseFirestore) =
        BookingRepository(firestore = firestore, functions = mockk<FirebaseFunctions>(relaxed = true))
    private fun booking(start: String, end: String) =
        EnhancedBooking(id = "", kinfolkId = "kf1", startDateTime = start, endDateTime = end)
    @Test
    fun `busy check reads a bare visit in the business zone, not the phone's`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockSlots(firestore, listOf(busy))
        mockSettings(firestore, null, "America/Chicago")
        val result = repo(firestore).createBooking(booking(bareStart, bareEnd))
        assertTrue(result.exceptionOrNull()?.message ?: "wrote through", result.exceptionOrNull()!!.message!!.contains("Google Calendar busy block"))
    }
    @Test
    fun `closed-day check reads the same bare visit as Jul 4 in the business zone`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockSlots(firestore, emptyList())
        mockSettings(firestore, listOf("2026-07-04|Independence Day"), "America/Chicago")
        val result = repo(firestore).createBooking(booking(bareStart, bareEnd))
        // Read in the phone's zone this is Jul 5 in Chicago and the closure would be missed.
        assertTrue(result.exceptionOrNull()?.message ?: "wrote through", result.exceptionOrNull()!!.message!!.contains("Independence Day"))
    }
    @Test
    fun `a blank business zone reads the visit in America-Chicago for the busy check, not UTC`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockSlots(firestore, listOf(busy))
        mockSettings(firestore, null, null)
        val result = repo(firestore).createBooking(booking(bareStart, bareEnd))
        // Read as UTC the visit would be 23:30Z Jul 4 and miss the 04:00Z block.
        assertTrue(result.exceptionOrNull()?.message ?: "wrote through", result.exceptionOrNull()!!.message!!.contains("Google Calendar busy block"))
    }
}
