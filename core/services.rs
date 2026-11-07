//! Editor services over the program the checker built: what a language server answers, from the services of `bun_sema` (the API
//! TypeScript's own checker gives a language service). Positions are UTF-16 offsets into the file's text, as everywhere in the protocol;
//! the checker's are bytes of its UTF-8 text.

use crate::check::{self, MemoryHost, Positions, Runs};
use bun_sema::check::services::{Location, NodeRef, Row, TypeFormatFlags};

/// The byte offset in `text` (UTF-8) of the UTF-16 offset `units`, or the end of the text if it is past it.
fn byte_of(text: &[u8], units: usize) -> usize {
    let mut seen = 0;
    for (at, &byte) in text.iter().enumerate() {
        if byte & 0xC0 != 0x80 {
            if seen >= units {
                return at;
            }
            // A four-byte sequence is two UTF-16 units.
            seen += if byte >= 0xF0 { 2 } else { 1 };
        }
    }
    text.len()
}

/// The byte offset where the name that contains `byte` begins: the checker finds the node that *starts* at an offset, and a pointer is
/// somewhere in the middle of a name.
fn name_start(text: &[u8], mut byte: usize) -> usize {
    let is_part = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80;
    while byte > 0 && byte <= text.len() && is_part(text[byte - 1]) && text.get(byte).is_some_and(|&b| is_part(b)) {
        byte -= 1;
    }
    byte
}

/// What the person pointing at `offset` is shown: the name under the pointer and its type, as TypeScript's quick info has them.
///
/// ```json
/// {"ok":true,"hover":{"start":n,"end":n,"name":"label","type":"string"}}   or   {"ok":true,"hover":null}
/// ```
pub fn hover(host: &MemoryHost, runs: &mut Runs, config: &[u8], lib_dir: &[u8], path: &[u8], offset: usize) -> String {
    let found = check::with_services_of(host, runs, config, lib_dir, path, |services, file, text| {
        let at = u32::try_from(name_start(text, byte_of(text, offset))).expect("a file is under 4 GiB");
        let node = services.node(Location { row: Row::NameAt(at), part: None });
        if node.is_none() {
            return None;
        }
        let node = NodeRef { file, node };
        let ty = services.type_at_location(node);
        let shown = services.type_to_string(ty, Some(node), TypeFormatFlags::NO_TRUNCATION);
        let name = services.symbol_at_location(node).map(|symbol| services.symbol_info(symbol).name.to_vec()).unwrap_or_default();
        let (start, end) = services.node_span(node);
        let positions = Positions::new(text);
        Some((positions.of(start).0, positions.of(end).0, name, shown))
    });
    let Some(Some((start, end, name, shown))) = found else {
        return String::from("{\"ok\":true,\"hover\":null}");
    };
    let mut out = format!("{{\"ok\":true,\"hover\":{{\"start\":{start},\"end\":{end},\"name\":");
    check::string(&mut out, &name);
    out.push_str(",\"type\":");
    check::string(&mut out, &shown);
    out.push_str("}}");
    out
}
