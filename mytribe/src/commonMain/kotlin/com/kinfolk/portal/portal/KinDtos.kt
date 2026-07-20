package com.kinfolk.portal.portal

enum class KinStatus { Active, NoLongerWithUs }

data class Kin(
    val id: String,
    val name: String?,
    val species: String?,
    val breed: String?,
    val ageYears: Double?,
    val photoUrl: String?,
    val status: KinStatus,
    val aiBlurb: String?,
    val feedingInstructions: String?,
    val walkingInstructions: String?,
    val medications: String?,
    val allergies: String?,
    val emergencyNotes: String?,
    val sitterNotes: String?,
)

data class KinResult(val kin: List<Kin>)

/** Dog + cat breed name lists for the Kin breed dropdown (from getBreeds). */
data class BreedsResult(val dogBreeds: List<String>, val catBreeds: List<String>)
