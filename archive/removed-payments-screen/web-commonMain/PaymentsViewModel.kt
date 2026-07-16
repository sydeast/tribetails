package com.tribetails.auntieos.web.screens.payments

import androidx.compose.runtime.Stable
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

interface PaymentsDataSource {
    fun paymentsStream(): Flow<FirestoreResult<List<Payment>>>
    suspend fun recordPayment(payment: Payment): WriteResult<String>
}

@Stable
data class PaymentsUiState(
    val payments: List<Payment> = emptyList(),
    val isLoading: Boolean = true,
    val error: String? = null,
    val recordSuccess: Boolean = false,
)

class PaymentsViewModel(private val dataSource: PaymentsDataSource) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private val _uiState = MutableStateFlow(PaymentsUiState())
    val uiState: StateFlow<PaymentsUiState> = _uiState.asStateFlow()

    init {
        scope.launch {
            dataSource.paymentsStream().collect { result ->
                when (result) {
                    FirestoreResult.Loading -> _uiState.update { it.copy(isLoading = true) }
                    is FirestoreResult.Data -> _uiState.update {
                        it.copy(isLoading = false, payments = result.value, error = null)
                    }
                    is FirestoreResult.Error -> _uiState.update {
                        it.copy(isLoading = false, error = result.message)
                    }
                }
            }
        }
    }

    fun recordPayment(payment: Payment) {
        if (payment.kinfolkId.isBlank()) {
            _uiState.update { it.copy(error = "Kinfolk is required", recordSuccess = false) }
            return
        }
        if (payment.amount <= 0.0) {
            _uiState.update { it.copy(error = "Amount must be greater than zero", recordSuccess = false) }
            return
        }
        scope.launch {
            when (val result = dataSource.recordPayment(payment)) {
                is WriteResult.Ok  -> _uiState.update { it.copy(recordSuccess = true, error = null) }
                is WriteResult.Err -> _uiState.update { it.copy(recordSuccess = false, error = result.message) }
            }
        }
    }

    fun clearError() { _uiState.update { it.copy(error = null) } }
    fun clearRecordSuccess() { _uiState.update { it.copy(recordSuccess = false) } }
}
