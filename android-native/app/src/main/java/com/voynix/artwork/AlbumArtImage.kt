package com.voynix.artwork

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Track/album cover art, resolved asynchronously: the album's art, else the
 * artist's image, else the initial of the artist (or the title when there is no
 * artist tag) on a colored tile (same as the Mac's TrackCover) while loading or absent. Sizing comes from [modifier] — pass `.size(48.dp)`
 * for a fixed square (track rows) or `.fillMaxWidth().aspectRatio(1f)` for a
 * responsive one (Now Playing); [BoxWithConstraints] reads back the resolved
 * size so the placeholder icon scales with it either way.
 */
@Composable
fun AlbumArtImage(
    resolver: AlbumArtResolver,
    artist: String?,
    album: String?,
    title: String,
    filePath: String,
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(4.dp),
    contentScale: ContentScale = ContentScale.Crop,
) {
    var bitmap by remember(artist, album, filePath) { mutableStateOf<android.graphics.Bitmap?>(null) }

    LaunchedEffect(artist, album, filePath) {
        bitmap = null
        bitmap = resolver.resolveWithArtistFallback(artist, album, filePath)
    }

    BoxWithConstraints(
        modifier = modifier
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        val current = bitmap
        if (current != null) {
            Image(
                bitmap = current.asImageBitmap(),
                contentDescription = null,
                contentScale = contentScale,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            ArtworkInitial(name = placeholderName(artist, title), boxSize = maxWidth)
        }
    }
}

/** Convenience overload for the common fixed-square case (track rows, mini player). */
@Composable
fun AlbumArtImage(
    resolver: AlbumArtResolver,
    artist: String?,
    album: String?,
    title: String,
    filePath: String,
    size: Dp,
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(4.dp),
    contentScale: ContentScale = ContentScale.Crop,
) = AlbumArtImage(
    resolver = resolver,
    artist = artist,
    album = album,
    title = title,
    filePath = filePath,
    modifier = modifier.size(size),
    shape = shape,
    contentScale = contentScale,
)
