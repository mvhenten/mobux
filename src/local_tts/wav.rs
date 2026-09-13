//! A WAV container for the samples the model produces.
//!
//! The browser plays what the endpoint returns, so the samples need a header
//! an `<audio>` element recognises. 16-bit PCM mono is the one every browser
//! decodes without asking, and it halves what goes over the wire against f32.

/// Wrap mono f32 samples in a 16-bit PCM WAV.
pub fn encode(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = samples.len() as u32 * 2;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        out.extend_from_slice(&((clamped * 32767.0) as i16).to_le_bytes());
    }
    out
}

/// How long a clip runs. Only the real-voice test needs it: it is the one
/// thing that proves synthesis beat realtime rather than merely finished.
#[cfg(test)]
pub fn duration_secs(samples: usize, sample_rate: u32) -> f64 {
    if sample_rate == 0 {
        return 0.0;
    }
    samples as f64 / sample_rate as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_header_says_mono_sixteen_bit_at_the_models_rate() {
        let wav = encode(&[0.0, 0.5, -0.5], 22050);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            22050
        );
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        assert_eq!(wav.len(), 44 + 6);
    }

    #[test]
    fn samples_beyond_full_scale_clip_rather_than_wrap() {
        let wav = encode(&[2.0, -2.0], 22050);
        assert_eq!(i16::from_le_bytes([wav[44], wav[45]]), 32767);
        assert_eq!(i16::from_le_bytes([wav[46], wav[47]]), -32767);
    }

    #[test]
    fn duration_follows_the_sample_count() {
        assert!((duration_secs(22050, 22050) - 1.0).abs() < f64::EPSILON);
        assert_eq!(duration_secs(100, 0), 0.0);
    }
}
