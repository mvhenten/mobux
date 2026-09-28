/// Decodes a byte stream that arrives in arbitrary chunks, carrying a
/// multi-byte character split across a chunk boundary over to the next
/// chunk instead of replacing its halves with U+FFFD.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decode(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::with_capacity(self.pending.len());
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    out.push_str(valid);
                    rest = &[];
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[bad..];
                        }
                        None => {
                            rest = after;
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        out
    }

    pub fn finish(&mut self) -> String {
        let tail = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        tail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_byte_char_split_across_reads_is_intact() {
        let bytes = "a€b".as_bytes();
        let mut stream = Utf8Stream::new();
        let first = stream.decode(&bytes[..2]);
        let second = stream.decode(&bytes[2..]);
        assert_eq!(format!("{first}{second}"), "a€b");
        assert!(!first.contains(char::REPLACEMENT_CHARACTER));
    }

    #[test]
    fn every_split_point_of_mixed_text_round_trips() {
        let text = "é€😀\x1b]133;A\x07ok";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut stream = Utf8Stream::new();
            let mut out = stream.decode(&bytes[..cut]);
            out.push_str(&stream.decode(&bytes[cut..]));
            out.push_str(&stream.finish());
            assert_eq!(out, text, "split at byte {cut}");
        }
    }

    #[test]
    fn invalid_bytes_are_replaced_without_stalling() {
        let mut stream = Utf8Stream::new();
        assert_eq!(stream.decode(b"a\xffb"), "a\u{FFFD}b");
        assert_eq!(stream.finish(), "");
    }

    #[test]
    fn truncated_tail_at_end_of_stream_is_flushed() {
        let mut stream = Utf8Stream::new();
        assert_eq!(stream.decode(&"€".as_bytes()[..2]), "");
        assert_eq!(stream.finish(), "\u{FFFD}");
    }
}
