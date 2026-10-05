package com.voynix.ui.library

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.voynix.R
import com.voynix.artwork.ArtistArtResolver
import com.voynix.artwork.ArtistImage
import com.voynix.library.LibraryViewModel
import com.voynix.ui.components.EmptyState
import kotlinx.coroutines.flow.StateFlow

/** Artists / Albums index — a searchable, alphabetized name list that drills into a [TrackListScreen]. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NameListScreen(
    title: String,
    names: StateFlow<List<String>>,
    onBack: () -> Unit,
    onSelectLibrary: () -> Unit,
    onClick: (String) -> Unit,
    vm: LibraryViewModel,
    /** Non-null only for the Artists list — Albums has no per-row art here (see AlbumDetail instead). */
    artistArt: ArtistArtResolver? = null,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var searchOpen by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { onSelectLibrary() }
    LaunchedEffect(query) { vm.setSearch(query) }

    val list by names.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.name_list_back))
                    }
                },
                actions = {
                    IconButton(onClick = { searchOpen = !searchOpen; if (!searchOpen) query = "" }) {
                        Icon(Icons.Filled.Search, contentDescription = stringResource(R.string.name_list_search))
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (searchOpen) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    label = { Text(stringResource(R.string.name_list_search)) },
                    singleLine = true,
                )
            }
            if (list.isEmpty()) {
                EmptyState(icon = Icons.Filled.Search, title = stringResource(R.string.name_list_no_results), modifier = Modifier.padding(top = 24.dp))
            } else {
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(list, key = { it }) { name ->
                        ListItem(
                            leadingContent = artistArt?.let { resolver ->
                                { ArtistImage(resolver = resolver, artist = name, size = 40.dp) }
                            },
                            headlineContent = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                            modifier = Modifier.fillMaxWidth().clickable { onClick(name) },
                        )
                    }
                }
            }
        }
    }
}
