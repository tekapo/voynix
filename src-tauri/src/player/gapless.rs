//! Gapless-trimmed decoding: wraps a symphonia format reader/decoder as a
//! `rodio::Source`, trimming an m4a/ALAC file's iTunSMPB encoder delay and
//! padding. No Tauri dependency — this is the piece of `player.rs` that's
//! genuinely reusable outside this app (a small workspace crate, or
//! eventually its own published one, if that's ever worth doing), so it's
//! kept in its own module with only `std`, `lofty`, `symphonia` and `rodio`
//! as dependencies.
//!
//! Decoding goes through symphonia directly rather than rodio's own
//! `symphonia-*` decoder features because symphonia's `isomp4` demuxer
//! doesn't parse iTunSMPB (its own docs list ISO/MP4 as non-gapless) — so
//! even with rodio's ALAC support enabled, an m4a ripped by iTunes/Apple
//! Music would still click/pop at every track boundary from the untrimmed
//! encoder delay and padding. `SymphoniaSource` is what fills that gap
//! (pun intended): it decodes exactly the way rodio's own decoder would, and
//! then additionally trims what iTunSMPB says to.
//!
//! If a future symphonia release parses iTunSMPB itself, this whole module
//! becomes redundant and can be deleted in favor of
//! `AudioDecoderOptions { gapless: true }` alone — that's the reason this is
//! isolated behind `SymphoniaSource::open` rather than woven into `player.rs`.

use lofty::config::ParseOptions;
use lofty::file::AudioFile;
use lofty::mp4::{AtomData, AtomIdent, Mp4File};
use rodio::source::SeekError;
use rodio::Source;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::codecs::CodecParameters;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::Time;

/// Encoder priming ("delay") and trailing padding sample counts (per
/// channel) an m4a/ALAC file needs trimmed for true gapless playback — see
/// [`parse_itunsmpb`].
#[derive(Default, Clone, Copy, Debug, PartialEq)]
struct GaplessInfo {
    delay_samples: u64,
    padding_samples: u64,
}

/// Reads the `iTunSMPB` freeform atom iTunes/Apple Music embeds in an m4a's
/// `ilst`, giving the exact number of encoder priming and padding samples to
/// drop — see the module doc comment for why symphonia's own demuxer can't
/// supply this.
///
/// A no-op (all zeros) for anything that isn't an m4a/mp4/m4b, or where the
/// atom is missing/unparseable — this never blocks playback, only refines it.
fn read_gapless_info(path: &Path) -> GaplessInfo {
    let is_mp4_family = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| {
            // m4b (audiobook) is the same MPEG-4 container as m4a/mp4 and
            // iTunes tags it with iTunSMPB the same way — originally missing
            // here, which silently skipped gapless trimming for audiobooks.
            e.eq_ignore_ascii_case("m4a") || e.eq_ignore_ascii_case("mp4") || e.eq_ignore_ascii_case("m4b")
        });
    if !is_mp4_family {
        return GaplessInfo::default();
    }
    let Ok(mut file) = File::open(path) else { return GaplessInfo::default() };
    let Ok(mp4) = Mp4File::read_from(&mut file, ParseOptions::default()) else {
        return GaplessInfo::default();
    };
    let Some(ilst) = mp4.ilst() else { return GaplessInfo::default() };
    let ident = AtomIdent::Freeform {
        mean: "com.apple.iTunes".into(),
        name: "iTunSMPB".into(),
    };
    let Some(atom) = ilst.get(&ident) else { return GaplessInfo::default() };
    let text = atom.data().find_map(|d| match d {
        AtomData::UTF8(s) | AtomData::UTF16(s) => Some(s.as_str()),
        _ => None,
    });
    text.and_then(parse_itunsmpb).unwrap_or_default()
}

/// Parses `iTunSMPB`'s value: an unofficial but de-facto-universal format
/// (ffmpeg, taglib, and others all agree on it) — 12 whitespace-separated hex
/// fields. `[0]` is reserved (always zero), `[1]` is the encoder delay
/// (priming samples to drop from the start), `[2]` is the encoder padding
/// (samples to drop from the end); both per channel. The rest aren't needed
/// here.
fn parse_itunsmpb(text: &str) -> Option<GaplessInfo> {
    let mut fields = text.split_whitespace();
    fields.next()?; // reserved
    let delay_samples = u64::from_str_radix(fields.next()?, 16).ok()?;
    let padding_samples = u64::from_str_radix(fields.next()?, 16).ok()?;
    Some(GaplessInfo { delay_samples, padding_samples })
}

