//! Reading and writing a file's own audio tags and embedded cover: the tag
//! summary used by the scanner, the "Get Info…" read/write commands, and the
//! embedded-artwork helpers.

use crate::identity::{identity_from_path, is_dataless, TrackIdentity};
use crate::metadata;
use lofty::file::AudioFile;
use lofty::prelude::{Accessor, ItemKey, TaggedFileExt};
use lofty::probe::Probe;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What we pull out of a file's audio tags in one probe.
#[derive(Default)]
pub(crate) struct TagSummary {
    pub(crate) title: Option<String>,
    pub(crate) artist: Option<String>,
    pub(crate) album: Option<String>,
    pub(crate) duration_secs: u64,
    pub(crate) disc_no: Option<u32>,
    pub(crate) track_no: Option<u32>,
    pub(crate) genre: Option<String>,
    pub(crate) year: Option<u32>,
    pub(crate) album_artist: Option<String>,
    pub(crate) composer: Option<String>,
}

pub(crate) fn read_tag_summary(path: &Path) -> TagSummary {
    let mut s = TagSummary::default();

    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        s.duration_secs = tagged_file.properties().duration().as_secs();
        if let Some(tag) = tagged_file
            .primary_tag()
            .or_else(|| tagged_file.first_tag())
        {
            s.title = tag
                .title()
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty());
            s.artist = tag.artist().map(|s| s.to_string());
            s.album = tag.album().map(|s| s.to_string());
            s.disc_no = tag.disk();
            s.track_no = tag.track();
            s.genre = tag.genre().map(|s| s.to_string());
            s.year = tag.year();
            s.album_artist = tag.get_string(&ItemKey::AlbumArtist).map(|s| s.to_string());
            s.composer = tag.get_string(&ItemKey::Composer).map(|s| s.to_string());
        }
    }

    s
}

/// One row of `read_track_numbers` output: the file path plus its disc / track
/// numbers from the audio tags. Only files that yielded at least one number are
/// returned.
#[derive(Debug, Serialize)]
pub struct TrackNumbers {
    file_path: String,
    disc_no: Option<u32>,
    track_no: Option<u32>,
}

/// Read disc / track numbers for a batch of files. Used once to backfill rows
/// scanned before those columns existed (see NATURAL_ORDER in db.ts). Missing
/// files and cloud placeholders are skipped so the next launch retries them.
#[tauri::command]
pub fn read_track_numbers(paths: Vec<String>) -> Vec<TrackNumbers> {
    paths
        .into_iter()
        .filter_map(|p| {
            let pb = PathBuf::from(&p);
            if !pb.exists() || is_dataless(&pb) {
                return None;
            }
            let t = read_tag_summary(&pb);
            if t.disc_no.is_none() && t.track_no.is_none() {
                return None;
            }
            Some(TrackNumbers {
                file_path: p,
                disc_no: t.disc_no,
                track_no: t.track_no,
            })
        })
        .collect()
}

/// One row of `read_extra_tags` output: the file path plus the smart-playlist
/// fields from its tags. Unlike `read_track_numbers`, a row is returned even
/// when every field is empty — the caller needs to know the file *was* read
/// so it can mark `extra_tags_read` and stop retrying it.
#[derive(Debug, Serialize)]
pub struct ExtraTags {
    file_path: String,
    genre: Option<String>,
    year: Option<u32>,
    album_artist: Option<String>,
    composer: Option<String>,
}

/// Read genre/year/album_artist/composer for a batch of files. Used once to
/// backfill rows scanned before those columns existed (see migration #12 in
/// migrations.ts). Missing files and cloud placeholders are skipped so the
/// next launch retries them.
#[tauri::command]
pub fn read_extra_tags(paths: Vec<String>) -> Vec<ExtraTags> {
    paths
        .into_iter()
        .filter_map(|p| {
            let pb = PathBuf::from(&p);
            if !pb.exists() || is_dataless(&pb) {
                return None;
            }
            let t = read_tag_summary(&pb);
            Some(ExtraTags {
                file_path: p,
                genre: t.genre,
                year: t.year,
                album_artist: t.album_artist,
                composer: t.composer,
            })
        })
        .collect()
}

