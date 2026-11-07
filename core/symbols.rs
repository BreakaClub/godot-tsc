//! The symbols of Bun's C++ side (JavaScriptCore, WebKit, ICU) that the vendored Rust libraries name and that
//! `native.rs`'s shims (Bun's own, for binaries that link the parser) do not provide.
//!
//! Two of them are used by what this host does, and are written out: `Math.pow` and the string-to-number conversion
//! that constant folding applies to `+"12"`. The others are named by code that a transpile does not reach with the
//! options it sets (macros, the runtime transpiler cache, ICU collation, WebKit strings, `file:` URLs for Bake): their
//! symbols fail loudly if that ever changes, instead of leaving the link to guess.

use core::ffi::c_void;

/// ECMAScript's `Number::exponentiate`. C's `pow` differs from it where the exponent is NaN or the base is 1 or -1 and the
/// exponent is infinite: JavaScript gives NaN, C gives 1. Everything else is the same.
#[unsafe(no_mangle)]
pub extern "C" fn Bun__JSC__operationMathPow(base: f64, exponent: f64) -> f64 {
    if exponent.is_nan() {
        return f64::NAN;
    }
    if exponent == 0.0 {
        return 1.0;
    }
    if exponent.is_infinite() && (base == 1.0 || base == -1.0) {
        return f64::NAN;
    }
    base.powf(exponent)
}

const WHITE_SPACE: &[u8] = b"\t\n\x0B\x0C\r ";

/// ECMAScript's `StringToNumber` (`ToNumber` applied to a string) for a string that is all ASCII (the caller checks): white
/// space around the number is ignored, an empty string is 0, a hex, octal or binary literal has no sign, and a decimal
/// literal is `[+-] (digits [. digits] | . digits) [e [+-] digits]` or `[+-] Infinity`. Anything else is NaN.
///
/// # Safety
/// `pointer` and `len` are a readable range of bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn JSC__jsToNumber(pointer: *const u8, len: usize) -> f64 {
    // SAFETY: as the caller promises.
    let text = unsafe { core::slice::from_raw_parts(pointer, len) };
    string_to_number(text)
}

fn string_to_number(text: &[u8]) -> f64 {
    let start = text.iter().position(|b| !WHITE_SPACE.contains(b)).unwrap_or(text.len());
    let end = text.iter().rposition(|b| !WHITE_SPACE.contains(b)).map_or(start, |last| last + 1);
    let text = &text[start..end];
    if text.is_empty() {
        return 0.0;
    }
    if let [b'0', prefix @ (b'x' | b'X' | b'o' | b'O' | b'b' | b'B'), digits @ ..] = text {
        let radix = match prefix {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            _ => 2,
        };
        return digits_in_radix(digits, radix);
    }
    let (negative, unsigned) = match text {
        [b'-', rest @ ..] => (true, rest),
        [b'+', rest @ ..] => (false, rest),
        _ => (false, text),
    };
    let magnitude = if unsigned == b"Infinity" {
        f64::INFINITY
    } else if is_decimal_literal(unsigned) {
        // The grammar is checked, so Rust's parser sees only digits, a point and an exponent: none of the words (`inf`, `nan`)
        // that it also takes.
        core::str::from_utf8(unsigned).ok().and_then(|literal| literal.parse::<f64>().ok()).unwrap_or(f64::NAN)
    } else {
        f64::NAN
    };
    if negative { -magnitude } else { magnitude }
}

fn digits_in_radix(digits: &[u8], radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut value = 0.0_f64;
    for &digit in digits {
        let Some(digit) = char::from(digit).to_digit(radix) else {
            return f64::NAN;
        };
        value = value * f64::from(radix) + f64::from(digit);
    }
    value
}

