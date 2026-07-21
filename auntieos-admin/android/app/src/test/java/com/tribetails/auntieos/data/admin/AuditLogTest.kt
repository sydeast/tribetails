package com.tribetails.auntieos.data.admin

import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * Verifies the awaited [AuditLog.fireSync] variant introduced for
 * AuntieRepository.saveFormSchema / deleteFormSchema. Previous fire-and-forget
 * AuditLog.fire launched a detached CoroutineScope(Dispatchers.IO) - if the
 * app process was killed between repo call return and the audit write
 * completing, the activity_log row would drop silently. fireSync suspends
 * until the underlying repository.logActivity finishes (success or failure),
 * so the audit row is committed before the caller continues.
 *
 * These tests cover the two contracts the saveFormSchema / deleteFormSchema
 * audit pattern requires:
 *   1. logActivity is invoked exactly once per fireSync call
 *   2. fireSync awaits - does not return until the suspending repo call
 *      completes (verified implicitly via runTest + coVerify).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AuditLogTest {

    private val repository = mockk<AuntieRepository>(relaxed = true)

    @Test
    fun `fireSync invokes logActivity exactly once with SAVE_FORM_SCHEMA action`() = runTest {
        coEvery { repository.logActivity(any()) } returns Result.success(Unit)

        AuditLog.fireSync(
            repository       = repository,
            actionType       = "SAVE_FORM_SCHEMA",
            description      = "Saved form schema tribeProfile",
            targetId         = "tribeProfile",
            targetCollection = "formSchemas",
        )

        coVerify(exactly = 1) {
            repository.logActivity(match<ActivityLogEntry> {
                it.actionType == "SAVE_FORM_SCHEMA" &&
                    it.targetId == "tribeProfile" &&
                    it.targetCollection == "formSchemas" &&
                    it.status == "SUCCESS"
            })
        }
    }

    @Test
    fun `fireSync invokes logActivity exactly once with DELETE_FORM_SCHEMA action`() = runTest {
        coEvery { repository.logActivity(any()) } returns Result.success(Unit)

        AuditLog.fireSync(
            repository       = repository,
            actionType       = "DELETE_FORM_SCHEMA",
            description      = "Deleted form schema tribeProfile",
            targetId         = "tribeProfile",
            targetCollection = "formSchemas",
        )

        coVerify(exactly = 1) {
            repository.logActivity(match<ActivityLogEntry> {
                it.actionType == "DELETE_FORM_SCHEMA" &&
                    it.targetId == "tribeProfile" &&
                    it.targetCollection == "formSchemas"
            })
        }
    }

    @Test
    fun `fireSync surfaces repository failure without retry`() = runTest {
        // Per fail-loud-policy: logActivity itself routes errors through
        // AuntieLog.e and returns Result.failure - fireSync does NOT swallow,
        // it just returns once the suspending call completes. Verifies that
        // a single attempt was made even on failure (no silent retry loop).
        coEvery { repository.logActivity(any()) } returns
            Result.failure(RuntimeException("firestore offline"))

        AuditLog.fireSync(
            repository  = repository,
            actionType  = "SAVE_FORM_SCHEMA",
            description = "Saved form schema x",
            targetId    = "x",
        )

        coVerify(exactly = 1) { repository.logActivity(any()) }
    }
}