/// Technical + tag info for the "Get Info…" dialog. Read-only fields come
/// straight from the file; `title`/`artist`/`album`/`disc_no`/`track_no`
/// double as the editable form's initial values.
#[derive(Debug, Serialize)]
pub struct TrackFileInfo {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    year: Option<u32>,
    disc_no: Option<u32>,
    track_no: Option<u32>,
    duration_ms: u64,
    /// e.g. "FLAC", "MP3", "AAC" — from lofty's `FileType`, `Debug`-formatted.
    format: String,
    audio_bitrate_kbps: Option<u32>,
    sample_rate_hz: Option<u32>,
    bit_depth: Option<u8>,
    channels: Option<u8>,
    size_bytes: u64,
    modified_at: Option<u64>,
    /// True when the file is an iCloud-only placeholder; every other field
    /// past the tag-derived ones is unavailable and the caller shouldn't
    /// offer to edit tags.
    cloud_only: bool,
}

#[tauri::command]
pub fn get_track_file_info(path: String) -> Result<TrackFileInfo, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err("File not found".to_string());
    }

    let fs_meta = std::fs::metadata(&path_buf).map_err(|e| e.to_string())?;
    let modified_at = fs_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    if is_dataless(&path_buf) {
        return Ok(TrackFileInfo {
            title: None,
            artist: None,
            album: None,
            genre: None,
            year: None,
            disc_no: None,
            track_no: None,
            duration_ms: 0,
            format: String::new(),
            audio_bitrate_kbps: None,
            sample_rate_hz: None,
            bit_depth: None,
            channels: None,
            size_bytes: fs_meta.len(),
            modified_at,
            cloud_only: true,
        });
    }

    let tagged_file = Probe::open(&path_buf)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;
    let props = tagged_file.properties();
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

    Ok(TrackFileInfo {
        title: tag.and_then(|t| t.title()).map(|s| s.to_string()),
        artist: tag.and_then(|t| t.artist()).map(|s| s.to_string()),
        album: tag.and_then(|t| t.album()).map(|s| s.to_string()),
        genre: tag.and_then(|t| t.genre()).map(|s| s.to_string()),
        year: tag.and_then(|t| t.year()),
        disc_no: tag.and_then(|t| t.disk()),
        track_no: tag.and_then(|t| t.track()),
        duration_ms: props.duration().as_millis() as u64,
        format: format!("{:?}", tagged_file.file_type()),
        audio_bitrate_kbps: props.audio_bitrate(),
        sample_rate_hz: props.sample_rate(),
        bit_depth: props.bit_depth(),
        channels: props.channels(),
        size_bytes: fs_meta.len(),
        modified_at,
        cloud_only: false,
    })
}

/// Edits from the "Get Info…" dialog. Empty strings clear the field; `None`
/// disc/track numbers clear those. Everything else in the file's tag is left
/// untouched.
#[derive(Debug, Deserialize)]
pub struct TagEdit {
    title: String,
    artist: String,
    album: String,
    disc_no: Option<u32>,
    track_no: Option<u32>,
}

/// Write edited tags back to the file and return its refreshed identity
/// (`track_key`/`content_hash` both change whenever the tag-derived fields
/// change) so the caller can re-key `play_events`.
#[tauri::command]
pub fn write_track_tags(path: String, edit: TagEdit) -> Result<TrackIdentity, String> {
    use lofty::tag::Tag;

    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err("File not found".to_string());
    }
    if is_dataless(&path_buf) {
        return Err("This file is iCloud-only and hasn't downloaded yet.".to_string());
    }

    let mut tagged_file = Probe::open(&path_buf)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    if tagged_file.primary_tag().is_none() && tagged_file.first_tag().is_none() {
        let tag_type = tagged_file.primary_tag_type();
        tagged_file.insert_tag(Tag::new(tag_type));
    }
    let tag = if tagged_file.primary_tag().is_some() {
        tagged_file.primary_tag_mut().expect("checked above")
    } else {
        tagged_file.first_tag_mut().expect("tag was just inserted")
    };

    if edit.title.trim().is_empty() {
        tag.remove_title();
    } else {
        tag.set_title(edit.title.trim().to_string());
    }
    if edit.artist.trim().is_empty() {
        tag.remove_artist();
    } else {
        tag.set_artist(edit.artist.trim().to_string());
    }
    if edit.album.trim().is_empty() {
        tag.remove_album();
    } else {
        tag.set_album(edit.album.trim().to_string());
    }
    match edit.disc_no {
        Some(n) => tag.set_disk(n),
        None => tag.remove_disk(),
    }
    match edit.track_no {
        Some(n) => tag.set_track(n),
        None => tag.remove_track(),
    }

    use lofty::config::WriteOptions;
    tagged_file
        .save_to_path(&path_buf, WriteOptions::default())
        .map_err(|e| e.to_string())?;

    identity_from_path(&path_buf)
}

