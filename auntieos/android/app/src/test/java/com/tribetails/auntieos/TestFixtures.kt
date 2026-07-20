package com.tribetails.auntieos

import com.tribetails.auntieos.data.model.BookingStatus
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.data.model.VisitLog
import com.tribetails.auntieos.data.model.VisitStatus

object TestFixtures {

    val kinfolk1 = Kinfolk(
        id = "kf1",
        firstName = "Rosa",
        lastName = "Parks",
        status = "active",
        phoneNumber = "555-0001",
        email = "rosa@example.com"
    )

    val kinfolk2 = Kinfolk(
        id = "kf2",
        firstName = "Jane",
        lastName = "Doe",
        status = "inactive",
        phoneNumber = "555-0002",
        email = "jane@example.com"
    )

    val allKinfolk = listOf(kinfolk1, kinfolk2)

    val kin1 = Kin(
        id = "kin1",
        name = "Biscuit",
        kinfolkId = "kf1",
        species = "Dog",
        status = "active"
    )

    val kin2 = Kin(
        id = "kin2",
        name = "Whiskers",
        kinfolkId = "kf2",
        species = "Cat",
        status = "active"
    )

    val invoice1 = Invoice(
        id = "inv1",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        total = 120.0,
        amountDue = 120.0,
        status = "Outstanding"
    )

    val invoice2 = Invoice(
        id = "inv2",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        total = 80.0,
        amountDue = 0.0,
        status = "Paid"
    )

    val payment1 = Payment(
        id = "pay1",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        amount = 80.0,
        date = "2026-05-01"
    )

    val visitLog1 = VisitLog(
        id = "vl1",
        kinfolkId = "kf1",
        serviceType = "Dog Walking",
        submitted = "2026-05-01T10:00:00"
    )

    val booking1 = EnhancedBooking(
        id = "b1",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        startDateTime = "2026-06-02T10:00:00",
        endDateTime = "2026-06-02T11:00:00",
        status = BookingStatus.DRAFT
    )

    val booking2 = EnhancedBooking(
        id = "b2",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        startDateTime = "2026-06-03T14:00:00",
        endDateTime = "2026-06-03T15:00:00",
        status = BookingStatus.ACCEPTED
    )

    val session1 = KinCareSession(
        id = "ses1",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        startTime = "2026-06-02T10:00:00",
        endTime = "2026-06-02T11:00:00",
        serviceType = "Dog Walking",
        status = VisitStatus.SCHEDULED.name
    )

    val businessSettings = BusinessSettings(
        enableGPSTrackingForAllVisits = false,
        defaultEtaMinutes = 20
    )

    // Unified settings (2026-06-05): booking config is now part of BusinessSettings.
    val bookingConfigSettings = BusinessSettings(enableConflictDetection = true)

    val draft1 = Draft(
        id = "d1",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        generatedCopy = "What a wonderful visit!",
        status = "pending",
        communicationType = "visit_report"
    )
}