/// A fixed-size trailing delay line: a pushed sample only comes back out once
/// more than `reserve` samples are queued up behind it, so whatever's still
/// sitting in it once the source truly ends is exactly its last `reserve`
/// samples — which the caller simply never asks for again. Used to trim an
/// m4a's encoder padding without knowing in advance which samples are "the
/// last ones" (this engine decodes lazily, one packet at a time).
///
/// `reserve: 0` degenerates to zero-latency pass-through (every push()
/// immediately returns that same sample), so the non-m4a / no-padding case
/// pays no cost beyond an always-empty `VecDeque`.
struct TailTrim {
    reserve: usize,
    buf: VecDeque<f32>,
}

impl TailTrim {
    fn new(reserve: usize) -> Self {
        TailTrim { reserve, buf: VecDeque::new() }
    }

    /// Queues one sample; returns a sample to release, if pushing this one
    /// pushed the queue past `reserve`.
    fn push(&mut self, sample: f32) -> Option<f32> {
        self.buf.push_back(sample);
        if self.buf.len() > self.reserve { self.buf.pop_front() } else { None }
    }

    /// Drops whatever's queued — used after a seek, where it no longer
    /// reflects samples adjacent to wherever playback landed.
    fn clear(&mut self) {
        self.buf.clear();
    }
}

/// A file with any leading ID3v2 tag hidden from symphonia. Some tags (e.g.
/// ID3v2.2 with an oddly-typed `PIC` frame) make symphonia's own tag parse
/// bail partway, after which the probe resyncs on stray `0xFF 0xFx` bytes
/// inside the embedded image and misdetects the file as MPEG layer 1 — which
/// then fails with "unsupported audio codec". Tags aren't needed for playback
/// (lofty reads them separately), so just start the stream after the tag.
struct SkipId3v2 {
    file: File,
    start: u64,
}

impl SkipId3v2 {
    fn new(mut file: File) -> io::Result<Self> {
        let mut header = [0u8; 10];
        let mut start = 0;
        if file.read_exact(&mut header).is_ok()
            && &header[..3] == b"ID3"
            && header[6..10].iter().all(|b| b & 0x80 == 0)
        {
            let size = header[6..10].iter().fold(0u64, |acc, b| (acc << 7) | u64::from(*b));
            // Bit 4 of the flags byte marks a trailing 10-byte footer.
            let footer = if header[5] & 0x10 != 0 { 10 } else { 0 };
            start = 10 + size + footer;
        }
        file.seek(SeekFrom::Start(start))?;
        Ok(Self { file, start })
    }
}

impl Read for SkipId3v2 {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.file.read(buf)
    }
}

impl Seek for SkipId3v2 {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let abs = match pos {
            SeekFrom::Start(n) => SeekFrom::Start(self.start + n),
            other => other,
        };
        Ok(self.file.seek(abs)?.saturating_sub(self.start))
    }
}

impl MediaSource for SkipId3v2 {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        self.file.metadata().ok().map(|m| m.len().saturating_sub(self.start))
    }
}

/// One track's decode pipeline, exposed to rodio as a `Source` of interleaved
/// `f32` samples. Reads and decodes lazily, one packet at a time, as rodio's
/// output thread pulls samples — nothing is preloaded into memory.
pub(crate) struct SymphoniaSource {
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    channels: u16,
    sample_rate: u32,
    pub(crate) total_duration: Option<Duration>,
    buf: Vec<f32>,
    pos: usize,
    /// Interleaved samples still to discard from the very start (see
    /// [`GaplessInfo::delay_samples`]) — counts down to 0 once past it.
    delay_remaining: u64,
    /// Trims [`GaplessInfo::padding_samples`] (interleaved) off the very end.
    tail_trim: TailTrim,
}

