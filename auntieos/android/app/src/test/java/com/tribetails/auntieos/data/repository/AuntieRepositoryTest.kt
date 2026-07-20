package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.api.N8nApi
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AuntieRepositoryTest {

    private lateinit var repository: AuntieRepository
    private val n8nApi = mockk<N8nApi>()

    @Before
    fun setup() {
        repository = AuntieRepository(n8nApi)
    }

    @Test
    fun `placeholder - repository constructs without error`() = runBlocking {
        assertTrue(true)
    }
}
