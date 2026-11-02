package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.data.repository.KinRemovalRequestRepository
import com.tribetails.auntieos.data.repository.KinRemovalRequestRow
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieLinearProgress
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * #1408. Every household request to remove a Kin that is waiting on the
 * office, beside the visit change requests on the schedule. The React twin is
 * `KinRemovalRequestsSection` on Bookings.
 */
data class KinRemovalQueueState(
    val loading: Boolean = true,
    val error: String? = null,
    val requests: List<KinRemovalRequestRow> = emptyList(),
    val inFlight: String? = null,
    val actionError: String? = null,
    /** The request [actionError] belongs to, so a refusal shows on that row only. */
    val actionErrorFor: String? = null,
    val message: String? = null,
)

class KinRemovalQueueViewModel(
    private val repository: KinRemovalRequestRepository = KinRemovalRequestRepository(),
) : ViewModel() {
    private val _state = MutableStateFlow(KinRemovalQueueState())
    val state: StateFlow<KinRemovalQueueState> = _state.asStateFlow()

    fun load() {
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true, error = null)
            val result = repository.list()
            _state.value = _state.value.copy(
                loading = false,
                requests = result.getOrDefault(emptyList()).filter { it.status == "pending" },
                error = result.exceptionOrNull()?.let { it.message ?: "Couldn't load Kin removal requests" },
            )
        }
    }

    /** Pessimistic: the row stays, locked, until the server answers; then it leaves the queue. */
    fun resolve(requestId: String, decision: String, note: String) {
        if (_state.value.inFlight != null) return
        viewModelScope.launch {
            _state.value = _state.value.copy(inFlight = requestId, actionError = null, actionErrorFor = null, message = null)
            repository.resolve(requestId, decision, note)
                .onSuccess { res ->
                    _state.value = _state.value.copy(
                        inFlight = null,
                        requests = _state.value.requests.filterNot { it.id == requestId },
                        message = kinRemovalResolvedMessage(res),
                    )
                }
                .onFailure { err ->
                    _state.value = _state.value.copy(
                        inFlight = null,
                        actionError = err.message ?: "That did not go through. Try again.",
                        actionErrorFor = requestId,
                    )
                }
        }
    }

    fun clearMessage() {
        _state.value = _state.value.copy(message = null)
    }
}

/** Says so while it loads; nothing at all when no request is waiting. */
@Composable
fun KinRemovalRequestsPanel(viewModel: KinRemovalQueueViewModel = viewModel()) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(viewModel) { viewModel.load() }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        state.message?.let { msg ->
            AuntieBanner(
                tone = AuntieBannerTone.Success,
                title = "Kin removal requests",
                onDismiss = { viewModel.clearMessage() },
            ) { Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim) }
        }
        when {
            state.loading -> DenPanel(title = "Kin removal requests", detail = "Checking for requests…") {
                AuntieLinearProgress(modifier = Modifier.fillMaxWidth())
            }
            state.error != null -> AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Couldn't load Kin removal requests",
                trailing = { GhostButton(label = "Retry", onClick = { viewModel.load() }) },
            ) { Text(state.error.orEmpty(), style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error) }
            state.requests.isNotEmpty() -> DenPanel(
                title = "Kin removal requests",
                detail = "${state.requests.size} waiting",
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    state.requests.forEach { request ->
                        KinRemovalRequestCard(
                            request = request,
                            inFlight = state.inFlight == request.id,
                            locked = state.inFlight != null,
                            error = state.actionError.takeIf { state.actionErrorFor == request.id },
                            onResolve = { decision, note -> viewModel.resolve(request.id, decision, note) },
                            title = request.kinName ?: "Remove Kin",
                        )
                    }
                }
            }
        }
    }
}
