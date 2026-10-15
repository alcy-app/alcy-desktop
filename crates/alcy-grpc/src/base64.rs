//! Standard base64, for binary metadata (`*-bin`) and proxy credentials.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Accepts padded or unpadded input, standard or URL-safe alphabet.
pub(crate) fn decode(input: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    };
    let symbols: Vec<u8> = input.trim().trim_end_matches('=').bytes().collect();
    if symbols.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(symbols.len() * 3 / 4);
    for chunk in symbols.chunks(4) {
        let mut n = 0u32;
        for (index, &symbol) in chunk.iter().enumerate() {
            n |= value(symbol)? << (18 - 6 * index);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_rejects_invalid_input() {
        for input in [
            &b""[..],
            b"a",
            b"ab",
            b"abc",
            b"user:pa ss",
            &[0, 255, 128, 7],
        ] {
            assert_eq!(decode(&encode(input)).as_deref(), Some(input));
        }
        assert_eq!(encode(b"user:pa ss"), "dXNlcjpwYSBzcw==");
        assert_eq!(
            decode("dXNlcjpwYSBzcw").as_deref(),
            Some(&b"user:pa ss"[..])
        );
        assert_eq!(decode("a$b="), None);
        assert_eq!(decode("abcde"), None);
    }
}
