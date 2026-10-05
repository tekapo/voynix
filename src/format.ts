/**
 * "m:ss", switching to "h:mm:ss" once the duration reaches an hour — a 2-hour
 * podcast episode reads "2:00:00" rather than "120:00". Callers decide how to
 * render zero/unknown durations (see `formatDuration` in
 * components/trackFormat.tsx, and PlayerBar.tsx's `formatTime`).
 */
export function formatSeconds(totalSeconds: number): string {
    const total = Math.floor(totalSeconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = s.toString().padStart(2, '0');
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`;
    return `${m}:${ss}`;
}

/** Human-readable file size, e.g. "512 B", "3.4 MB", "1 GB". */
export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let val = n / 1024;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) {
        val /= 1024;
        i++;
    }
    return `${val.toFixed(val >= 10 ? 0 : 1)} ${units[i]}`;
}
