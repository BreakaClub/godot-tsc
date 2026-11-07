//! Byte offsets in UTF-8 source (what Bun's lexer reports) to the UTF-16 positions the protocol speaks.

/// A position in a source text, in UTF-16 code units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    pub offset: usize,
    pub line: usize,
    pub character: usize,
}

/// The position of the byte offset `byte` in `text` (clamped to the text and moved back to a character boundary).
/// Line breaks are JavaScript's: `\n`, `\r\n`, `\r`, U+2028 and U+2029.
pub fn position(text: &str, byte: usize) -> Position {
    let mut byte = byte.min(text.len());
    while !text.is_char_boundary(byte) {
        byte -= 1;
    }
    let mut offset = 0;
    let mut line = 0;
    let mut line_start = 0;
    let mut chars = text[..byte].chars().peekable();
    while let Some(c) = chars.next() {
        offset += c.len_utf16();
        match c {
            '\n' | '\u{2028}' | '\u{2029}' => {
                line += 1;
                line_start = offset;
            }
            '\r' => {
                // "\r\n" is one break, counted at its "\n".
                if chars.peek() != Some(&'\n') {
                    line += 1;
                    line_start = offset;
                }
            }
            _ => {}
        }
    }
    Position { offset, line, character: offset - line_start }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_utf16_units_and_lines() {
        let text = "a\u{1F600}b\r\nc\u{2028}d";
        assert_eq!(position(text, 0), Position { offset: 0, line: 0, character: 0 });
        // After the emoji: four bytes, two UTF-16 units.
        assert_eq!(position(text, 5), Position { offset: 3, line: 0, character: 3 });
        // "c" is on the second line.
        assert_eq!(position(text, 8), Position { offset: 6, line: 1, character: 0 });
        // "d" is on the third.
        assert_eq!(position(text, text.len()), Position { offset: 9, line: 2, character: 1 });
    }
}
