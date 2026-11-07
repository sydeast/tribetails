package com.tribetails.auntieos.media
import com.tribetails.auntieos.data.model.MediaEntityType
import org.junit.Assert.assertEquals
import org.junit.Test
/** #1588: which household a new media row is stamped with, per upload target. */
class MediaKinfolkIdForTest {
    @Test fun aHouseholdUploadIsStampedWithItsOwnId() {
        assertEquals("kf1", mediaKinfolkIdFor(MediaEntityType.KINFOLK, "kf1", ""))
    }
    @Test fun aKinUploadIsStampedWithItsHouseholdNotThePetId() {
        assertEquals("kf9", mediaKinfolkIdFor(MediaEntityType.KIN, "pet1", " kf9 "))
    }
    @Test fun aKinUploadWithNoHouseholdStaysBlankSoTheKeyIsLeftOff() {
        assertEquals("", mediaKinfolkIdFor(MediaEntityType.KIN, "pet1", ""))
    }
    @Test fun companyAndOtherTargetsNeverCarryAHousehold() {
        assertEquals("", mediaKinfolkIdFor(MediaEntityType.BUSINESS, "business_settings", "kf1"))
        assertEquals("", mediaKinfolkIdFor(MediaEntityType.VISIT_LOG, "session1", "kf1"))
    }
}
