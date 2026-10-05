package com.voynix.logic

import com.voynix.testutil.testVectorFile
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@Serializable
private data class PairingQrVector(val url: String, val token: String, val fingerprint: String, val payload: String)

@Serializable
private data class PairingQrVectorsFile(val vectors: List<PairingQrVector>, val invalid: List<String>)

class PairingQrTest {
    private val file = Json { ignoreUnknownKeys = true }
        .decodeFromString<PairingQrVectorsFile>(testVectorFile("pairing-qr.json").readText())

    @Test
    fun `parses every shared vector`() {
        for (v in file.vectors) {
            assertEquals(PairingQr(v.url, v.token, v.fingerprint), parsePairingQr(v.payload))
        }
    }

    @Test
    fun `rejects every invalid payload`() {
        for (raw in file.invalid) {
            assertNull("should reject: $raw", parsePairingQr(raw))
        }
    }

    @Test
    fun `tolerates surrounding whitespace`() {
        val v = file.vectors.first()
        assertEquals(PairingQr(v.url, v.token, v.fingerprint), parsePairingQr("  ${v.payload}\n"))
    }
}
