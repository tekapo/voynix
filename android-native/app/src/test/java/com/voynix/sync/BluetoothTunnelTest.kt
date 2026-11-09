package com.voynix.sync

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.net.Socket
import java.net.URI

class BluetoothTunnelTest {
    @Test
    fun `channel info is the big-endian PSM followed by the fingerprint prefix`() {
        val info = parseChannelInfo(byteArrayOf(0x00, 0x81.toByte(), 0x0A, 0x0B))!!
        assertEquals(0x81, info.psm)
        assertArrayEquals(byteArrayOf(0x0A, 0x0B), info.fingerprintPrefix)
    }

    @Test
    fun `a PSM of two full bytes is read unsigned`() {
        assertEquals(0xFFFE, parseChannelInfo(byteArrayOf(0xFF.toByte(), 0xFE.toByte()))!!.psm)
    }

    @Test
    fun `channel info that is missing, short or has no PSM is rejected`() {
        assertNull(parseChannelInfo(null))
        assertNull(parseChannelInfo(byteArrayOf(0x01)))
        assertNull(parseChannelInfo(byteArrayOf(0x00, 0x00, 0x01)))
    }

    @Test
    fun `a Mac is accepted only when its fingerprint prefix starts the saved pin`() {
        val pin = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
        val prefix = byteArrayOf(0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77)
        assertTrue(fingerprintMatchesPin(prefix, pin))
        assertTrue(fingerprintMatchesPin(prefix, pin.uppercase()))
        assertFalse(fingerprintMatchesPin(byteArrayOf(0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x78), pin))
        assertFalse(fingerprintMatchesPin(prefix, null))
    }

    @Test
    fun `a Mac that advertises no prefix is not ruled out, since the TLS pin decides`() {
        assertTrue(fingerprintMatchesPin(byteArrayOf(), "00112233"))
    }

    /** A channel whose far end echoes back whatever is written, upper-cased. */
    private class EchoChannel : TunnelChannel {
        private val toFar = PipedOutputStream()
        private val farIn = PipedInputStream(toFar, 8192)
        private val farOut = PipedOutputStream()
        private val fromFar = PipedInputStream(farOut, 8192)
        override val input get() = fromFar
        override val output get() = toFar

        init {
            Thread {
                try {
                    val buf = ByteArray(1024)
                    while (true) {
                        val n = farIn.read(buf)
                        if (n < 0) break
                        farOut.write(String(buf, 0, n).uppercase().toByteArray())
                        farOut.flush()
                    }
                } catch (_: IOException) {
                }
                runCatching { farOut.close() }
            }.apply { isDaemon = true }.start()
        }

        override fun close() {
            runCatching { toFar.close() }
            runCatching { fromFar.close() }
        }
    }

    private fun connect(bridge: LocalBridge): Socket {
        val uri = URI(bridge.url)
        assertEquals("127.0.0.1", uri.host)
        return Socket(uri.host, uri.port).apply { soTimeout = 5000 }
    }

    @Test
    fun `bytes sent to the local bridge reach the channel and the reply comes back`() {
        val bridge = LocalBridge { EchoChannel() }
        try {
            connect(bridge).use { s ->
                s.getOutputStream().write("hello".toByteArray())
                s.getOutputStream().flush()
                val reply = ByteArray(5)
                var got = 0
                while (got < 5) got += s.getInputStream().read(reply, got, 5 - got)
                assertEquals("HELLO", String(reply))
            }
        } finally {
            bridge.close()
        }
    }

    @Test
    fun `each connection to the bridge gets its own channel`() {
        var opened = 0
        val bridge = LocalBridge { synchronized(this) { opened++ }; EchoChannel() }
        try {
            val a = connect(bridge)
            val b = connect(bridge)
            for ((sock, word) in listOf(a to "one", b to "two")) {
                sock.getOutputStream().write(word.toByteArray())
                sock.getOutputStream().flush()
                val reply = ByteArray(word.length)
                var got = 0
                while (got < reply.size) got += sock.getInputStream().read(reply, got, reply.size - got)
                assertEquals(word.uppercase(), String(reply))
            }
            assertEquals(2, opened)
            a.close()
            b.close()
        } finally {
            bridge.close()
        }
    }

    @Test
    fun `a channel that cannot be opened closes the local connection`() {
        val bridge = LocalBridge { throw IOException("no Mac") }
        try {
            connect(bridge).use { s ->
                // Reads end (EOF or reset) instead of hanging.
                val n = try { s.getInputStream().read() } catch (_: IOException) { -1 }
                assertEquals(-1, n)
            }
        } finally {
            bridge.close()
        }
    }

    @Test
    fun `closing the bridge stops accepting connections`() {
        val bridge = LocalBridge { EchoChannel() }
        val uri = URI(bridge.url)
        bridge.close()
        val refused = try { Socket(uri.host, uri.port).close(); false } catch (_: IOException) { true }
        assertTrue(refused)
    }
}
