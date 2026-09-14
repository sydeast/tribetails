package com.tribetails.auntieos.ui.admin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.contracts.ListPaymentsResultPayment
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResult
import com.tribetails.auntieos.data.contracts.SetSessionDoNotInvoiceResult
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingTransitionAction
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.mintInvoiceIdempotencyKey
import com.tribetails.auntieos.data.repository.mintPaymentIdempotencyKey
import com.tribetails.auntieos.data.repository.mintQuoteIdempotencyKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** UI state for the Activity Log hash-chain verification action. */
sealed interface ChainVerifyUiState {
    data object Idle : ChainVerifyUiState
    data object Loading : ChainVerifyUiState
    data class Done(val result: com.tribetails.auntieos.data.admin.ChainVerifyResult) : ChainVerifyUiState
    data class Error(val message: String) : ChainVerifyUiState
}

/**
 * ONE PAGE of the root `payments` collection, with everything a screen needs in
 * order to be honest about it.
 *
 * [rows] arrive from the `listPayments` callable already in INTEGER CENTS, with
 * the storage-convention ambiguity resolved server-side. Nothing here converts
 * a figure; the moment it does, the duplicated money rule this design exists to
 * avoid is back.
 *
 * [truncated] and [nextCursor] are why this is a data class rather than a bare
 * list. The list is bounded by the server, and a bounded list that cannot say
 * so reads as a complete one — which is the defect
 * `getInvoiceLedger.unlinkedKinfolkPayments` still carries. A screen rendering
 * [rows] must render [truncated] too, or it is stating something it does not
 * know.
 *
 * [unresolvedAmountCount] is how many [rows] carry `amountResolved = false`.
 * Those rows' `amountCents` is the schema floor, NOT a payment of nothing.
 */
data class PaymentsPage(
    val rows: List<ListPaymentsResultPayment>,
    val truncated: Boolean,
    val nextCursor: String?,
    val unresolvedAmountCount: Long,
) {
    companion object {
        /** Before any load. Empty AND complete — nothing has been hidden yet. */
        val EMPTY = PaymentsPage(rows = emptyList(), truncated = false, nextCursor = null, unresolvedAmountCount = 0L)
    }
}

/**
 * W4-1: the invoice and payment paths inject [InvoiceRepository] directly.
 * [repository] still serves this screen's other ~20 domains, which are carved
 * in later waves.
 */
class AdminDataViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
    private val invoiceRepository: InvoiceRepository = AuntieOSApp.instance.invoiceRepository,
    // W4-3: the Auntie Time session list, its row patches and the KinTale
    // buckets (including orphan triage) are KinCare domain.
    private val kinCareRepository: KinCareRepository = AuntieOSApp.instance.kinCareRepository,
) : ViewModel() {

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    /**
     * #825: the keys that make pressing Create, or Record, twice safe.
     *
     * Minted on the first attempt at a submission and held for every retry of
     * it, which on this ViewModel means the operator pressing the button again
     * after seeing an error. That press is the dangerous one. The Firebase SDK
     * reports `INTERNAL` for a request that never arrived AND for a write that
     * committed with a lost reply, so the retry that repairs the first case is
     * the retry that, without a key, creates a SECOND invoice (burning a second
     * value out of the shared `counters/invoiceNumber` sequence, which cannot be
     * given back) or records a SECOND payment and credits the household's
     * `accountBalanceCents` a second time — money this business has no refund
     * mechanism to take back.
     *
     * Re-minted the moment what is being submitted changes, compared at submit
     * time via [invoiceCreateSignature] / [standalonePaymentSignature] rather
     * than cleared from wherever the form is edited. Everything that composes an
     * invoice here lives in the dialog's own state, which this ViewModel never
     * sees until the submit arrives, so comparing the submission itself is the
     * only reading that cannot be broken by a field the dialog grows later.
     *
     * TWO HOLDERS, NOT ONE, because these are two different submissions that can
     * legitimately be in flight at the same time on the same screen: the
     * composer creating an invoice, and the standalone payment ledger recording
     * money. A shared holder would have each one's key re-minted by the other's
     * first press.
     *
     * ONE HOLDER FOR ALL THREE INVOICE-CREATION ENTRY POINTS, on the other hand
     * ([createInvoice], [createQuote] and [composeInvoice]), because they are
     * three doors onto one submission: "make a bill for this household". The
     * signature carries which door it came through and whether it is an invoice
     * or a quote, so switching door or kind re-mints rather than replaying — and
     * it has to, since a `quot_` key sent to `createInvoice` is a key the server
     * refuses outright.
     */
    private var invoiceCreateKey: String? = null
    private var invoiceCreateSignature: String? = null
    private var standalonePaymentKey: String? = null
    private var standalonePaymentSignature: String? = null

    /**
     * Everything that decides WHAT bill is being created (#825). Deliberately
     * excludes [_isLoading] and [_error], which change while a create is in
     * flight: treating that as an edit would mint a new key for the retry and
     * re-arm the duplicate.
     *
     * The invoice, the lines and the discount go in via their `toString()`,
     * which is honest here because every one of them is a `data class` (see
     * `Models.kt` and `NewInvoiceDialog.kt`) and so has a value-based
     * `toString`. A plain class would give an identity string, a fresh value on
     * every press, and a re-mint every press — the exact defect that would leave
     * this feature looking wired while defending nothing.
     */
    private fun invoiceCreateSignature(
        entryPoint: String,
        kind: InvoiceCreateKind,
        invoice: Invoice,
        sendToKinfolk: Boolean,
        termsCode: String?,
        lineItems: List<InvoiceLineItem>?,
        invoiceDiscountCents: Long?,
    ): String = listOf(
        entryPoint,
        kind.name,
        invoice.toString(),
        sendToKinfolk.toString(),
        termsCode.orEmpty(),
        lineItems?.toString().orEmpty(),
        invoiceDiscountCents?.toString().orEmpty(),
    ).joinToString("\u001F") // a separator no typed field can contain

    /**
     * The key for whichever of the two invoice-creating callables this
     * submission is for, minted fresh only when the submission has changed since
     * the held one was minted.
     *
     * THE PREFIX FOLLOWS THE KIND, and [kind] is part of the signature above, so
     * an operator who flips the composer from Invoice to Quote and presses again
     * gets a `quot_` key rather than replaying an `inv_` one at a callable that
     * would refuse it.
     */
    private fun heldInvoiceCreateKey(
        entryPoint: String,
        kind: InvoiceCreateKind,
        invoice: Invoice,
        sendToKinfolk: Boolean = false,
        termsCode: String? = null,
        lineItems: List<InvoiceLineItem>? = null,
        invoiceDiscountCents: Long? = null,
    ): String? {
        val signature = invoiceCreateSignature(
            entryPoint, kind, invoice, sendToKinfolk, termsCode, lineItems, invoiceDiscountCents,
        )
        if (invoiceCreateKey == null || invoiceCreateSignature != signature) {
            invoiceCreateKey = when (kind) {
                InvoiceCreateKind.QUOTE -> mintQuoteIdempotencyKey()
                InvoiceCreateKind.INVOICE -> mintInvoiceIdempotencyKey()
            }
            invoiceCreateSignature = signature
        }
        return invoiceCreateKey
    }

    /**
     * Released on success: the NEXT press is a second bill the operator meant to
     * create, not a retry of this one, and a held key would have the server hand
     * back the first invoice and report it as though the second had been made.
     */
    private fun releaseInvoiceCreateKey() {
        invoiceCreateKey = null
        invoiceCreateSignature = null
    }

    /**
     * Everything that decides WHAT payment is being recorded (#825).
     *
     * The fields are listed one by one rather than taken from [Payment]'s own
     * `toString()`, and the omission is the reason: `id` is `@DocumentId`, never
     * serialized, and never sent — so folding it in would let a value the server
     * never sees decide whether two presses are the same payment.
     */
    private fun standalonePaymentSignature(payment: Payment): String = listOf(
        payment.kinfolkId,
        payment.invoiceId,
        payment.invoiceNumber,
        payment.amount.toString(),
        payment.tip.toString(),
        payment.fee.toString(),
        payment.date,
        payment.paymentMethod,
        payment.referenceNumber,
        payment.email,
        payment.notes.orEmpty(),
        payment.autoApply.toString(),
        payment.sendConfirmationEmail.toString(),
    ).joinToString("\u001F") // a separator no typed field can contain

    // Invoice Management
    private val _invoices = MutableStateFlow<List<Invoice>>(emptyList())
    val invoices: StateFlow<List<Invoice>> = _invoices.asStateFlow()

    // Payment Management. ONE flow, not three, so a page and the statement that
    // it is only a page cannot be read at two different instants and disagree.
    private val _payments = MutableStateFlow(PaymentsPage.EMPTY)
    val payments: StateFlow<PaymentsPage> = _payments.asStateFlow()

    // Visit Log Management
    private val _visitLogs = MutableStateFlow<List<VisitLog>>(emptyList())
    val visitLogs: StateFlow<List<VisitLog>> = _visitLogs.asStateFlow()

    // Training Document Management
    private val _trainingDocuments = MutableStateFlow<List<TrainingDocument>>(emptyList())
    val trainingDocuments: StateFlow<List<TrainingDocument>> = _trainingDocuments.asStateFlow()

    // Kin Care Session Management
    private val _kinCareSessions = MutableStateFlow<List<KinCareSession>>(emptyList())
    val kinCareSessions: StateFlow<List<KinCareSession>> = _kinCareSessions.asStateFlow()

    // §A.8: Business-Settings time blocks for the Auntie-Time "Evening block" labels.
    // Unified settings (2026-06-05): timeBlocks now live on business_settings,
    // read via the injected AuntieRepository.
    private val _timeBlocks = MutableStateFlow<List<com.tribetails.auntieos.data.model.TimeBlockDefinition>>(emptyList())
    val timeBlocks: StateFlow<List<com.tribetails.auntieos.data.model.TimeBlockDefinition>> = _timeBlocks.asStateFlow()

    // KinTale (visit recap report) Management
    private val _kinCareReports = MutableStateFlow<List<KinCareReport>>(emptyList())
    val kinCareReports: StateFlow<List<KinCareReport>> = _kinCareReports.asStateFlow()

    // Kinfolk list - populated on demand by orphan triage flow so the
    // "Assign Kinfolk" picker has live data without loading the directory
    // every time the logs screen opens.
    private val _kinfolkDirectory = MutableStateFlow<List<Kinfolk>>(emptyList())
    val kinfolkDirectory: StateFlow<List<Kinfolk>> = _kinfolkDirectory.asStateFlow()

    // Last orphan triage action result. UI watches this flow to render
    // success / error toasts. Cleared by `clearTriageResult()`.
    private val _triageResult = MutableStateFlow<TriageResult?>(null)
    val triageResult: StateFlow<TriageResult?> = _triageResult.asStateFlow()

    data class TriageResult(val success: Boolean, val message: String)

    // Activity log (audit trail) Management
    private val _activityLog = MutableStateFlow<List<com.tribetails.auntieos.data.admin.ActivityLogEntry>>(emptyList())
    val activityLog: StateFlow<List<com.tribetails.auntieos.data.admin.ActivityLogEntry>> = _activityLog.asStateFlow()

    // Hash-chain integrity verdict (calls the deployed verifyActivityLogChain
    // admin callable). Parity with the web Activity Log chain-verify panel.
    private val _chainVerify = MutableStateFlow<ChainVerifyUiState>(ChainVerifyUiState.Idle)
    val chainVerify: StateFlow<ChainVerifyUiState> = _chainVerify.asStateFlow()

    fun verifyChain() {
        _chainVerify.value = ChainVerifyUiState.Loading
        viewModelScope.launch {
            repository.verifyActivityLogChain()
                .onSuccess { _chainVerify.value = ChainVerifyUiState.Done(it) }
                .onFailure { _chainVerify.value = ChainVerifyUiState.Error(it.message ?: "Chain verify failed") }
        }
    }

    // Catalog-dispatched notifications (operator's own inbox)
    private val _notifications = MutableStateFlow<List<com.tribetails.auntieos.data.admin.NotificationEntry>>(emptyList())
    val notifications: StateFlow<List<com.tribetails.auntieos.data.admin.NotificationEntry>> = _notifications.asStateFlow()

    fun loadNotifications() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null
            repository.getNotifications().onSuccess { entries ->
                _notifications.value = entries.sortedByDescending { it.createdAt }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load notifications"
            }
            _isLoading.value = false
        }
    }

    // Bulk mark-read result message (e.g. "Marked 3 read."), surfaced as a toast.
    private val _bulkReadMessage = MutableStateFlow<String?>(null)
    val bulkReadMessage: StateFlow<String?> = _bulkReadMessage.asStateFlow()
    fun clearBulkReadMessage() { _bulkReadMessage.value = null }

    private val _bulkReadInFlight = MutableStateFlow(false)
    val bulkReadInFlight: StateFlow<Boolean> = _bulkReadInFlight.asStateFlow()

    /**
     * Stage 2 tail: mark the given notification ids read via the
     * bulkMarkNotificationsRead callable, then reload so the read state reflects.
     * Fail-loud: a callable failure surfaces verbatim; the server-reported "marked"
     * count is surfaced honestly (it can be less than requested when ids are stale).
     */
    fun markNotificationsRead(ids: List<String>) {
        if (ids.isEmpty() || _bulkReadInFlight.value) return
        _bulkReadInFlight.value = true
        viewModelScope.launch {
            repository.bulkMarkNotificationsRead(ids)
                .onSuccess { marked ->
                    _bulkReadMessage.value = bulkReadSummary(requested = ids.size, marked = marked)
                    loadNotifications()
                }
                .onFailure { throwable ->
                    _bulkReadMessage.value = "Couldn't mark read: ${throwable.message}"
                }
            _bulkReadInFlight.value = false
        }
    }

    /**
     * Step 4 quick-action: toggle ONE notification's read state. Routes through
     * markNotificationRead / markNotificationUnread, then reloads so the row's
     * read accent reflects the server write. Fail-loud via [_bulkReadMessage].
     */
    fun toggleNotificationRead(id: String, currentlyUnread: Boolean) {
        if (id.isBlank()) return
        viewModelScope.launch {
            val call = if (currentlyUnread) repository.markNotificationRead(id)
                else repository.markNotificationUnread(id)
            call.onSuccess {
                _bulkReadMessage.value = if (currentlyUnread) "Marked read." else "Marked unread."
                loadNotifications()
            }.onFailure { throwable ->
                _bulkReadMessage.value = "Couldn't update: ${throwable.message}"
            }
        }
    }

    /**
     * Step 4 quick-action: archive ONE notification out of the active inbox via
     * archiveNotification, then reload so it drops off the list. Fail-loud.
     */
    fun archiveNotification(id: String) {
        if (id.isBlank()) return
        viewModelScope.launch {
            repository.archiveNotification(id)
                .onSuccess { archived ->
                    _bulkReadMessage.value =
                        if (archived > 0) "Dismissed." else "Nothing to dismiss (already archived or unavailable)."
                    loadNotifications()
                }
                .onFailure { throwable ->
                    _bulkReadMessage.value = "Couldn't dismiss: ${throwable.message}"
                }
        }
    }

    /**
     * Step 4 quick-action: archive MANY notifications at once via
     * bulkArchiveNotifications. Honest about partial archives (stale ids skipped
     * server-side). Reuses [_bulkReadInFlight] so the multi-select control disables
     * during the call.
     */
    fun archiveNotifications(ids: List<String>) {
        if (ids.isEmpty() || _bulkReadInFlight.value) return
        _bulkReadInFlight.value = true
        viewModelScope.launch {
            repository.bulkArchiveNotifications(ids)
                .onSuccess { archived ->
                    _bulkReadMessage.value = bulkArchiveSummary(requested = ids.size, archived = archived)
                    loadNotifications()
                }
                .onFailure { throwable ->
                    _bulkReadMessage.value = "Couldn't dismiss: ${throwable.message}"
                }
            _bulkReadInFlight.value = false
        }
    }

    /**
     * Step 4 quick-action (booking notifications only): apply a booking transition
     * (APPROVE/REJECT) to the linked visit via batchUpdateBookings, then reload the
     * inbox. Fail-loud: the per-id failure (or success) is surfaced verbatim.
     */
    fun quickBookingAction(targetId: String, action: String) {
        if (targetId.isBlank()) return
        viewModelScope.launch {
            repository.batchUpdateBookings(listOf(targetId), action)
                .onSuccess { result ->
                    _bulkReadMessage.value = when {
                        result.updated > 0 -> "Booking ${action.lowercase()}."
                        result.failed.isNotEmpty() -> "Couldn't ${action.lowercase()}: ${result.failed.first().error}"
                        else -> "No booking updated."
                    }
                    loadNotifications()
                }
                .onFailure { throwable ->
                    _bulkReadMessage.value = "Couldn't ${action.lowercase()}: ${throwable.message}"
                }
        }
    }

    fun loadInvoices() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            invoiceRepository.getInvoices().onSuccess { invoiceList ->
                // Through the shared comparator, not `sortedByDescending { it.date }`.
                // That was a RAW STRING sort over a field that legacy documents fill
                // with free text, and letters outrank digits in UTF-8, so a stored
                // "Feb 12, 2026" ranked above every real date. Every reader of this
                // flow got that order; InvoicesScreen happened to re-sort and the
                // others did not.
                _invoices.value = invoicesByDateDesc(invoiceList)
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load invoices"
            }

            _isLoading.value = false
        }
    }

    /**
     * The payment list, THROUGH THE SERVER, in resolved integer cents.
     *
     * This used to call `InvoiceRepository.getPayments()`, a raw read of the
     * root `payments` collection. `stripeWebhook.ts` stores a card payment's
     * `amount` in cents and a fallback payment's in dollars, distinguishable
     * only by a sibling `amountSource`, and the `Payment` model carries neither
     * that field nor `amountCents` — so any screen that rendered money out of
     * this flow was 100x wrong on every Stripe row, and could not have been
     * fixed client-side. Nothing collected the flow, which is the only reason
     * it was latent rather than live; the trap was that the first screen to
     * collect it would inherit the defect silently.
     *
     * NOT SORTED HERE. The page arrives in the server's document-id cursor
     * order, and re-sorting it client-side would be wrong twice over: it would
     * scramble the page boundaries the cursor depends on, and the only field to
     * sort by is `date`, which this collection stores as free text on
     * hand-recorded rows and as a Timestamp on Stripe ones. A raw string sort on
     * that field is the exact defect `invoicesByDateDesc` was introduced to fix
     * on the invoice flow above ("Feb 12, 2026" outranking every real date).
     *
     * Fail-loud: a failure sets the error and LEAVES THE PREVIOUS PAGE ALONE.
     * Emptying it would say "no payments have ever been recorded", which is a
     * false statement about money rather than a missing one, and there is no
     * fallback to the raw read for the same reason.
     */
    fun loadPayments(limit: Int? = null, startAfterId: String? = null) {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            invoiceRepository.listPayments(limit = limit, startAfterId = startAfterId)
                .onSuccess { page ->
                    _payments.value = PaymentsPage(
                        rows = page.payments,
                        truncated = page.truncated,
                        nextCursor = page.nextCursor,
                        unresolvedAmountCount = page.unresolvedAmountCount,
                    )
                }.onFailure { throwable ->
                    _error.value = throwable.message ?: "Failed to load payments"
                }

            _isLoading.value = false
        }
    }

    fun loadVisitLogs() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            repository.getVisitLogs().onSuccess { logList ->
                _visitLogs.value = logList.sortedByDescending { it.submitted }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load visit logs"
            }

            _isLoading.value = false
        }
    }

    fun loadTrainingDocuments() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            repository.getTrainingDocuments().onSuccess { docList ->
                _trainingDocuments.value = docList.sortedByDescending { it.uploadedAt }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load training documents"
            }

            _isLoading.value = false
        }
    }

    fun loadKinCareSessions() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            kinCareRepository.getKinCareSessions().onSuccess { sessionList ->
                _kinCareSessions.value = sessionList.sortedByDescending { it.startTime }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load kin care sessions"
            }
            // §A.8: load time blocks from unified business_settings (best-effort;
            // absence/no-Firebase just means no block labels). Wrapped so a missing
            // FirebaseApp in tests can't crash.
            runCatching { repository.getBusinessSettings().onSuccess { _timeBlocks.value = it.timeBlocks } }

            _isLoading.value = false
        }
    }

    fun loadKinCareReports() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            kinCareRepository.getAllKinCareReports().onSuccess { reportList ->
                _kinCareReports.value = reportList.sortedByDescending { sortKey(it) }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load KinTales"
            }

            _isLoading.value = false
        }
    }

    private fun sortKey(r: KinCareReport): String = sequenceOf(
        r.sentAt, r.updatedAt, r.visitDate, r.createdAt,
    ).firstOrNull { !it.isNullOrBlank() } ?: ""

    fun loadActivityLog() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            repository.getActivityLog().onSuccess { entries ->
                _activityLog.value = entries.sortedByDescending { it.timestamp }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load activity log"
            }

            _isLoading.value = false
        }
    }

    /**
     * Patches a Kin Care session and refreshes the local list so the row UI
     * reflects the new state immediately. Used by Auntie Time row buttons.
     */
    fun patchKinCareSession(id: String, patch: Map<String, Any>, onResult: (Throwable?) -> Unit = {}) {
        viewModelScope.launch {
            kinCareRepository.patchKinCareSession(id, patch).onSuccess {
                loadKinCareSessions()
                onResult(null)
            }.onFailure { t ->
                _error.value = t.message ?: "Failed to update Kin Care"
                onResult(t)
            }
        }
    }

    /**
     * A3: applies one OPERATOR status transition through the
     * `transitionBookingStatus` callable, then reloads so the row shows what the
     * server actually did.
     *
     * Kept separate from [patchKinCareSession] rather than folded into it,
     * because these are two different kinds of write and blurring them is how
     * the audit hole existed at all: a patch is a field edit the client owns, a
     * transition is a state change the server owns, audits, and can refuse. The
     * server's refusal message reaches the operator verbatim.
     */
    fun transitionBookingStatus(
        id: String,
        action: BookingTransitionAction,
        completedAt: String = "",
        reason: String = "",
        onResult: (Throwable?) -> Unit = {},
    ) {
        viewModelScope.launch {
            kinCareRepository.transitionBookingStatus(id, action, completedAt, reason).onSuccess {
                loadKinCareSessions()
                onResult(null)
            }.onFailure { t ->
                _error.value = t.message ?: "Failed to update Kin Care"
                onResult(t)
            }
        }
    }

    // Create new records
    fun createInvoice(invoice: Invoice) {
        // #825: one key per invoice, re-minted only when the invoice itself has
        // changed since the key was minted. Taken HERE rather than inside the
        // coroutine so a second press while the first attempt is still in flight
        // reads the same held key; a cold start is long enough for that to
        // happen, and it is the case a per-press key gets wrong.
        val key = heldInvoiceCreateKey("createInvoice", InvoiceCreateKind.INVOICE, invoice)
        viewModelScope.launch {
            _isLoading.value = true
            invoiceRepository.createInvoice(invoice, idempotencyKey = key).onSuccess {
                releaseInvoiceCreateKey()
                loadInvoices() // Refresh the list
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create invoice"
                _isLoading.value = false
            }
        }
    }

    /**
     * Step 4 (PART B): create a QUOTE (invoice in QUOTE status) via the createQuote
     * callable, optionally dispatching the issued-quote notification to the kinfolk.
     * Fail-loud: server validation surfaces verbatim through [_error]; success
     * confirms via [_invoiceActionMessage] and refreshes the list.
     */
    fun createQuote(invoice: Invoice, sendToKinfolk: Boolean) {
        // #825, and with [sendToKinfolk] the key is protecting the household's
        // inbox as well as the `invoices` collection: a replay would dispatch
        // the issued-quote notification a second time, so one piece of work
        // arrives as two quotes.
        val key = heldInvoiceCreateKey(
            entryPoint = "createQuote",
            kind = InvoiceCreateKind.QUOTE,
            invoice = invoice,
            sendToKinfolk = sendToKinfolk,
        )
        viewModelScope.launch {
            _isLoading.value = true
            invoiceRepository.createQuote(invoice, sendToKinfolk, idempotencyKey = key).onSuccess {
                releaseInvoiceCreateKey()
                _invoiceActionMessage.value = if (sendToKinfolk) "Quote created and sent." else "Quote created."
                loadInvoices() // Refresh the list
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create quote"
                _isLoading.value = false
            }
        }
    }

    /**
     * The #408 composer's write: whichever of `createInvoice` / `createQuote` the
     * operator chose inside the one dialog, with the structured terms and the
     * lines it built from the household's un-invoiced work.
     *
     * ONE ENTRY POINT, because a quote is an invoice in QUOTE status and the
     * composer picks between them as a field rather than as a second button.
     *
     * [onResult] carries the NEW INVOICE ID back so the caller can open it: the
     * point of creating one is to land on it, and the dialog needs the failure
     * too, so it can stay open with the form intact instead of closing over a
     * write that never happened. Errors still reach [_error] as well, which is
     * how every other write on this ViewModel reports.
     */
    fun composeInvoice(request: NewInvoiceRequest, onResult: (Result<String>) -> Unit = {}) {
        // #825: one key per composed request, and this is the entry point that
        // needs it most. A failure here deliberately leaves the dialog OPEN with
        // the form intact so the operator can press Create again — which is
        // precisely the retry that used to make a second invoice and spend a
        // second invoice number. The key is what turns that press into a replay
        // of the first attempt. It is re-minted only when the request itself
        // changes, so an edit made in that still-open dialog is a new bill
        // rather than a replay that would report the OLD one back as though the
        // edit had landed.
        val key = heldInvoiceCreateKey(
            entryPoint = "composeInvoice",
            kind = request.kind,
            invoice = request.invoice,
            sendToKinfolk = request.sendToKinfolk,
            termsCode = request.termsCode,
            lineItems = request.lineItems,
            invoiceDiscountCents = request.invoiceDiscountCents,
        )
        viewModelScope.launch {
            _isLoading.value = true
            val result = when (request.kind) {
                InvoiceCreateKind.QUOTE -> invoiceRepository.createQuote(
                    invoice = request.invoice,
                    sendToKinfolk = request.sendToKinfolk,
                    termsCode = request.termsCode,
                    lineItems = request.lineItems?.map { it.toCreateQuoteLine() },
                    invoiceDiscountCents = request.invoiceDiscountCents,
                    idempotencyKey = key,
                )
                InvoiceCreateKind.INVOICE -> invoiceRepository.createInvoice(
                    invoice = request.invoice,
                    termsCode = request.termsCode,
                    lineItems = request.lineItems?.map { it.toCreateInvoiceLine() },
                    invoiceDiscountCents = request.invoiceDiscountCents,
                    idempotencyKey = key,
                )
            }
            result.onSuccess {
                releaseInvoiceCreateKey()
                _invoiceActionMessage.value = when {
                    request.kind == InvoiceCreateKind.QUOTE && request.sendToKinfolk -> "Quote created and sent."
                    request.kind == InvoiceCreateKind.QUOTE -> "Quote created."
                    else -> "Invoice created as a draft. Nothing has been sent to the household yet."
                }
                loadInvoices() // Refresh the list
            }.onFailure { throwable ->
                _error.value = throwable.message
                    ?: if (request.kind == InvoiceCreateKind.QUOTE) "Failed to create quote" else "Failed to create invoice"
                _isLoading.value = false
            }
            onResult(result)
        }
    }

    /**
     * A household's un-invoiced completed work, for the composer's picker.
     *
     * Handed straight through rather than cached on a StateFlow: the picker asks
     * for exactly one household at a time and reloads whenever the queue changes,
     * so a cached copy here would only ever be a second answer to disagree with.
     */
    suspend fun loadUninvoicedSessions(
        kinfolkId: String,
        from: String? = null,
        to: String? = null,
    ): Result<ListUninvoicedSessionsResult> = invoiceRepository.listUninvoicedSessions(kinfolkId, from, to)

    /**
     * Marks visits do-not-invoice, or puts them back. Reversible by design; see
     * `InvoiceRepository.setSessionDoNotInvoice`.
     */
    suspend fun setSessionDoNotInvoice(
        sessionIds: List<String>,
        doNotInvoice: Boolean,
        reason: String,
    ): Result<SetSessionDoNotInvoiceResult> =
        invoiceRepository.setSessionDoNotInvoice(sessionIds, doNotInvoice, reason)

    /** Slice 2: issue a receipt for an invoice via the generateReceipt callable. */
    fun generateReceipt(invoiceId: String) {
        viewModelScope.launch {
            _isLoading.value = true
            invoiceRepository.generateReceipt(invoiceId).onSuccess {
                loadInvoices() // Refresh to reflect receiptIssuedAt
                _invoiceActionMessage.value = "Receipt generated."
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to generate receipt"
                _isLoading.value = false
            }
        }
    }

    // Stage 2 tail: transient confirmation for the per-row invoice actions
    // (reminder / review-and-send). Errors still go to [_error]; this carries the
    // success line so the row action confirms loudly instead of silently. Cleared
    // by [clearInvoiceActionMessage].
    private val _invoiceActionMessage = MutableStateFlow<String?>(null)
    val invoiceActionMessage: StateFlow<String?> = _invoiceActionMessage.asStateFlow()

    fun clearInvoiceActionMessage() { _invoiceActionMessage.value = null }

    /**
     * Stage 2 tail: send an on-demand payment reminder for an invoice via the
     * sendInvoiceReminder callable. Fail-loud: server preconditions (already-paid,
     * not-found) surface verbatim through [_error].
     */
    /**
     * #832: invoices with a reminder press still waiting on the server. The row
     * button reads it to show "Sending…" and stay disabled, and a second call for
     * the same id is dropped here, so a double-tap fires one callable.
     */
    private val _remindingInvoiceIds = MutableStateFlow<Set<String>>(emptySet())
    val remindingInvoiceIds: StateFlow<Set<String>> = _remindingInvoiceIds.asStateFlow()

    fun sendInvoiceReminder(invoiceId: String) {
        if (invoiceId.isBlank()) return
        if (invoiceId in _remindingInvoiceIds.value) return
        _remindingInvoiceIds.value = _remindingInvoiceIds.value + invoiceId
        viewModelScope.launch {
            invoiceRepository.sendInvoiceReminder(invoiceId).onSuccess { outcome ->
                if (outcome.sent) {
                    com.tribetails.auntieos.data.admin.AuditLog.fire(
                        scope = viewModelScope,
                        repository = repository,
                        actionType = "SEND_INVOICE_REMINDER",
                        description = "Sent payment reminder for invoice $invoiceId",
                        targetId = invoiceId,
                        targetCollection = "invoices",
                    )
                }
                // The row's "reminded ..." line reads the loaded model, so move
                // the one server-written field on it (copy, never a rebuild).
                outcome.lastReminderAtMs?.let { at ->
                    _invoices.value = _invoices.value.map {
                        if (it.id == invoiceId) it.copy(reminderNotifiedAtMs = at) else it
                    }
                }
                _invoiceActionMessage.value = com.tribetails.auntieos.domain.reminderOutcomeMessage(outcome)
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to send reminder"
            }
            _remindingInvoiceIds.value = _remindingInvoiceIds.value - invoiceId
        }
    }

    /**
     * Stage 2 tail: transition a DRAFT invoice to "sent" via the postInvoiceEvent
     * callable (reviewAndSendDraftInvoice). Refreshes the list on success so the
     * draft affordance drops. Fail-loud: a blank kinfolk is rejected up front.
     */
    fun reviewAndSendDraftInvoice(invoice: Invoice) {
        if (invoice.id.isBlank()) return
        if (invoice.kinfolkId.isBlank()) {
            _error.value = "This invoice has no client (kinfolk) on record, so it cannot be sent."
            return
        }
        viewModelScope.launch {
            invoiceRepository.reviewAndSendDraftInvoice(invoice.id, invoice.kinfolkId).onSuccess {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope = viewModelScope,
                    repository = repository,
                    actionType = "SEND_DRAFT_INVOICE",
                    description = "Reviewed and sent draft invoice ${invoice.invoiceNumber.ifBlank { invoice.id }}",
                    targetId = invoice.id,
                    targetCollection = "invoices",
                )
                loadInvoices()
                _invoiceActionMessage.value = "Draft sent."
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to send draft"
            }
        }
    }

    /**
     * A standalone payment into the root `payments` ledger.
     *
     * #825: one key per payment, held across the operator's retry and re-minted
     * only when the payment itself changes. This is the callable the issue is
     * named after — without a key a replay records the payment twice AND, with
     * `autoApply`, credits the household's `accountBalanceCents` twice, and
     * account balance is the only destination this business has for money owed
     * back, so the second credit is spendable money made from nothing.
     */
    fun createPayment(payment: Payment) {
        val signature = standalonePaymentSignature(payment)
        if (standalonePaymentKey == null || standalonePaymentSignature != signature) {
            standalonePaymentKey = mintPaymentIdempotencyKey()
            standalonePaymentSignature = signature
        }
        val key = standalonePaymentKey
        viewModelScope.launch {
            _isLoading.value = true
            invoiceRepository.createPayment(payment, idempotencyKey = key).onSuccess {
                // The next press is a second payment the operator meant to
                // record, not a retry of this one.
                standalonePaymentKey = null
                standalonePaymentSignature = null
                // Refreshes page 1, which is NOT a recency query and may not
                // contain the row just written. listPayments orders by document
                // id because the collection has no field that can order it
                // honestly: `date` is mixed Timestamp/free-text so it sorts by
                // writer, and `createdAt` exists only on recordPayment rows so
                // ordering by it would silently drop every Stripe row. Once the
                // collection exceeds one page this refresh is an arbitrary
                // sample. A staff browser that needs "most recent" needs a
                // normalized date field on the collection first.
                loadPayments()
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create payment"
                _isLoading.value = false
            }
        }
    }

    fun createVisitLog(visitLog: VisitLog) {
        viewModelScope.launch {
            _isLoading.value = true
            repository.createVisitLog(visitLog).onSuccess {
                loadVisitLogs() // Refresh the list
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create visit log"
                _isLoading.value = false
            }
        }
    }

    // ─── Tribal Intel write tool (spec 23) ──────────────────────────────────
    // Pets for the currently selected kinfolk in the target picker.
    private val _kinForSelectedKinfolk = MutableStateFlow<List<com.tribetails.auntieos.data.model.Kin>>(emptyList())
    val kinForSelectedKinfolk: StateFlow<List<com.tribetails.auntieos.data.model.Kin>> = _kinForSelectedKinfolk.asStateFlow()

    // Honest "queued for reconcile" confirmation. The dossier/411 fold happens on
    // the next reconcile pass, never instantly, so the UI says exactly that.
    private val _trainingDocQueuedMessage = MutableStateFlow<String?>(null)
    val trainingDocQueuedMessage: StateFlow<String?> = _trainingDocQueuedMessage.asStateFlow()

    private val _trainingDocSaving = MutableStateFlow(false)
    val trainingDocSaving: StateFlow<Boolean> = _trainingDocSaving.asStateFlow()

    fun clearTrainingDocQueuedMessage() { _trainingDocQueuedMessage.value = null }

    fun loadKinForSelectedKinfolk(kinfolkId: String) {
        if (kinfolkId.isBlank()) { _kinForSelectedKinfolk.value = emptyList(); return }
        viewModelScope.launch {
            repository.getKin(kinfolkId).onSuccess { _kinForSelectedKinfolk.value = it }
                .onFailure { _error.value = it.message ?: "Failed to load pets" }
        }
    }

    // Draft attachments accumulated by the form before save. Uploaded to Cloudinary
    // first via MediaUploadManager (entityType TRIBAL_INTEL); only the resulting
    // storageUrl + publicId are passed into the create/update callable.
    private val _trainingDocAttachments = MutableStateFlow<List<TrainingDocAttachment>>(emptyList())
    val trainingDocAttachments: StateFlow<List<TrainingDocAttachment>> = _trainingDocAttachments.asStateFlow()

    private val _trainingDocUploading = MutableStateFlow(false)
    val trainingDocUploading: StateFlow<Boolean> = _trainingDocUploading.asStateFlow()

    fun setTrainingDocAttachments(list: List<TrainingDocAttachment>) { _trainingDocAttachments.value = list }
    fun removeTrainingDocAttachment(publicId: String) {
        _trainingDocAttachments.value = _trainingDocAttachments.value.filterNot { it.cloudinaryPublicId == publicId }
    }
    fun resetTrainingDocDraft() {
        _trainingDocAttachments.value = emptyList()
        _kinForSelectedKinfolk.value = emptyList()
        _trainingDocQueuedMessage.value = null
    }

    fun uploadTribalIntelAttachment(context: android.content.Context, uri: android.net.Uri) {
        viewModelScope.launch {
            _trainingDocUploading.value = true
            _error.value = null
            com.tribetails.auntieos.media.MediaUploadManager(context, repository).uploadMedia(
                uri = uri,
                entityId = "pending",
                entityType = MediaEntityType.TRIBAL_INTEL,
            ).onSuccess { media ->
                val att = TrainingDocAttachment(
                    storageUrl = media.storageUrl,
                    cloudinaryPublicId = media.cloudinaryPublicId,
                    fileType = media.fileType.name,
                    mimeType = media.mimeType,
                    fileName = media.originalFileName.ifBlank { media.fileName },
                )
                _trainingDocAttachments.value = _trainingDocAttachments.value + att
                _trainingDocUploading.value = false
            }.onFailure { e ->
                _error.value = "Attachment upload failed: ${e.message}"
                _trainingDocUploading.value = false
            }
        }
    }

    fun createTrainingDocument(
        title: String,
        content: String,
        notes: String,
        targetType: String,
        targetKinfolkId: String,
        targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
        onResult: (Throwable?) -> Unit = {},
    ) {
        viewModelScope.launch {
            _trainingDocSaving.value = true
            _error.value = null
            _trainingDocQueuedMessage.value = null
            repository.createTrainingDocument(title, content, notes, targetType, targetKinfolkId, targetKinId, attachments).onSuccess {
                _trainingDocSaving.value = false
                _trainingDocQueuedMessage.value =
                    "Queued for reconcile. The dossier, the household bank and the 411 update on the next reconcile pass, not instantly."
                loadTrainingDocuments()
                onResult(null)
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create Tribal Intel"
                _trainingDocSaving.value = false
                onResult(throwable)
            }
        }
    }

    fun updateTrainingDocument(
        docId: String,
        title: String,
        content: String,
        notes: String,
        targetType: String,
        targetKinfolkId: String,
        targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
        onResult: (Throwable?) -> Unit = {},
    ) {
        viewModelScope.launch {
            _trainingDocSaving.value = true
            _error.value = null
            _trainingDocQueuedMessage.value = null
            repository.updateTrainingDocument(docId, title, content, notes, targetType, targetKinfolkId, targetKinId, attachments).onSuccess {
                _trainingDocSaving.value = false
                _trainingDocQueuedMessage.value =
                    "Queued for reconcile. The dossier, the household bank and the 411 update on the next reconcile pass, not instantly."
                loadTrainingDocuments()
                onResult(null)
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to update Tribal Intel"
                _trainingDocSaving.value = false
                onResult(throwable)
            }
        }
    }

    fun deleteTrainingDocument(docId: String, onResult: (Throwable?) -> Unit = {}) {
        viewModelScope.launch {
            _trainingDocSaving.value = true
            _error.value = null
            repository.deleteTrainingDocument(docId).onSuccess {
                _trainingDocSaving.value = false
                loadTrainingDocuments()
                onResult(null)
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to delete Tribal Intel"
                _trainingDocSaving.value = false
                onResult(throwable)
            }
        }
    }

    fun createKinCareSession(session: KinCareSession) {
        viewModelScope.launch {
            _isLoading.value = true
            kinCareRepository.createKinCareSession(session).onSuccess {
                loadKinCareSessions() // Refresh the list
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create session"
                _isLoading.value = false
            }
        }
    }

    fun clearError() {
        _error.value = null
    }

    // ─── Orphan KinCareReport triage ──────────────────────────────────────────
    //
    // Three actions an admin can take on a post-migration orphan:
    //   • assignOrphanReport     - link to a real kinfolk
    //   • markOrphanAsDuplicate  - point at the canonical report ID
    //   • archiveOrphanAsBad     - soft-archive with a required reason
    //
    // Each flow refreshes the report list on success so the row disappears
    // from "Needs Triage" immediately, and publishes a TriageResult so the
    // screen can render a success or error toast (fail-loud: any repo
    // failure surfaces here, never swallowed).

    fun loadKinfolkDirectory() {
        viewModelScope.launch {
            repository.getKinfolk().onSuccess { list ->
                _kinfolkDirectory.value = list.sortedBy { "${it.firstName} ${it.lastName}".trim().lowercase() }
            }.onFailure { t ->
                _error.value = t.message ?: "Failed to load kinfolk directory"
            }
        }
    }

    /**
     * Every pet on the roster, across households.
     *
     * `kinForSelectedKinfolk` above is the target picker's list and is loaded
     * one household at a time, so it cannot name the pet on a Tribal Intel row
     * for some OTHER household. A list that shows "Kin: <raw id>" on every row
     * but the one being edited is why this whole-roster read exists.
     */
    private val _kinDirectory = MutableStateFlow<List<com.tribetails.auntieos.data.model.Kin>>(emptyList())
    val kinDirectory: StateFlow<List<com.tribetails.auntieos.data.model.Kin>> = _kinDirectory.asStateFlow()

    fun loadKinDirectory() {
        viewModelScope.launch {
            repository.getAllKin().onSuccess { list ->
                _kinDirectory.value = list
            }.onFailure { t ->
                _error.value = t.message ?: "Failed to load kin directory"
            }
        }
    }

    fun assignOrphanReport(reportId: String, kinfolkId: String, kinfolkName: String) {
        viewModelScope.launch {
            _isLoading.value = true
            kinCareRepository.assignKinfolkToOrphanReport(reportId, kinfolkId, kinfolkName)
                .onSuccess {
                    _triageResult.value = TriageResult(true, "Assigned to $kinfolkName")
                    loadKinCareReports()
                }
                .onFailure { t ->
                    _triageResult.value = TriageResult(false, t.message ?: "Failed to assign kinfolk")
                    _isLoading.value = false
                }
        }
    }

    fun markOrphanAsDuplicate(reportId: String, duplicateOfReportId: String) {
        viewModelScope.launch {
            _isLoading.value = true
            kinCareRepository.markOrphanReportAsDuplicate(reportId, duplicateOfReportId)
                .onSuccess {
                    _triageResult.value = TriageResult(true, "Marked as duplicate")
                    loadKinCareReports()
                }
                .onFailure { t ->
                    _triageResult.value = TriageResult(false, t.message ?: "Failed to mark duplicate")
                    _isLoading.value = false
                }
        }
    }

    fun archiveOrphanAsBad(reportId: String, reason: String) {
        viewModelScope.launch {
            _isLoading.value = true
            kinCareRepository.archiveOrphanReportAsBadData(reportId, reason)
                .onSuccess {
                    _triageResult.value = TriageResult(true, "Archived as bad data")
                    loadKinCareReports()
                }
                .onFailure { t ->
                    _triageResult.value = TriageResult(false, t.message ?: "Failed to archive report")
                    _isLoading.value = false
                }
        }
    }

    fun clearTriageResult() {
        _triageResult.value = null
    }
}

