//! Minimal RIFF/WAVE decode to the mono f32 at 16 kHz that whisper wants.
//!
//! The browser already encodes exactly that (see `encodeWav` in
//! `web/static/input-actions.js`), so the common path is a straight
//! conversion. Stereo, other sample rates and 8/24/32-bit inputs are still
//! handled so a clip posted to `/transcribe` by hand is not a puzzle.

pub const TARGET_RATE: u32 = 16_000;

struct Format {
    audio_format: u16,
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
}

pub fn decode_to_mono_16k(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let (format, data) = split_chunks(bytes)?;
    let interleaved = samples(&format, data)?;
    let mono = downmix(interleaved, format.channels);
    Ok(resample(mono, format.sample_rate, TARGET_RATE))
}

fn split_chunks(bytes: &[u8]) -> Result<(Format, &[u8]), String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE clip".to_string());
    }
    let mut offset = 12;
    let mut format = None;
    let mut data = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = usize::min(start.saturating_add(size), bytes.len());
        if id == b"fmt " && end - start >= 16 {
            let chunk = &bytes[start..end];
            format = Some(Format {
                audio_format: u16::from_le_bytes(chunk[0..2].try_into().unwrap()),
                channels: u16::from_le_bytes(chunk[2..4].try_into().unwrap()),
                sample_rate: u32::from_le_bytes(chunk[4..8].try_into().unwrap()),
                bits_per_sample: u16::from_le_bytes(chunk[14..16].try_into().unwrap()),
            });
        }
        if id == b"data" {
            data = Some(&bytes[start..end]);
        }
        offset = start + size + (size & 1);
    }
    let format = format.ok_or_else(|| "clip has no fmt chunk".to_string())?;
    let data = data.ok_or_else(|| "clip has no data chunk".to_string())?;
    if format.channels == 0 || format.sample_rate == 0 {
        return Err("clip declares no channels or no sample rate".to_string());
    }
    Ok((format, data))
}

// WAVE_FORMAT_PCM is 1, WAVE_FORMAT_IEEE_FLOAT is 3, WAVE_FORMAT_EXTENSIBLE is
// 0xFFFE and carries the real tag in its extension — for the widths below that
// distinction does not change the decode, so bit depth decides.
fn samples(format: &Format, data: &[u8]) -> Result<Vec<f32>, String> {
    match (format.audio_format, format.bits_per_sample) {
        (_, 8) => Ok(data.iter().map(|b| (*b as f32 - 128.0) / 128.0).collect()),
        (_, 16) => Ok(data
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| i16::from_le_bytes(*c) as f32 / 32768.0)
            .collect()),
        (_, 24) => Ok(data
            .as_chunks::<3>()
            .0
            .iter()
            .map(|c| (i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8) as f32 / 8_388_608.0)
            .collect()),
        (3, 32) => Ok(data
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect()),
        (_, 32) => Ok(data
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| i32::from_le_bytes(*c) as f32 / 2_147_483_648.0)
            .collect()),
        (_, bits) => Err(format!("unsupported sample width: {bits} bit")),
    }
}

fn downmix(interleaved: Vec<f32>, channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return interleaved;
    }
    let channels = channels as usize;
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

fn resample(samples: Vec<f32>, from: u32, to: u32) -> Vec<f32> {
    if from == to || samples.len() < 2 {
        return samples;
    }
    let ratio = from as f64 / to as f64;
    let out_len = (samples.len() as f64 / ratio).floor() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let lo = pos.floor() as usize;
            let hi = usize::min(lo + 1, samples.len() - 1);
            let frac = (pos - lo as f64) as f32;
            samples[lo] * (1.0 - frac) + samples[hi] * frac
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(sample_rate: u32, channels: u16, bits: u16, data: &[u8]) -> Vec<u8> {
        let block_align = channels * bits / 8;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36u32 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&(sample_rate * block_align as u32).to_le_bytes());
        out.extend_from_slice(&block_align.to_le_bytes());
        out.extend_from_slice(&bits.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
        out
    }

    fn pcm16(values: &[i16]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    #[test]
    fn decodes_the_shape_the_browser_posts() {
        let clip = wav(16_000, 1, 16, &pcm16(&[0, 16384, -16384, 32767]));
        let pcm = decode_to_mono_16k(&clip).expect("decodes");
        assert_eq!(pcm.len(), 4);
        assert!((pcm[1] - 0.5).abs() < 1e-3, "{pcm:?}");
        assert!((pcm[2] + 0.5).abs() < 1e-3, "{pcm:?}");
    }

    #[test]
    fn downmixes_stereo_to_mono() {
        let clip = wav(16_000, 2, 16, &pcm16(&[32767, -32768, 16384, 16384]));
        let pcm = decode_to_mono_16k(&clip).expect("decodes");
        assert_eq!(pcm.len(), 2);
        assert!(pcm[0].abs() < 1e-3, "{pcm:?}");
        assert!((pcm[1] - 0.5).abs() < 1e-3, "{pcm:?}");
    }

    #[test]
    fn resamples_to_16k() {
        let clip = wav(48_000, 1, 16, &pcm16(&[0i16; 4800]));
        let pcm = decode_to_mono_16k(&clip).expect("decodes");
        assert_eq!(pcm.len(), 1600);
    }

    // The sample clip candle ships carries a LIST/INFO chunk between `fmt `
    // and `data`; a parser that assumes data comes straight after the format
    // reads metadata as audio.
    #[test]
    fn skips_chunks_between_fmt_and_data() {
        let mut clip = wav(16_000, 1, 16, &pcm16(&[1000, 2000]));
        let data_at = clip.len() - 12;
        let mut extra = Vec::new();
        extra.extend_from_slice(b"LIST");
        extra.extend_from_slice(&4u32.to_le_bytes());
        extra.extend_from_slice(b"INFO");
        clip.splice(data_at..data_at, extra);
        let pcm = decode_to_mono_16k(&clip).expect("decodes");
        assert_eq!(pcm.len(), 2);
    }

    #[test]
    fn rejects_a_clip_that_is_not_a_wav() {
        assert!(decode_to_mono_16k(b"\x1aE\xdf\xa3 webm").is_err());
    }
}
