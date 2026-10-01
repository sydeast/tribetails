package com.tribetails.auntieos.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.runCatchingCancellable

/**
 * #957: the shared email frame (colors, header line, logo, footer line) through
 * its three owner-only callables (`mytribe/functions/src/admin/emailFrameSettings.ts`).
 * The frame document is denied to every client in the rules, so there is no
 * direct Firestore path. Spec: docs/superpowers/specs/2026-09-28-email-frame-editor-design.md
 */
class EmailFrameRepository(
    private val functions: FirebaseFunctions = FirebaseFunctions.getInstance("us-central1"),
) {

    /** What the server holds. [stored] has only the fields the operator set; [defaults] has every field. */
    data class EmailFrameState(
        val stored: Map<String, String>,
        val defaults: Map<String, String>,
        val updatedAt: String?,
        val updatedBy: String?,
    )

    data class FramePreview(val subject: String, val html: String, val text: String)

    suspend fun getEmailFrame(): Result<EmailFrameState> = runCatchingCancellable {
        decodeState(invoke("getEmailFrame", emptyMap<String, Any>()), "getEmailFrame")
    }.onFailure { log("getEmailFrame", it) }

    /**
     * Sends only [changes]: a value sets a field, null resets it to its default,
     * and a field left out is untouched on the server. The caller builds
     * [changes] as a diff against what it loaded, never a rebuilt whole.
     */
    suspend fun saveEmailFrame(changes: Map<String, String?>): Result<EmailFrameState> = runCatchingCancellable {
        require(changes.isNotEmpty()) { "Nothing to save." }
        decodeState(invoke("saveEmailFrame", mapOf("changes" to changes)), "saveEmailFrame")
    }.onFailure { log("saveEmailFrame", it) }

    /** Every frame field back to its default. */
    suspend fun resetEmailFrame(): Result<EmailFrameState> = runCatchingCancellable {
        decodeState(invoke("saveEmailFrame", mapOf("resetAll" to true)), "saveEmailFrame")
    }.onFailure { log("resetEmailFrame", it) }

    /** The server's render of a sample email in [frame] (the draft's set fields). */
    suspend fun previewEmailFrame(frame: Map<String, String>): Result<FramePreview> = runCatchingCancellable {
        val raw = invoke("previewEmailFrame", mapOf("frame" to frame))
        FramePreview(
            subject = raw["subject"] as? String ?: "",
            html = raw["html"] as? String ?: error("previewEmailFrame: missing html"),
            text = raw["text"] as? String ?: "",
        )
    }.onFailure { log("previewEmailFrame", it) }

    private suspend fun invoke(name: String, payload: Map<String, Any?>): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return functions.getHttpsCallable(name).call(payload).awaitCallable().data as? Map<String, Any?>
            ?: error("$name: non-map payload")
    }

    private fun log(name: String, t: Throwable) {
        if (t is kotlinx.coroutines.CancellationException) throw t
        AuntieLog.e("EmailFrameRepository.$name failed", t)
    }

    companion object {
        internal fun decodeState(raw: Map<String, Any?>, name: String): EmailFrameState {
            val defaults = stringMap(raw["defaults"])
            if (defaults.isEmpty()) error("$name: missing defaults")
            return EmailFrameState(
                stored = stringMap(raw["stored"]),
                defaults = defaults,
                updatedAt = raw["updatedAt"] as? String,
                updatedBy = raw["updatedBy"] as? String,
            )
        }

        private fun stringMap(v: Any?): Map<String, String> =
            (v as? Map<*, *>).orEmpty().mapNotNull { (k, value) ->
                val key = k as? String ?: return@mapNotNull null
                val s = value as? String ?: return@mapNotNull null
                key to s
            }.toMap()
    }
}
