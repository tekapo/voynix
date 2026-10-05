package com.voynix.logic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QueueTest {
    @Test
    fun `buildOrder without shuffle is identity`() {
        assertEquals(listOf(0, 1, 2, 3), buildOrder(4, BuildOrderOpts(shuffle = false)))
    }

    @Test
    fun `buildOrder with shuffle is a full permutation`() {
        val order = buildOrder(5, BuildOrderOpts(shuffle = true, rng = { 0.999 }))
        assertEquals((0..4).toSet(), order.toSet())
        assertEquals(5, order.size)
    }

    @Test
    fun `buildOrder pins first when given`() {
        val order = buildOrder(5, BuildOrderOpts(shuffle = true, first = 3, rng = { 0.0 }))
        assertEquals(3, order[0])
    }

    @Test
    fun `buildOrder avoids avoidFirst landing at position 0`() {
        // rng always 0.0 -> Fisher-Yates leaves order as [0,1,2,3,4]; avoidFirst=0
        // must trigger the swap-away-from-0 branch.
        val order = buildOrder(5, BuildOrderOpts(shuffle = true, avoidFirst = 0, rng = { 0.0 }))
        assertTrue(order[0] != 0)
        assertEquals((0..4).toSet(), order.toSet())
    }

    @Test
    fun `stepOrder moves forward within bounds`() {
        val result = stepOrder(1, 5, 1, RepeatMode.OFF)
        assertEquals(StepResult(2, false), result)
    }

    @Test
    fun `stepOrder off the end with repeat off stops`() {
        assertNull(stepOrder(4, 5, 1, RepeatMode.OFF))
    }

    @Test
    fun `stepOrder off the end with repeat all wraps and reshuffles`() {
        assertEquals(StepResult(0, true), stepOrder(4, 5, 1, RepeatMode.ALL))
    }

    @Test
    fun `stepOrder off the start with repeat off clamps to 0`() {
        assertEquals(StepResult(0, false), stepOrder(0, 5, -1, RepeatMode.OFF))
    }

    @Test
    fun `stepOrder off the start with repeat all jumps to tail without reshuffle`() {
        assertEquals(StepResult(4, false), stepOrder(0, 5, -1, RepeatMode.ALL))
    }

    @Test
    fun `reorderUpcoming swaps only entries after the cursor`() {
        val order = listOf(0, 1, 2, 3, 4)
        assertEquals(listOf(0, 1, 3, 2, 4), reorderUpcoming(order, orderPos = 1, from = 2, dir = 1))
        // from == orderPos is not movable
        assertEquals(order, reorderUpcoming(order, orderPos = 1, from = 1, dir = 1))
    }

    @Test
    fun `removeUpcoming drops only entries after the cursor`() {
        val order = listOf(0, 1, 2, 3, 4)
        assertEquals(listOf(0, 1, 2, 4), removeUpcoming(order, orderPos = 1, at = 3))
        assertEquals(order, removeUpcoming(order, orderPos = 1, at = 1))
    }

    @Test
    fun `peekNext returns the following queue index inside bounds`() {
        assertEquals(1, peekNext(0, listOf(3, 1, 2), RepeatMode.OFF, shuffled = false))
    }

    @Test
    fun `peekNext returns null on an empty order`() {
        assertNull(peekNext(0, emptyList(), RepeatMode.OFF, shuffled = false))
    }

    @Test
    fun `peekNext returns null past the end with repeat off`() {
        assertNull(peekNext(2, listOf(3, 1, 2), RepeatMode.OFF, shuffled = false))
        assertNull(peekNext(2, listOf(3, 1, 2), RepeatMode.OFF, shuffled = true))
    }

    @Test
    fun `peekNext wraps to the start past the end with repeat all, unshuffled`() {
        assertEquals(3, peekNext(2, listOf(3, 1, 2), RepeatMode.ALL, shuffled = false))
    }

    @Test
    fun `peekNext can't predict a shuffled repeat-all wrap`() {
        assertNull(peekNext(2, listOf(3, 1, 2), RepeatMode.ALL, shuffled = true))
    }

    @Test
    fun `peekNext repeat one always points at the current track`() {
        assertEquals(1, peekNext(1, listOf(3, 1, 2), RepeatMode.ONE, shuffled = false))
        assertEquals(2, peekNext(2, listOf(3, 1, 2), RepeatMode.ONE, shuffled = true))
    }

    @Test
    fun `peekNext repeat one on an empty order is still null`() {
        assertNull(peekNext(0, emptyList(), RepeatMode.ONE, shuffled = false))
    }

    @Test
    fun `cycleRepeat goes off then all then one then off`() {
        assertEquals(RepeatMode.ALL, RepeatMode.OFF.cycle())
        assertEquals(RepeatMode.ONE, RepeatMode.ALL.cycle())
        assertEquals(RepeatMode.OFF, RepeatMode.ONE.cycle())
    }

    @Test
    fun `effectiveShuffle turns shuffle off for a podcast queue when the setting is on`() {
        val podcast = listOf("podcast", "podcast")
        assertEquals(false, effectiveShuffle(true, true, podcast))
        assertEquals(true, effectiveShuffle(true, false, podcast))
    }

    @Test
    fun `effectiveShuffle keeps shuffle for music, mixed and empty queues and never turns it on`() {
        assertEquals(true, effectiveShuffle(true, true, listOf("music", "music")))
        assertEquals(true, effectiveShuffle(true, true, listOf("music", "podcast")))
        assertEquals(true, effectiveShuffle(true, true, emptyList()))
        assertEquals(false, effectiveShuffle(false, false, listOf("music")))
        assertEquals(false, effectiveShuffle(false, true, listOf("podcast")))
    }

    @Test
    fun `queue snapshot round-trips through json and rejects garbage`() {
        val snap = QueueSnapshot(listOf("a", "b", "c"), listOf(2, 0, 1), 1)
        assertEquals(snap, decodeQueueSnapshot(encodeQueueSnapshot(snap)))
        assertNull(decodeQueueSnapshot(null))
        assertNull(decodeQueueSnapshot("not json"))
    }

    @Test
    fun `remapSnapshot with everything present is unchanged`() {
        val snap = QueueSnapshot(listOf("a", "b", "c"), listOf(2, 0, 1), 1)
        assertEquals(snap, remapSnapshot(snap, setOf("a", "b", "c")))
    }

    @Test
    fun `remapSnapshot drops a removed track and keeps the cursor on the same track`() {
        // order plays c, a, b; cursor on a. Removing b (queue index 1) shifts c to index 1.
        val snap = QueueSnapshot(listOf("a", "b", "c"), listOf(2, 0, 1), 1)
        assertEquals(QueueSnapshot(listOf("a", "c"), listOf(1, 0), 1), remapSnapshot(snap, setOf("a", "c")))
    }

    @Test
    fun `remapSnapshot moves the cursor to the next survivor when its track was removed`() {
        val snap = QueueSnapshot(listOf("a", "b", "c"), listOf(2, 0, 1), 1) // cursor on a
        val result = remapSnapshot(snap, setOf("b", "c"))!!
        assertEquals(listOf("b", "c"), result.ids)
        assertEquals(listOf(1, 0), result.order)
        assertEquals(1, result.pos) // now b, the next in the order
    }

    @Test
    fun `remapSnapshot clamps the cursor when nothing after it survives and returns null when all are gone`() {
        val snap = QueueSnapshot(listOf("a", "b", "c"), listOf(0, 1, 2), 2) // cursor on c
        assertEquals(1, remapSnapshot(snap, setOf("a", "b"))!!.pos)
        assertNull(remapSnapshot(snap, emptySet()))
    }

    @Test
    fun `alignSnapshotCursor moves a stale cursor onto the last-played track`() {
        val snap = QueueSnapshot(listOf("a", "b", "c"), listOf(0, 1, 2), 0)
        assertEquals(2, alignSnapshotCursor(snap, "c").pos)
    }

    @Test
    fun `alignSnapshotCursor follows the shuffled order`() {
        val snap = QueueSnapshot(listOf("a", "b", "c"), listOf(2, 0, 1), 0)
        assertEquals(2, alignSnapshotCursor(snap, "b").pos)
    }

    @Test
    fun `alignSnapshotCursor leaves a matching, null or unknown track alone`() {
        val snap = QueueSnapshot(listOf("a", "b", "c"), listOf(0, 1, 2), 1)
        assertEquals(snap, alignSnapshotCursor(snap, "b"))
        assertEquals(snap, alignSnapshotCursor(snap, null))
        assertEquals(snap, alignSnapshotCursor(snap, "zzz"))
    }
}
