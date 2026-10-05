package com.voynix.logic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StatsMergeTest {
    @Test
    fun `mergeEvents unions and dedupes on device+time+track`() {
        val a = listOf(PlayEvent("k1", 100, "dev1"))
        val b = listOf(PlayEvent("k1", 100, "dev1"), PlayEvent("k2", 200, "dev2"))
        val merged = mergeEvents(a, b)
        assertEquals(2, merged.size)
        assertTrue(merged.contains(PlayEvent("k2", 200, "dev2")))
    }

    @Test
    fun `mergeEvents is commutative`() {
        val a = listOf(PlayEvent("k1", 100, "dev1"), PlayEvent("k2", 200, "dev1"))
        val b = listOf(PlayEvent("k2", 200, "dev1"), PlayEvent("k3", 300, "dev2"))
        val ab = mergeEvents(a, b).toSet()
        val ba = mergeEvents(b, a).toSet()
        assertEquals(ab, ba)
    }

    @Test
    fun `favoriteWins picks the strictly newer timestamp`() {
        val local = FavoriteRow("k1", favorite = false, favoriteUpdatedAt = 100)
        val remote = FavoriteRow("k1", favorite = true, favoriteUpdatedAt = 200)
        assertEquals(remote, favoriteWins(local, remote))
        assertEquals(local, favoriteWins(local, local.copy(favoriteUpdatedAt = 100)))
    }

    @Test
    fun `favoriteWins treats null timestamp as oldest`() {
        val local = FavoriteRow("k1", favorite = true, favoriteUpdatedAt = null)
        val remote = FavoriteRow("k1", favorite = false, favoriteUpdatedAt = 1)
        assertEquals(remote, favoriteWins(local, remote))
    }

    @Test
    fun `mergeFavorites ignores incoming rows with a null timestamp`() {
        val into = listOf(FavoriteRow("k1", true, 100))
        val incoming = listOf(FavoriteRow("k1", false, null))
        assertEquals(into, mergeFavorites(into, incoming))
    }

    @Test
    fun `mergePlayStates merges state and resume_position atomically`() {
        val into = listOf(PlayStateRow("k1", PlayState.IN_PROGRESS, 42.0, 100))
        val incoming = listOf(PlayStateRow("k1", PlayState.PLAYED, 0.0, 200))
        val result = mergePlayStates(into, incoming)
        assertEquals(listOf(PlayStateRow("k1", PlayState.PLAYED, 0.0, 200)), result)
    }

    @Test
    fun `mergePlayStates keeps incumbent on a tie`() {
        val into = listOf(PlayStateRow("k1", PlayState.IN_PROGRESS, 10.0, 100))
        val incoming = listOf(PlayStateRow("k1", PlayState.PLAYED, 0.0, 100))
        assertEquals(into, mergePlayStates(into, incoming))
    }
}
