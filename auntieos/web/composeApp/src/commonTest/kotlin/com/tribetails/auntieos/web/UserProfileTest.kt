package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.UserProfile
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class UserProfileTest {

    @Test
    fun userProfile_defaultFields_areBlank() {
        val u = UserProfile()
        assertEquals("", u._id)
        assertEquals("", u.uid)
        assertEquals("", u.email)
        assertEquals("", u.displayName)
        assertEquals("", u.firstName)
        assertEquals("", u.lastName)
        assertEquals("", u.phone)
        assertEquals("", u.title)
        assertEquals("", u.photoUrl)
        assertEquals("", u.bio)
        assertEquals("", u.createdAt)
        assertEquals("", u.updatedAt)
    }

    @Test
    fun userProfile_displayLabel_prefersDisplayName() {
        val u = UserProfile(displayName = "Aunt Sue", firstName = "Susan", lastName = "Hayes", email = "s@h.com")
        assertEquals("Aunt Sue", u.displayLabel)
    }

    @Test
    fun userProfile_displayLabel_fallsBackToFirstLast() {
        val u = UserProfile(firstName = "Susan", lastName = "Hayes", email = "s@h.com")
        assertEquals("Susan Hayes", u.displayLabel)
    }

    @Test
    fun userProfile_displayLabel_fallsBackToEmail() {
        val u = UserProfile(email = "s@h.com")
        assertEquals("s@h.com", u.displayLabel)
    }

    @Test
    fun userProfile_displayLabel_fallsBackToPlaceholder() {
        val u = UserProfile()
        assertEquals("Unnamed User", u.displayLabel)
    }

    @Test
    fun userProfile_initials_takesFirstLast() {
        assertEquals("AB", UserProfile(firstName = "Anna", lastName = "Banks").initials)
    }

    @Test
    fun userProfile_initials_fallsBackToDisplayNameWords() {
        assertEquals("AS", UserProfile(displayName = "Aunt Sue").initials)
    }

    @Test
    fun userProfile_initials_fallsBackToEmailFirstChar() {
        assertEquals("S", UserProfile(email = "syd@example.com").initials)
    }

    @Test
    fun userProfile_initials_blankWhenNothingSet() {
        assertEquals("", UserProfile().initials)
    }

    @Test
    fun userProfile_serializesAndRoundTrips() {
        val original = UserProfile(
            _id = "abc",
            uid = "abc",
            email = "syd@example.com",
            displayName = "Syd",
            firstName = "Sydney",
            lastName = "East",
            phone = "555-1234",
            title = "Founder",
            photoUrl = "https://res.cloudinary.com/x/image/upload/v1/profile.jpg",
            bio = "Loves dogs.",
            createdAt = "2026-05-09T00:00:00Z",
            updatedAt = "2026-05-09T01:00:00Z",
        )
        val json = Json { ignoreUnknownKeys = true }
        val text = json.encodeToString(UserProfile.serializer(), original)
        val parsed = json.decodeFromString(UserProfile.serializer(), text)
        assertEquals(original, parsed)
        assertTrue(text.contains("\"phone\":\"555-1234\""))
    }
}
