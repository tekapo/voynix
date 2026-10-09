package com.voynix.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.voynix.R

private const val STEP_COUNT = 3

/** First-launch guide: how Wi-Fi sync with the Mac works, then a shortcut to the pairing screen. */
@Composable
fun WelcomeDialog(
    onDismiss: () -> Unit,
    onOpenSync: () -> Unit,
) {
    var step by rememberSaveable { mutableIntStateOf(0) }
    val titles = listOf(R.string.welcome_step1_title, R.string.welcome_step2_title, R.string.welcome_step3_title)
    val bodies = listOf(R.string.welcome_step1_body, R.string.welcome_step2_body, R.string.welcome_step3_body)
    val last = step == STEP_COUNT - 1

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(titles[step])) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(bodies[step]))
                Text(stringResource(R.string.welcome_progress, step + 1, STEP_COUNT))
            }
        },
        confirmButton = {
            if (last) {
                TextButton(onClick = onOpenSync) { Text(stringResource(R.string.welcome_open_sync)) }
            } else {
                TextButton(onClick = { step += 1 }) { Text(stringResource(R.string.welcome_next)) }
            }
        },
        dismissButton = {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                if (step > 0) TextButton(onClick = { step -= 1 }) { Text(stringResource(R.string.welcome_back)) }
                TextButton(onClick = onDismiss) {
                    Text(stringResource(if (last) R.string.welcome_later else R.string.welcome_skip))
                }
            }
        },
    )
}
