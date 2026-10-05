package com.voynix.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.ShuffleOn
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import android.graphics.Bitmap
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.voynix.R
import com.voynix.artwork.AlbumArtResolver
import com.voynix.data.db.TrackEntity

/**
 * Title/subtitle + Play/Shuffle actions above a track list — playlist, artist, or album detail.
 * The Play button is a play/pause toggle: [isPlaying] (true only while *this* collection is the
 * one currently playing) switches it to a Pause icon that calls [onPlay] to stop, rather than
 * restarting the collection from the top. The Shuffle button is an icon-only on/off toggle — it never
 * starts playback itself, only flips [shuffleOn] via [onToggleShuffle]. [showShuffle] is false for
 * a Podcast playlist while the "don't shuffle podcasts" setting is on: shuffling it would be a
 * no-op, so the button would just be misleading.
 */
@Composable
fun CollectionHeader(
    title: String,
    meta: String,
    tracks: List<TrackEntity>,
    albumArt: AlbumArtResolver,
    isPlaying: Boolean,
    onPlay: () -> Unit,
    onToggleShuffle: () -> Unit,
    shuffleOn: Boolean,
    showShuffle: Boolean = true,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth().padding(16.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            CollectionCover(tracks = tracks, albumArt = albumArt)
            Spacer(Modifier.width(16.dp))
            Column {
                Text(
                    title,
                    style = MaterialTheme.typography.headlineSmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Row(
            modifier = Modifier.padding(top = 16.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                onClick = onPlay,
                shape = RoundedCornerShape(percent = 50),
                color = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Icon(
                        if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Text(
                        stringResource(if (isPlaying) R.string.player_pause else R.string.collection_header_play),
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
            if (showShuffle) {
                Surface(
                    checked = shuffleOn,
                    onCheckedChange = { onToggleShuffle() },
                    shape = RoundedCornerShape(percent = 50),
                    color = if (shuffleOn) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh,
                    contentColor = if (shuffleOn) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                ) {
                    Icon(
                        if (shuffleOn) Icons.Filled.ShuffleOn else Icons.Filled.Shuffle,
                        contentDescription = stringResource(
                            if (shuffleOn) R.string.collection_header_shuffle_on else R.string.collection_header_shuffle,
                        ),
                        modifier = Modifier.padding(10.dp).size(20.dp),
                    )
                }
            }
        }
    }
}

private val CoverShape = RoundedCornerShape(20.dp)

/** Upper bound on tracks whose art is resolved while hunting for four distinct covers. */
private const val COVER_CANDIDATES = 24

/**
 * Header cover built from the *resolved* art: a 2x2 mosaic for four visually distinct
 * images, side by side for two, one tall + two stacked for three, the image alone for one,
 * the gradient when none. Distinctness
 * is judged on the image itself (16x16 thumbnail pixels), not the (artist, album) tags —
 * differing tags often still resolve to the same cover.
 */
@Composable
private fun CollectionCover(tracks: List<TrackEntity>, albumArt: AlbumArtResolver) {
    var covers by remember(tracks) { mutableStateOf<List<Bitmap>>(emptyList()) }

    LaunchedEffect(tracks) {
        val picked = mutableListOf<Bitmap>()
        val fingerprints = mutableListOf<IntArray>()
        val candidates = tracks.distinctBy { (it.artist ?: "") to (it.album ?: "") }.take(COVER_CANDIDATES)
        for (t in candidates) {
            val bitmap = albumArt.resolve(t.artist, t.album, t.filePath) ?: continue
            val fp = withContext(Dispatchers.Default) { fingerprint(bitmap) }
            if (fingerprints.any { it.contentEquals(fp) }) continue
            picked += bitmap
            fingerprints += fp
            if (picked.size == 4) break
        }
        covers = picked
    }

    val coverModifier = Modifier.size(88.dp).clip(CoverShape)
    when {
        covers.isEmpty() -> Box(
            modifier = coverModifier.background(
                Brush.linearGradient(
                    listOf(MaterialTheme.colorScheme.tertiaryContainer, MaterialTheme.colorScheme.primaryContainer),
                ),
            ),
        )
        covers.size == 1 -> CoverImage(covers.first(), coverModifier)
        covers.size == 2 -> Row(modifier = coverModifier) {
            for (b in covers) CoverImage(b, Modifier.weight(1f).fillMaxSize())
        }
        covers.size == 3 -> Row(modifier = coverModifier) {
            CoverImage(covers[0], Modifier.weight(1f).fillMaxSize())
            Column(modifier = Modifier.weight(1f).fillMaxSize()) {
                for (b in covers.drop(1)) CoverImage(b, Modifier.weight(1f).fillMaxSize())
            }
        }
        else -> Column(modifier = coverModifier) {
            for (row in covers.chunked(2)) {
                Row(modifier = Modifier.weight(1f)) {
                    for (b in row) CoverImage(b, Modifier.weight(1f).fillMaxSize())
                }
            }
        }
    }
}

@Composable
private fun CoverImage(bitmap: Bitmap, modifier: Modifier) {
    Image(
        bitmap = bitmap.asImageBitmap(),
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = modifier,
    )
}

private fun fingerprint(bitmap: Bitmap): IntArray {
    val small = Bitmap.createScaledBitmap(bitmap, 16, 16, true)
    val pixels = IntArray(16 * 16)
    small.getPixels(pixels, 0, 16, 0, 0, 16, 16)
    if (small !== bitmap) small.recycle()
    return pixels
}
