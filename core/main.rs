//! `godot-tsc-cli`: frames on stdin, frames on stdout. A frame is a 4-byte little-endian length and that many bytes of
//! UTF-8 JSON (a request in, a response out; see `godot_tsc_core::handle`). Nothing else is written to stdout. The process
//! exits at the end of stdin. A panic ends the process (no frame is half-written: a response is written in one piece
//! after it is complete); the host starts it again.

use std::io::{self, BufReader, BufWriter, Read, Write};

fn read_frame(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut frame = vec![0u8; u32::from_le_bytes(length) as usize];
    input.read_exact(&mut frame)?;
    Ok(Some(frame))
}

fn main() -> io::Result<()> {
    godot_tsc_core::native::set_stack_size(godot_tsc_core::STACK_FOR_THE_REQUEST);
    let mut service = godot_tsc_core::Service::new();
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    while let Some(frame) = read_frame(&mut input)? {
        let response = match std::str::from_utf8(&frame) {
            Ok(request) => service.handle_json(request),
            Err(error) => godot_tsc_core::invalid_utf8_response(&error),
        };
        let length = u32::try_from(response.len()).expect("a response is under 4 GiB");
        output.write_all(&length.to_le_bytes())?;
        output.write_all(response.as_bytes())?;
        output.flush()?;
    }
    Ok(())
}