/// `digits [. digits] [e [+-] digits]` or `. digits [e [+-] digits]`, where an integer part may stand without fraction and
/// the fraction may be empty (`1.`, `.5`).
fn is_decimal_literal(text: &[u8]) -> bool {
    let digits = |from: usize| text[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let integer = digits(0);
    let mut at = integer;
    let mut fraction = 0;
    if text.get(at) == Some(&b'.') {
        at += 1;
        fraction = digits(at);
        at += fraction;
    }
    if integer == 0 && fraction == 0 {
        return false;
    }
    if matches!(text.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(text.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent = digits(at);
        if exponent == 0 {
            return false;
        }
        at += exponent;
    }
    at == text.len()
}

// ─────────────────────────── not reached ───────────────────────────

/// `WTF::StringImpl` is JavaScriptCore's; no `bun_core::String` of this host is one.
#[unsafe(no_mangle)]
pub extern "C" fn Bun__WTFStringImpl__destroy(_string: *const c_void) {
    unreachable!("this host has no WTF strings");
}

/// ICU's collator: only `localeCompare` for module specifiers needs it, in Bun's bundler.
#[unsafe(no_mangle)]
pub extern "C" fn Bun__collateUTF8(_numeric_and_base: bool, _a: *const u8, _a_len: usize, _b: *const u8, _b_len: usize) -> i32 {
    unreachable!("this host has no ICU collation");
}

#[unsafe(no_mangle)]
pub extern "C" fn Bun__collateUTF16(_numeric_and_base: bool, _a: *const u16, _a_len: usize, _b: *const u16, _b_len: usize) -> i32 {
    unreachable!("this host has no ICU collation");
}

/// `import.meta.url` as a `file:` URL, inlined for Bun's Bake framework or a bundled CommonJS output: neither is a
/// setting of this host.
#[unsafe(no_mangle)]
pub extern "C" fn URL__getFileURLString(_input: &bun_core::String) -> bun_core::String {
    unreachable!("this host inlines no import.meta.url");
}

bun_ast::link_impl_TranspilerCacheImpl! {
    Jsc for extern bun_ast::RuntimeTranspilerCache => |this| {
        get(_source, _parser_options, _used_jsx) => {
            let _ = this;
            unreachable!("this host sets no runtime transpiler cache")
        },
        put(_output_code, _sourcemap, _esm_record) => {
            let _ = this;
            unreachable!("this host sets no runtime transpiler cache")
        },
        is_disabled() => {
            let _ = this;
            unreachable!("this host sets no runtime transpiler cache")
        },
    }
}

/// Bun's macros run JavaScript at build time; `features.no_macros` is set. The parameters are the ones Bun's declaration of this function has.
#[allow(clippy::too_many_arguments)]
#[unsafe(no_mangle)]
fn __bun_macro_context_call(
    _context: &mut bun_js_parser::Macro::MacroContext,
    _import_record_path: &[u8],
    _source_dir: &[u8],
    _log: &mut bun_ast::Log,
    _source: &bun_ast::Source,
    _import_range: bun_ast::Range,
    _caller: bun_ast::Expr,
    _function_name: &[u8],
) -> Result<bun_ast::Expr, bun_js_parser::Error> {
    unreachable!("this host runs no macros")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn math_pow_is_javascripts() {
        assert!(Bun__JSC__operationMathPow(1.0, f64::INFINITY).is_nan());
        assert!(Bun__JSC__operationMathPow(-1.0, f64::NEG_INFINITY).is_nan());
        assert!(Bun__JSC__operationMathPow(1.0, f64::NAN).is_nan());
        assert_eq!(Bun__JSC__operationMathPow(f64::NAN, 0.0), 1.0);
        assert_eq!(Bun__JSC__operationMathPow(2.0, 10.0), 1024.0);
    }

    #[test]
    fn string_to_number_is_javascripts() {
        assert_eq!(string_to_number(b"  12.5e1 "), 125.0);
        assert_eq!(string_to_number(b""), 0.0);
        assert_eq!(string_to_number(b"0x1F"), 31.0);
        assert_eq!(string_to_number(b"-Infinity"), f64::NEG_INFINITY);
        assert_eq!(string_to_number(b".5"), 0.5);
        assert_eq!(string_to_number(b"5."), 5.0);
        for rejected in [&b"inf"[..], b"nan", b"1e", b"-0x1", b"0x", b"1_0", b"e5", b"."] {
            assert!(string_to_number(rejected).is_nan(), "{}", String::from_utf8_lossy(rejected));
        }
    }
}