impl SymphoniaSource {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        let file = SkipId3v2::new(file).map_err(|e| format!("open {}: {e}", path.display()))?;
        let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }

        let reader = symphonia::default::get_probe()
            .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
            .map_err(|e| format!("probe {}: {e}", path.display()))?;

        let track = reader
            .tracks()
            .iter()
            .find(|t| matches!(t.codec_params, Some(CodecParameters::Audio(_))))
            .ok_or_else(|| format!("{}: no audio track found", path.display()))?;
        let track_id = track.id;
        let Some(CodecParameters::Audio(audio_params)) = track.codec_params.clone() else {
            unreachable!("filtered on Some(CodecParameters::Audio(_)) above");
        };

        let mut total_duration = match (track.time_base, track.duration) {
            (Some(tb), Some(dur)) => {
                Some(Duration::from_secs_f64(tb.calc_duration_saturating(dur).as_secs_f64()))
            }
            _ => None,
        };

        let decoder = symphonia::default::get_codecs()
            // Defaults are gapless: true, verify: false — exactly what we want.
            .make_audio_decoder(&audio_params, &AudioDecoderOptions::default())
            .map_err(|e| format!("no decoder for {}: {e}", path.display()))?;

        let sample_rate = audio_params
            .sample_rate
            .ok_or_else(|| format!("{}: unknown sample rate", path.display()))?;
        // Reported channel count, when the codec supplies one. Falls back to
        // stereo for `channels()` below (rodio needs *some* answer to play
        // anything at all), but gapless trimming below deliberately does NOT
        // fall back the same way — see the comment there.
        let reported_channels = audio_params.channels.map(|c| c.count() as u16);
        let channels = reported_channels.unwrap_or(2).max(1);

        let mut gapless = read_gapless_info(path);
        if reported_channels.is_none() {
            // iTunSMPB's delay/padding counts are *per channel*; trimming
            // math below multiplies them by `channels`. Guessing 2 here for
            // an actually-mono (or actually-surround) file would trim the
            // wrong number of samples — corrupting, not just imperfecting,
            // playback. Silently skipping the gapless refinement is the safe
            // failure mode (same as a missing/unparseable iTunSMPB atom).
            gapless = GaplessInfo::default();
        }
        if let Some(d) = total_duration {
            let trim_secs = (gapless.delay_samples + gapless.padding_samples) as f64 / sample_rate as f64;
            total_duration = Some(d.saturating_sub(Duration::from_secs_f64(trim_secs)));
        }

        Ok(SymphoniaSource {
            reader,
            decoder,
            track_id,
            channels,
            sample_rate,
            total_duration,
            buf: Vec::new(),
            pos: 0,
            delay_remaining: gapless.delay_samples * channels as u64,
            tail_trim: TailTrim::new((gapless.padding_samples * channels as u64) as usize),
        })
    }

    /// Decodes forward until a non-empty sample buffer is available, or
    /// returns `false` on end-of-stream / an unrecoverable error.
    fn fill(&mut self) -> bool {
        loop {
            if self.pos < self.buf.len() {
                return true;
            }
            let packet = match self.reader.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => return false,
                Err(_) => return false, // end of stream or IO error — treat as done
            };
            if packet.track_id != self.track_id {
                continue;
            }
            match self.decoder.decode(&packet) {
                Ok(decoded) => {
                    decoded.copy_to_vec_interleaved(&mut self.buf);
                    self.pos = 0;
                    if self.buf.is_empty() {
                        continue; // e.g. an all-delay/padding packet trimmed to nothing
                    }
                    return true;
                }
                // A single bad packet doesn't end the stream — skip it and keep going.
                Err(_) => continue,
            }
        }
    }
}

impl Iterator for SymphoniaSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        // Drop the encoder's leading priming samples, once, before ever
        // handing out real audio.
        while self.delay_remaining > 0 {
            if !self.fill() {
                return None;
            }
            let available = (self.buf.len() - self.pos) as u64;
            if available <= self.delay_remaining {
                self.delay_remaining -= available;
                self.pos = self.buf.len();
            } else {
                self.pos += self.delay_remaining as usize;
                self.delay_remaining = 0;
            }
        }

        loop {
            if !self.fill() {
                return None; // whatever's still queued in tail_trim is the padding — discarded
            }
            let s = self.buf[self.pos];
            self.pos += 1;
            if let Some(out) = self.tail_trim.push(s) {
                return Some(out);
            }
        }
    }
}

