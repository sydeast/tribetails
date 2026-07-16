package com.kinfolk.portal.notifications

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NotificationCatalogRepositoryTest {

    private fun catalogStub() = buildJsonObject {
        put("schemaVersion", 1)
        put(
            "categories",
            buildJsonArray {
                add(
                    buildJsonObject {
                        put("id", "visit")
                        put("title", "Visit Updates")
                        put("description", "Real-time status")
                        put(
                            "keys",
                            buildJsonArray {
                                add(
                                    buildJsonObject {
                                        put("key", "kincare.auntie.on_my_way")
                                        put("title", "On My Way")
                                        put("description", "Auntie en route")
                                        put(
                                            "allowedChannels",
                                            buildJsonArray {
                                                add("email"); add("sms"); add("push")
                                            },
                                        )
                                        put("required", buildJsonArray { /* none */ })
                                        put("lockedChannels", buildJsonArray { add("sms") })
                                        put("marketingCategory", JsonNull)
                                    },
                                )
                            },
                        )
                    },
                )
                add(
                    buildJsonObject {
                        put("id", "marketing")
                        put("title", "Newsletters")
                        put("description", "Opt-in")
                        put(
                            "keys",
                            buildJsonArray {
                                add(
                                    buildJsonObject {
                                        put("key", "marketing.optin")
                                        put("title", "Promotions")
                                        put("description", "Promo")
                                        put(
                                            "allowedChannels",
                                            buildJsonArray { add("email") },
                                        )
                                        put("required", buildJsonArray { add("email") })
                                        put("marketingCategory", "marketing")
                                    },
                                )
                            },
                        )
                    },
                )
            },
        )
    }

    @Test
    fun loads_and_decodes_categories() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getNotificationCatalog", catalogStub())
        val repo = NotificationCatalogRepository(fake)

        val state = repo.load()
        val success = assertIs<CatalogState.Success>(state)
        assertEquals(2, success.categories.size)
        assertEquals("visit", success.categories[0].id)
        assertEquals("Visit Updates", success.categories[0].title)
        assertEquals(1, success.categories[0].keys.size)

        val key = success.categories[0].keys[0]
        assertEquals("kincare.auntie.on_my_way", key.key)
        assertEquals(setOf(NotificationChannel.EMAIL, NotificationChannel.SMS, NotificationChannel.PUSH), key.allowedChannels)
        assertTrue(key.required.isEmpty())
        // Run-4 #13: admin-locked channels decode (read-only for the kinfolk).
        assertEquals(setOf(NotificationChannel.SMS), key.lockedChannels)
        assertEquals(null, key.marketingCategory)
    }

    @Test
    fun decodes_marketing_keys_with_required_channels() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getNotificationCatalog", catalogStub())
        val repo = NotificationCatalogRepository(fake)

        val state = repo.load()
        val success = assertIs<CatalogState.Success>(state)
        val marketingCat = success.categories.first { it.id == "marketing" }
        val key = marketingCat.keys[0]
        assertEquals(MarketingCategory.MARKETING, key.marketingCategory)
        assertEquals(setOf(NotificationChannel.EMAIL), key.required)
    }

    @Test
    fun caches_success_across_calls() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getNotificationCatalog", catalogStub())
        val repo = NotificationCatalogRepository(fake)

        repo.load()
        repo.load()
        repo.load()
        // Only ONE network call despite three load() invocations.
        assertEquals(1, fake.calls.count { it.first == "getNotificationCatalog" })
    }

    // Notification revamp: keys gain an operator-authored lockReason
    // (string | null). Decode must be null-safe: absent and JSON null both
    // land as Kotlin null.
    @Test
    fun decodes_lockReason_string_null_and_absent() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getNotificationCatalog", buildJsonObject {
            put("schemaVersion", 2)
            put(
                "categories",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("id", "account")
                            put("title", "Account & Security")
                            put("description", "Always-on account notices")
                            put(
                                "keys",
                                buildJsonArray {
                                    add(
                                        buildJsonObject {
                                            put("key", "auth.password.reset")
                                            put("title", "Password Reset")
                                            put("description", "Reset link")
                                            put("allowedChannels", buildJsonArray { add("email") })
                                            put("required", buildJsonArray { })
                                            put("lockedChannels", buildJsonArray { add("email") })
                                            put("lockReason", "Password resets always go to your email so your account stays yours.")
                                            put("marketingCategory", JsonNull)
                                        },
                                    )
                                    add(
                                        buildJsonObject {
                                            put("key", "auth.account.locked")
                                            put("title", "Account Locked")
                                            put("description", "Lockout notice")
                                            put("allowedChannels", buildJsonArray { add("email") })
                                            put("required", buildJsonArray { })
                                            put("lockedChannels", buildJsonArray { add("email") })
                                            put("lockReason", JsonNull)
                                        },
                                    )
                                    add(
                                        buildJsonObject {
                                            put("key", "auth.welcome")
                                            put("title", "Welcome")
                                            put("description", "Welcome note")
                                            put("allowedChannels", buildJsonArray { add("email") })
                                            put("required", buildJsonArray { })
                                            put("lockedChannels", buildJsonArray { add("email") })
                                            // lockReason intentionally absent
                                        },
                                    )
                                },
                            )
                        },
                    )
                },
            )
        })
        val repo = NotificationCatalogRepository(fake)

        val success = assertIs<CatalogState.Success>(repo.load())
        val keys = success.categories.single().keys
        assertEquals(3, keys.size)
        assertEquals(
            "Password resets always go to your email so your account stays yours.",
            keys[0].lockReason,
        )
        assertNull(keys[1].lockReason)
        assertNull(keys[2].lockReason)
    }

    // Older backend payloads (no lockReason field anywhere) keep decoding.
    @Test
    fun lockReason_defaults_to_null_on_legacy_payloads() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getNotificationCatalog", catalogStub())
        val repo = NotificationCatalogRepository(fake)

        val success = assertIs<CatalogState.Success>(repo.load())
        success.categories.flatMap { it.keys }.forEach { key ->
            assertNull(key.lockReason, "expected null lockReason for ${key.key}")
        }
    }

    // Category ids are plain strings client-side, so a future server-side
    // category (e.g. 'messages') must decode and keep its server-provided
    // title/description instead of being dropped or crashing the decode.
    @Test
    fun unknown_category_ids_decode_with_server_title_and_description() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getNotificationCatalog", buildJsonObject {
            put("schemaVersion", 2)
            put(
                "categories",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("id", "messages")
                            put("title", "Messages")
                            put("description", "Direct messages from your Auntie business.")
                            put(
                                "keys",
                                buildJsonArray {
                                    add(
                                        buildJsonObject {
                                            put("key", "message.received")
                                            put("title", "Message Received")
                                            put("description", "When a new message arrives.")
                                            put("allowedChannels", buildJsonArray { add("email"); add("push") })
                                            put("required", buildJsonArray { })
                                            put("lockedChannels", buildJsonArray { })
                                        },
                                    )
                                },
                            )
                        },
                    )
                },
            )
        })
        val repo = NotificationCatalogRepository(fake)

        val success = assertIs<CatalogState.Success>(repo.load())
        val cat = success.categories.single()
        assertEquals("messages", cat.id)
        assertEquals("Messages", cat.title)
        assertEquals("Direct messages from your Auntie business.", cat.description)
        val key = cat.keys.single()
        assertEquals("message.received", key.key)
        assertEquals("Message Received", key.title)
        assertEquals(setOf(NotificationChannel.EMAIL, NotificationChannel.PUSH), key.allowedChannels)
    }

    @Test
    fun returns_failure_on_network_error_with_message() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getNotificationCatalog", IllegalStateException("catalog server down"))
        val repo = NotificationCatalogRepository(fake)

        val state = repo.load()
        val failure = assertIs<CatalogState.Failure>(state)
        assertEquals("catalog server down", failure.message)
    }

}