/**
 * Honest summary for a bulk mark-read action. The server may mark fewer than
 * requested when some ids are stale (already gone or owned by someone else), so we
 * say so rather than implying every selection succeeded. Pure; unit-tested.
 */
internal fun bulkReadSummary(requested: Int, marked: Int): String = when {
    requested <= 0 -> "Nothing selected."
    marked == requested -> "Marked $marked read."
    marked == 0 -> "Marked 0 of $requested read (already read or no longer available)."
    else -> "Marked $marked of $requested read."
}

/**
 * Honest summary for a bulk archive action. Like [bulkReadSummary], the server may
 * archive fewer than requested when some ids are stale, so we say so rather than
 * implying every selection was dismissed. Pure; unit-tested.
 */
internal fun bulkArchiveSummary(requested: Int, archived: Int): String = when {
    requested <= 0 -> "Nothing selected."
    archived == requested -> "Dismissed $archived."
    archived == 0 -> "Dismissed 0 of $requested (already archived or no longer available)."
    else -> "Dismissed $archived of $requested."
}

/**
 * A notification is "unread" while it has no readAt marker. The dispatch status
 * (pending/dispatched) is orthogonal: a dispatched notification can still be unread.
 * Pure; unit-tested.
 */
internal fun isNotificationUnread(entry: com.tribetails.auntieos.data.admin.NotificationEntry): Boolean =
    entry.readAt.isNullOrBlank()
