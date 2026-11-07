package com.tribetails.auntieos.domain
import com.tribetails.auntieos.data.model.VetClinic
import org.junit.Assert.assertEquals
import org.junit.Test
/** #1565: the vet bank pages by document id, so A to Z is rebuilt here and nothing is dropped. */
class VetClinicOrderTest {
    @Test
    fun `sorts A to Z by name and keeps a clinic with no name first`() {
        val out = sortVetClinics(
            listOf(
                VetClinic(id = "b", name = "Zoo Vet"),
                VetClinic(id = "a"),
                VetClinic(id = "c", name = "animal care"),
            ),
        )
        assertEquals(listOf("a", "c", "b"), out.map { it.id })
    }
    @Test
    fun `equal names keep a stable order by id`() {
        val out = sortVetClinics(listOf(VetClinic(id = "y", name = "Same"), VetClinic(id = "x", name = "Same")))
        assertEquals(listOf("x", "y"), out.map { it.id })
    }
}