impl Source for SymphoniaSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> rodio::ChannelCount {
        std::num::NonZero::new(self.channels).unwrap_or(std::num::NonZero::<u16>::MIN)
    }

    fn sample_rate(&self) -> rodio::SampleRate {
        std::num::NonZero::new(self.sample_rate).unwrap_or(std::num::NonZero::<u32>::MIN)
    }

    fn total_duration(&self) -> Option<Duration> {
        self.total_duration
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let time = Time::try_from_secs_f64(pos.as_secs_f64()).unwrap_or(Time::ZERO);
        self.reader
            .seek(SeekMode::Accurate, SeekTo::Time { time, track_id: Some(self.track_id) })
            .map_err(|e| SeekError::Other(Arc::new(e)))?;
        self.decoder.reset();
        self.buf.clear();
        self.pos = 0;
        // The leading-delay trim only applies at the true start of the file —
        // a seek elsewhere shouldn't drop any more samples here. The tail
        // buffer's *contents* are now stale (they were queued from the old
        // position), but `tail_reserve` itself stays: the real end of the
        // file still needs its padding trimmed the same way.
        self.delay_remaining = 0;
        self.tail_trim.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn skip_id3v2_hides_the_tag_and_rebases_seeks() {
        let path = std::env::temp_dir().join(format!("voynix-skip-id3-{}.bin", std::process::id()));
        // ID3v2.2 header declaring a 4-byte body (syncsafe), then the body, then "audio".
        let mut bytes = vec![b'I', b'D', b'3', 2, 0, 0, 0, 0, 0, 4, 1, 2, 3, 4];
        bytes.extend_from_slice(b"audio");
        std::fs::write(&path, &bytes).unwrap();

        let mut src = SkipId3v2::new(File::open(&path).unwrap()).unwrap();
        assert_eq!(src.byte_len(), Some(5));
        let mut buf = [0u8; 5];
        src.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"audio");
        assert_eq!(src.seek(SeekFrom::Start(1)).unwrap(), 1);
        src.read_exact(&mut buf[..2]).unwrap();
        assert_eq!(&buf[..2], b"ud");
        std::fs::remove_file(&path).ok();
    }

    use super::*;

    #[test]
    fn parses_a_real_world_itunsmpb_value() {
        // A typical AAC encode's iTunSMPB: 2112 samples (0x840) of encoder
        // delay, 1200 (0x4B0) of padding.
        let text = " 00000000 00000840 000004B0 0000000000121A80 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000";
        assert_eq!(
            parse_itunsmpb(text),
            Some(GaplessInfo { delay_samples: 0x840, padding_samples: 0x4B0 }),
        );
    }

    #[test]
    fn parses_all_zero_delay_and_padding() {
        let text = " 00000000 00000000 00000000 0000000000100000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000";
        assert_eq!(parse_itunsmpb(text), Some(GaplessInfo { delay_samples: 0, padding_samples: 0 }));
    }

    #[test]
    fn rejects_malformed_or_truncated_input() {
        assert_eq!(parse_itunsmpb(""), None);
        assert_eq!(parse_itunsmpb("00000000"), None);
        assert_eq!(parse_itunsmpb("00000000 not-hex 00000000"), None);
    }

    #[test]
    fn read_gapless_info_is_a_noop_for_a_non_mp4_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("track.mp3");
        std::fs::write(&path, b"not really mp3 data").unwrap();
        assert_eq!(read_gapless_info(&path), GaplessInfo::default());
    }

    #[test]
    fn read_gapless_info_is_a_noop_when_the_file_cant_be_parsed_as_mp4() {
        // m4b (audiobook) is recognized by extension, but this isn't a real
        // MPEG-4 file, so parsing fails and it falls back to the default
        // rather than panicking or propagating an error.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("track.m4b");
        std::fs::write(&path, b"not an mp4 container").unwrap();
        assert_eq!(read_gapless_info(&path), GaplessInfo::default());
    }

    #[test]
    fn tail_trim_releases_nothing_until_past_the_reserve() {
        let mut t = TailTrim::new(3);
        assert_eq!(t.push(1.0), None);
        assert_eq!(t.push(2.0), None);
        assert_eq!(t.push(3.0), None);
        // The 4th push finally has 3 samples queued behind sample 1 — release it.
        assert_eq!(t.push(4.0), Some(1.0));
        assert_eq!(t.push(5.0), Some(2.0));
    }

    #[test]
    fn tail_trim_leaves_exactly_the_reserve_unreleased_at_end_of_stream() {
        let mut t = TailTrim::new(2);
        let released: Vec<f32> = (1..=5).filter_map(|s| t.push(s as f32)).collect();
        // 5 pushed, 2 held back (the padding) — matches what SymphoniaSource's
        // next() does: it simply stops asking once the source is exhausted,
        // so samples 4.0 and 5.0 are never returned to the caller.
        assert_eq!(released, vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn tail_trim_with_zero_reserve_is_pass_through() {
        let mut t = TailTrim::new(0);
        assert_eq!(t.push(1.0), Some(1.0));
        assert_eq!(t.push(2.0), Some(2.0));
    }

    #[test]
    fn tail_trim_clear_drops_queued_samples() {
        let mut t = TailTrim::new(5);
        t.push(1.0);
        t.push(2.0);
        t.clear();
        // Reserve still holds — a fresh push doesn't release the pre-clear samples.
        assert_eq!(t.push(3.0), None);
    }

    #[test]
    fn open_rejects_a_missing_file() {
        assert!(SymphoniaSource::open(Path::new("/nonexistent/track.mp3")).is_err());
    }
}
