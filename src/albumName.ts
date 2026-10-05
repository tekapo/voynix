// Fallback album grouping for tracks with no album tag. Purely a display-time
// convenience — the DB row and the file's own tags are never rewritten. When
// a track has no `album`, its parent folder name stands in for one, so a
// folder of loose/untagged files (a live recording, a batch of demos, an
// iTunes import with blank tags) still groups sensibly instead of every such
// track across the whole library collapsing onto one "Unknown Album".

import { Track } from "./types";

/** Matches a disc-numbering subfolder ("Disc 1", "CD2", "Disk 01", …) whose
 *  *parent* folder is the real album, not the disc folder itself. */
const DISC_FOLDER_RE = /^(disc|disk|cd)\s*\d+$/i;

function splitPath(path: string): string[] {
    return path.split(/[/\\]/).filter((s) => s.length > 0);
}

/** The folder name to use as a fallback album, or `null` if `path` doesn't
 *  have a usable parent folder (e.g. a bare filename). Skips one level up
 *  when the immediate parent is a disc-numbering folder, so a multi-disc
 *  album split into `Disc 1/`, `Disc 2/` subfolders doesn't fragment into
 *  separate "albums". */
function folderAlbumFromPath(path: string): string | null {
    const parts = splitPath(path);
    // Drop the filename itself, keeping just the containing folders.
    parts.pop();
    if (parts.length === 0) return null;

    let name = parts[parts.length - 1];
    if (DISC_FOLDER_RE.test(name.trim()) && parts.length >= 2) {
        name = parts[parts.length - 2];
    }
    return name.trim() || null;
}

/** The album to treat `track` as belonging to: its own tag when present,
 *  else its parent folder name, else `null` when neither is available. */
export function effectiveAlbum(track: Pick<Track, "album" | "file_path">): string | null {
    const tag = track.album?.trim();
    if (tag) return tag;
    return folderAlbumFromPath(track.file_path ?? "");
}

/** `effectiveAlbum`, falling back to "Unknown Album" for display/sorting call
 *  sites that need a plain string (grouping keys, natural sort, etc.). */
export function albumOf(track: Pick<Track, "album" | "file_path">): string {
    return effectiveAlbum(track) ?? "Unknown Album";
}

/** True when `track` has no album tag of its own — i.e. any album shown for
 *  it (folder name or "Unknown Album") is a fallback, not tag data. Used to
 *  skip online album-art lookups that would otherwise search for a folder
 *  name and risk matching an unrelated release. */
export function isFolderAlbum(track: Pick<Track, "album">): boolean {
    return !track.album?.trim();
}
