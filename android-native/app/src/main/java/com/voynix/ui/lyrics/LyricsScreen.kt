package com.voynix.ui.lyrics

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.voynix.R
import com.voynix.data.db.TrackEntity
import com.voynix.data.db.VoynixDatabase
import com.voynix.lyrics.LrclibApi

/**
 * Lyrics for the now-playing track: whatever's already cached on the row
 * (TrackEntity.lyrics), else an LRCLIB lookup — cached back onto the row so
 * it's free on every later view. Ported from metadata.rs's fetch_lyrics /
 * LyricsPanel.tsx's display logic.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LyricsScreen(db: VoynixDatabase, lrclibApi: LrclibApi, track: TrackEntity, onBack: () -> Unit) {
    var lyrics by remember(track.id) { mutableStateOf(track.lyrics) }
    var loading by remember(track.id) { mutableStateOf(track.lyrics.isNullOrBlank()) }
    var notFound by remember(track.id) { mutableStateOf(false) }

    LaunchedEffect(track.id) {
        if (!lyrics.isNullOrBlank()) {
            loading = false
            return@LaunchedEffect
        }
        loading = true
        val found = runCatching {
            lrclibApi.fetchLyrics(track.artist ?: "", track.title, track.album ?: "", track.duration)
        }.getOrNull()
        if (found != null) {
            db.trackDao().setLyrics(track.id, found)
            lyrics = found
        } else {
            notFound = true
        }
        loading = false
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.lyrics_back))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text(
                track.artist ?: "",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            when {
                loading -> CircularProgressIndicator()
                !lyrics.isNullOrBlank() -> Text(lyrics!!, style = MaterialTheme.typography.bodyLarge)
                notFound -> Text(
                    stringResource(R.string.lyrics_no_lyrics_found),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
