package com.tribetails.auntieos.web.screens.payments

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakePaymentsDataSource(
    private val recordShouldFail: Boolean = false,
    private val recordFailMessage: String = "write failed",
) : PaymentsDataSource {

    private val _payments = MutableStateFlow<FirestoreResult<List<Payment>>>(FirestoreResult.Loading)

    fun emitPayments(result: FirestoreResult<List<Payment>>) { _payments.value = result }

    override fun paymentsStream(): Flow<FirestoreResult<List<Payment>>> = _payments.asStateFlow()

    override suspend fun recordPayment(payment: Payment): WriteResult<String> {
        if (recordShouldFail) return WriteResult.Err(recordFailMessage)
        val id = "fake-pay-${_payments.value.let { if (it is FirestoreResult.Data) it.value.size else 0 }}"
        val saved = payment.copy(_id = id)
        val current = _payments.value
        val newList = if (current is FirestoreResult.Data) current.value + saved else listOf(saved)
        _payments.value = FirestoreResult.Data(newList)
        return WriteResult.Ok(id)
    }
}

class PaymentsViewModelTest {

    private fun buildViewModel(ds: FakePaymentsDataSource = FakePaymentsDataSource()): PaymentsViewModel =
        PaymentsViewModel(ds)

    @Test
    fun `initial state is loading`() = runTest {
        val vm = buildViewModel()
        assertTrue(vm.uiState.value.isLoading)
        assertTrue(vm.uiState.value.payments.isEmpty())
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `payments populate after data emission`() = runTest {
        val ds = FakePaymentsDataSource()
        val vm = buildViewModel(ds)
        val payments = listOf(
            Payment(_id = "p-1", kinfolkId = "kf-1", kinfolkName = "Rosa Parks", amount = 120.0),
            Payment(_id = "p-2", kinfolkId = "kf-2", kinfolkName = "Harriet Tubman", amount = 80.0),
        )
        ds.emitPayments(FirestoreResult.Data(payments))

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertEquals(2, state.payments.size)
        assertEquals("p-1", state.payments[0]._id)
        assertNull(state.error)
    }

    @Test
    fun `empty payment list shows empty state not error`() = runTest {
        val ds = FakePaymentsDataSource()
        val vm = buildViewModel(ds)
        ds.emitPayments(FirestoreResult.Data(emptyList()))

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertTrue(state.payments.isEmpty())
        assertNull(state.error)
    }

    @Test
    fun `load error surfaces error message`() = runTest {
        val ds = FakePaymentsDataSource()
        val vm = buildViewModel(ds)
        ds.emitPayments(FirestoreResult.Error("network failure"))

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertTrue(state.payments.isEmpty())
        assertNotNull(state.error)
        assertTrue(state.error!!.contains("network failure"))
    }

    @Test
    fun `recordPayment success adds to stream`() = runTest {
        val ds = FakePaymentsDataSource()
        val vm = buildViewModel(ds)
        ds.emitPayments(FirestoreResult.Data(emptyList()))

        val payment = Payment(
            _id = "",
            kinfolkId = "kf-1",
            kinfolkName = "Rosa Parks",
            amount = 75.0,
            paymentMethod = "CASH",
            date = "2026-05-07",
        )
        vm.recordPayment(payment)

        val state = vm.uiState.value
        assertTrue(state.recordSuccess)
        assertNull(state.error)
    }

    @Test
    fun `recordPayment with zero amount sets validation error`() = runTest {
        val ds = FakePaymentsDataSource()
        val vm = buildViewModel(ds)
        ds.emitPayments(FirestoreResult.Data(emptyList()))

        val payment = Payment(
            _id = "",
            kinfolkId = "kf-1",
            kinfolkName = "Rosa Parks",
            amount = 0.0,
        )
        vm.recordPayment(payment)

        val state = vm.uiState.value
        assertFalse(state.recordSuccess)
        assertNotNull(state.error)
    }

    @Test
    fun `recordPayment with missing kinfolkId sets validation error`() = runTest {
        val ds = FakePaymentsDataSource()
        val vm = buildViewModel(ds)
        ds.emitPayments(FirestoreResult.Data(emptyList()))

        val payment = Payment(
            _id = "",
            kinfolkId = "",
            kinfolkName = "",
            amount = 50.0,
        )
        vm.recordPayment(payment)

        val state = vm.uiState.value
        assertFalse(state.recordSuccess)
        assertNotNull(state.error)
    }

    @Test
    fun `recordPayment failure sets error`() = runTest {
        val ds = FakePaymentsDataSource(recordShouldFail = true, recordFailMessage = "write denied")
        val vm = buildViewModel(ds)
        ds.emitPayments(FirestoreResult.Data(emptyList()))

        val payment = Payment(
            _id = "",
            kinfolkId = "kf-1",
            kinfolkName = "Rosa Parks",
            amount = 50.0,
        )
        vm.recordPayment(payment)

        val state = vm.uiState.value
        assertFalse(state.recordSuccess)
        assertNotNull(state.error)
        assertTrue(state.error!!.contains("write denied"))
    }

    @Test
    fun `clearError resets error to null`() = runTest {
        val ds = FakePaymentsDataSource()
        val vm = buildViewModel(ds)
        ds.emitPayments(FirestoreResult.Error("some error"))
        assertNotNull(vm.uiState.value.error)

        vm.clearError()

        assertNull(vm.uiState.value.error)
    }
}
