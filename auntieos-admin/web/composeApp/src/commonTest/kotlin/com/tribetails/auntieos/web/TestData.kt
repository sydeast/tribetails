package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk

/**
 * Shared canonical test data used across all AuntieOS test suites.
 * All field names match the production data class definitions exactly.
 */
object TestData {

    // ---- Invoices ----

    val invoice1 = Invoice(
        _id = "inv-1",
        kinfolkId = "kf-1",
        kinfolkName = "Rosa Parks",
        invoiceNumber = "INV-001",
        total = 120.0,
        amountDue = 120.0,
        status = "outstanding",
        dueDate = "2026-06-01",
    )

    val invoice2 = Invoice(
        _id = "inv-2",
        kinfolkId = "kf-1",
        kinfolkName = "Rosa Parks",
        invoiceNumber = "INV-002",
        total = 80.0,
        amountDue = 0.0,
        status = "paid",
        dueDate = "2026-05-01",
    )

    val invoice3 = Invoice(
        _id = "inv-3",
        kinfolkId = "kf-2",
        kinfolkName = "Harriet Tubman",
        invoiceNumber = "INV-003",
        total = 200.0,
        amountDue = 50.0,
        status = "partial",
        dueDate = "2026-07-15",
    )

    val invoices = listOf(invoice1, invoice2, invoice3)

    // ---- Kinfolk ----

    val kinfolk1 = Kinfolk(
        _id = "kf-1",
        firstName = "Rosa",
        lastName = "Parks",
        phoneNumber = "555-0101",
        email = "rosa@parks.example",
        status = "active",
        outstandingBalance = "120.00",
    )

    val kinfolk2 = Kinfolk(
        _id = "kf-2",
        firstName = "Harriet",
        lastName = "Tubman",
        phoneNumber = "555-0202",
        email = "harriet@tubman.example",
        status = "active",
        outstandingBalance = "50.00",
    )

    val kinfolkList = listOf(kinfolk1, kinfolk2)

    // ---- KinCare Sessions ----

    val sessionDraft1 = KinCareSession(
        _id = "sess-1",
        kinfolkId = "kf-1",
        kinfolkName = "Rosa Parks",
        status = "DRAFT",
        serviceType = "Dog Walking",
        startTime = "2026-06-01T09:00:00Z",
        endTime = "2026-06-01T10:00:00Z",
    )

    val sessionScheduled1 = KinCareSession(
        _id = "sess-2",
        kinfolkId = "kf-2",
        kinfolkName = "Harriet Tubman",
        status = "SCHEDULED",
        serviceType = "Pet Sitting",
        startTime = "2026-06-02T14:00:00Z",
        endTime = "2026-06-02T18:00:00Z",
    )

    val sessionCompleted1 = KinCareSession(
        _id = "sess-3",
        kinfolkId = "kf-1",
        kinfolkName = "Rosa Parks",
        status = "COMPLETED",
        serviceType = "Dog Walking",
        startTime = "2026-05-25T08:00:00Z",
        endTime = "2026-05-25T09:00:00Z",
        arrivedAt = "2026-05-25T08:05:00Z",
        departedAt = "2026-05-25T09:02:00Z",
        completedAt = "2026-05-25T09:05:00Z",
    )

    val sessions = listOf(sessionDraft1, sessionScheduled1, sessionCompleted1)

    // ---- Business Settings ----

    val businessSettings = BusinessSettings(
        _id = "settings-1",
        businessName = "TribeTails Pet Care",
        businessEmail = "hello@tribetails.example",
        businessPhone = "555-9000",
        businessAddress = "123 Main St, Atlanta, GA 30301",
        serviceRates = mapOf("Dog Walking" to "25.00", "Pet Sitting" to "50.00"),
        updatedAt = "2026-05-01T12:00:00Z",
    )

    val businessSettingsUpdated = BusinessSettings(
        _id = "settings-1",
        businessName = "TribeTails Premium Pet Care",
        businessEmail = "info@tribetails.example",
        businessPhone = "555-9001",
        businessAddress = "456 Oak Ave, Atlanta, GA 30302",
        serviceRates = mapOf("Dog Walking" to "30.00", "Pet Sitting" to "60.00"),
        updatedAt = "2026-05-07T12:00:00Z",
    )
}