/// First embedded cover picture, ready to be pushed into another file's tag
/// (e.g. re-embedding it into a transcode that `afconvert` stripped it from).
pub(crate) fn read_embedded_picture(path: &Path) -> Option<lofty::picture::Picture> {
    if !path.exists() {
        return None;
    }
    let tagged_file = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag())?;
    tag.pictures().first().cloned()
}

/// First embedded cover image as `(mime_type, bytes)`, if any.
pub(crate) fn read_embedded_artwork(path: &Path) -> Option<(String, Vec<u8>)> {
    let picture = read_embedded_picture(path)?;
    let mime = picture.mime_type()?.as_str().to_string();
    Some((mime, picture.data().to_vec()))
}

/// Async so the tag-read/base64-encode work runs off the main thread — a
/// synchronous `#[tauri::command]` executes on it in Tauri 2, and this is
/// called once per row/card across an entire library grid (see also
/// `get_album_thumb`, which the same UI calls even more often).
#[tauri::command]
pub async fn get_track_artwork(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_embedded_artwork(Path::new(&path))
            .map(|(mime, data)| metadata::bytes_to_data_uri(&mime, &data))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Makes `picture` the file's only embedded picture. Everything reads the *first*
/// one (`read_embedded_picture`), so appending would leave the old cover showing
/// and add more image bytes to the file on every change.
fn replace_cover(tag: &mut lofty::tag::Tag, picture: lofty::picture::Picture) {
    while !tag.pictures().is_empty() {
        tag.remove_picture(0);
    }
    tag.push_picture(picture);
}

#[tauri::command]
pub fn set_track_artwork(path: String, image_path: String) -> Result<(), String> {
    use lofty::file::AudioFile; // Import AudioFile trait for save_to_path
    use lofty::file::TaggedFileExt;
    use lofty::picture::{MimeType, Picture};
    use std::fs::read;

    let path_buf = PathBuf::from(&path);
    let image_buf = PathBuf::from(&image_path);

    if !path_buf.exists() || !image_buf.exists() {
        return Err("File not found".to_string());
    }
    // Saving rewrites the file, which on an iCloud placeholder would force a full download.
    if is_dataless(&path_buf) {
        return Err("This file is iCloud-only and hasn't downloaded yet.".to_string());
    }

    // Read image data
    let image_data = read(&image_buf).map_err(|e| e.to_string())?;

    // Determine mime type from extension
    let ext = image_buf
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime_type = match ext.as_str() {
        "png" => MimeType::Png,
        "jpg" | "jpeg" => MimeType::Jpeg,
        _ => return Err("Unsupported image format. Use PNG or JPEG.".to_string()),
    };

    // Create Picture
    let picture = Picture::new_unchecked(
        lofty::picture::PictureType::CoverFront,
        Some(mime_type), // Wrap in Some
        None,
        image_data,
    );

    // Read Audio File
    let mut tagged_file = Probe::open(&path_buf)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    // Attempt to get a mutable tag
    let tag = if let Some(t) = tagged_file.primary_tag_mut() {
        t
    } else if let Some(t) = tagged_file.first_tag_mut() {
        t
    } else {
        return Err(
            "No tags found in file. Please ensure file has metadata tags initialized.".to_string(),
        );
    };

    replace_cover(tag, picture);

    // Save
    // save_to_path requires WriteOptions in newer lofty versions?
    // Let's check the error message again.
    // `fn save_to_path(&self, path: impl AsRef<Path>, write_options: WriteOptions) -> Result<()>`
    // We need to pass WriteOptions.
    use lofty::config::WriteOptions;
    tagged_file
        .save_to_path(&path_buf, WriteOptions::default())
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::compute_track_key;
    use tempfile::tempdir;

    #[test]
    fn replace_cover_leaves_exactly_the_new_picture() {
        use lofty::picture::{MimeType, Picture, PictureType};
        use lofty::tag::{Tag, TagType};

        let pic = |bytes: &[u8], ty| Picture::new_unchecked(ty, Some(MimeType::Png), None, bytes.to_vec());
        let mut tag = Tag::new(TagType::Id3v2);
        tag.push_picture(pic(b"old-front", PictureType::CoverFront));
        tag.push_picture(pic(b"old-back", PictureType::CoverBack));

        replace_cover(&mut tag, pic(b"new-front", PictureType::CoverFront));
        assert_eq!(tag.pictures().len(), 1);
        assert_eq!(tag.pictures()[0].data(), b"new-front");

        // And again: repeated changes never accumulate.
        replace_cover(&mut tag, pic(b"newer", PictureType::CoverFront));
        assert_eq!(tag.pictures().len(), 1);
        assert_eq!(tag.pictures()[0].data(), b"newer");
    }

    #[test]
    fn test_get_track_artwork_nonexistent() {
        // get_track_artwork itself is `async` now (see its doc comment), so
        // this exercises the same underlying lookup it wraps.
        let result = read_embedded_artwork(Path::new("/nonexistent/song.mp3"));
        assert_eq!(result, None);
    }

    /// A minimal-but-valid 16-bit mono PCM WAV lofty can probe and re-save —
    /// there's no bundled fixture audio file in this repo, so build one.
    fn write_minimal_wav(path: &Path, num_samples: u32) {
        let mut data = Vec::new();
        let byte_rate: u32 = 44100 * 1 * 16 / 8;
        let block_align: u16 = 1 * 16 / 8;
        let data_len = num_samples * block_align as u32;

        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + data_len).to_le_bytes());
        data.extend_from_slice(b"WAVE");
        data.extend_from_slice(b"fmt ");
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes()); // PCM
        data.extend_from_slice(&1u16.to_le_bytes()); // mono
        data.extend_from_slice(&44100u32.to_le_bytes());
        data.extend_from_slice(&byte_rate.to_le_bytes());
        data.extend_from_slice(&block_align.to_le_bytes());
        data.extend_from_slice(&16u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&data_len.to_le_bytes());
        data.extend(std::iter::repeat(0u8).take(data_len as usize));

        std::fs::write(path, data).unwrap();
    }

    #[test]
    fn get_track_file_info_reads_technical_properties() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("silence.wav");
        write_minimal_wav(&path, 44100); // 1 second

        let info = get_track_file_info(path.to_string_lossy().to_string()).unwrap();
        assert!(!info.cloud_only);
        assert_eq!(info.sample_rate_hz, Some(44100));
        assert_eq!(info.channels, Some(1));
        assert_eq!(info.bit_depth, Some(16));
        assert!(info.duration_ms >= 900 && info.duration_ms <= 1100);
        assert!(info.format.contains("Wav"));
        assert!(info.size_bytes > 0);
    }

    /// A WAV that already carries a tag (set_track_artwork refuses untagged files).
    fn tagged_wav(dir: &Path) -> PathBuf {
        let path = dir.join("song.wav");
        write_minimal_wav(&path, 44100);
        let edit = TagEdit {
            title: "T".to_string(),
            artist: "A".to_string(),
            album: "B".to_string(),
            disc_no: Some(1),
            track_no: Some(1),
        };
        write_track_tags(path.to_string_lossy().to_string(), edit).unwrap();
        path
    }

    #[test]
    fn set_track_artwork_embeds_the_image_and_a_second_call_replaces_it() {
        let dir = tempdir().unwrap();
        let path = tagged_wav(dir.path());
        let path_str = path.to_string_lossy().to_string();

        let first = dir.path().join("first.png");
        std::fs::write(&first, b"\x89PNG-first").unwrap();
        set_track_artwork(path_str.clone(), first.to_string_lossy().to_string()).unwrap();
        let pic = read_embedded_picture(&path).expect("cover should be embedded");
        assert_eq!(pic.data(), b"\x89PNG-first");

        let second = dir.path().join("second.jpg");
        std::fs::write(&second, b"\xff\xd8JPG-second").unwrap();
        set_track_artwork(path_str, second.to_string_lossy().to_string()).unwrap();
        let pic = read_embedded_picture(&path).expect("cover should still be embedded");
        assert_eq!(pic.data(), b"\xff\xd8JPG-second");
    }

    #[test]
    fn set_track_artwork_rejects_bad_input_and_leaves_the_audio_file_untouched() {
        let dir = tempdir().unwrap();
        let path = tagged_wav(dir.path());
        let path_str = path.to_string_lossy().to_string();
        let before = std::fs::read(&path).unwrap();

        let gif = dir.path().join("cover.gif");
        std::fs::write(&gif, b"GIF89a").unwrap();
        let err = set_track_artwork(path_str.clone(), gif.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("Unsupported image format"), "{err}");

        let missing_img = dir.path().join("nope.png");
        let err = set_track_artwork(path_str.clone(), missing_img.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("File not found"), "{err}");

        let png = dir.path().join("cover.png");
        std::fs::write(&png, b"\x89PNG").unwrap();
        let err = set_track_artwork(
            dir.path().join("missing.wav").to_string_lossy().to_string(),
            png.to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("File not found"), "{err}");

        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn set_track_artwork_refuses_a_file_with_no_tags() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bare.wav");
        write_minimal_wav(&path, 44100);
        let before = std::fs::read(&path).unwrap();
        let png = dir.path().join("cover.png");
        std::fs::write(&png, b"\x89PNG").unwrap();

        let err = set_track_artwork(
            path.to_string_lossy().to_string(),
            png.to_string_lossy().to_string(),
        )
        .unwrap_err();
        assert!(err.contains("No tags found"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn get_track_file_info_reports_missing_file() {
        let result = get_track_file_info("/nonexistent/voynix/test/silence.wav".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn read_extra_tags_skips_missing_files_and_returns_rows_for_existing_ones() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("silence.wav");
        write_minimal_wav(&path, 44100);
        let path_str = path.to_string_lossy().to_string();

        let rows = read_extra_tags(vec![
            path_str.clone(),
            "/nonexistent/voynix/test/missing.wav".to_string(),
        ]);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path, path_str);
        // A bare WAV has no genre/year/album-artist/composer tags, but the row
        // is still returned — the caller needs to know it *was* read.
        assert_eq!(rows[0].genre, None);
        assert_eq!(rows[0].year, None);
    }

    #[test]
    fn write_track_tags_updates_file_and_rederives_identity() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("song.wav");
        write_minimal_wav(&path, 44100);
        let path_str = path.to_string_lossy().to_string();

        let before = identity_from_path(&path).unwrap();

        let edit = TagEdit {
            title: "New Title".to_string(),
            artist: "New Artist".to_string(),
            album: "New Album".to_string(),
            disc_no: Some(1),
            track_no: Some(7),
        };
        let after = write_track_tags(path_str.clone(), edit).unwrap();

        // Tag-derived fields feed compute_track_key, so writing new tags must
        // change it (and callers rely on this to re-key play_events).
        assert_ne!(before.track_key, after.track_key);
        assert_eq!(
            after.track_key,
            compute_track_key(Some("New Artist"), Some("New Album"), "New Title", 1, Some(7))
        );

        let info = get_track_file_info(path_str).unwrap();
        assert_eq!(info.title.as_deref(), Some("New Title"));
        assert_eq!(info.artist.as_deref(), Some("New Artist"));
        assert_eq!(info.album.as_deref(), Some("New Album"));
        assert_eq!(info.disc_no, Some(1));
        assert_eq!(info.track_no, Some(7));
    }

    #[test]
    fn write_track_tags_clears_fields_left_empty() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("song.wav");
        write_minimal_wav(&path, 44100);
        let path_str = path.to_string_lossy().to_string();

        write_track_tags(
            path_str.clone(),
            TagEdit {
                title: "Has Title".to_string(),
                artist: "Has Artist".to_string(),
                album: String::new(),
                disc_no: None,
                track_no: None,
            },
        )
        .unwrap();

        let info = get_track_file_info(path_str).unwrap();
        assert_eq!(info.album, None);
        assert_eq!(info.disc_no, None);
        assert_eq!(info.track_no, None);
    }
}
