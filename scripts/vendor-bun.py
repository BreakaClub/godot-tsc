#!/usr/bin/env python3
"""Extract the pinned closure of Bun's TypeScript checker, JavaScript parser and printer into vendor/bun.

`bun_sema` with its parser `bun_sema_parser` (the checker), and `bun_js_parser` with `bun_js_printer` (the compiler), with
the Rust libraries they need, from a Bun checkout at REVISION. The checker's closure and the compiler's (the parser, the
printer, the stand-ins and the reduced manifests) share their base, so they are one tree, and one library links both.

What the extraction changes, and why, is in three tables below:

- SOURCE_ADAPTATIONS: files of Bun that are patched (reviewed patches in patches/, applied to pristine files);
- REPLACED_CRATES: crates that are not vendored but written (stubs/<crate path>/), with the files of Bun's crate they
  keep verbatim;
- EXCLUDED_FILES: files of vendored crates that are left out because the patched crate no longer has them.

Everything else is Bun's, byte for byte (provenance.json has the upstream and extracted SHA-256 of every file). Manifests
lose their development-only tables and their binary, test and bench targets. The Bun checkout is only read.

    python3 scripts/vendor-bun.py <bun checkout>            # write vendor/bun
    python3 scripts/vendor-bun.py <bun checkout> --verify   # check vendor/bun is that extraction

`pnpm vendor` (scripts/vendor.mjs) runs it with a checkout of Bun at REVISION, fetching one when it is not given.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import tomllib
from pathlib import Path, PurePosixPath

REVISION = "408c9374b266b45fe6b8260e09be73aa82a957cd"
PACKAGE = Path(__file__).resolve().parent.parent
DESTINATION = PACKAGE / "vendor" / "bun"
STUBS = PACKAGE / "stubs"
ROOTS = ["bun_sema", "bun_sema_parser", "bun_js_parser", "bun_js_printer"]
# Parts of src/sema that are no part of the two checker libraries: Bun's driver, its baselines, its command line. The
# command line's native shims are kept, as standalone-native.rs, for the host crate.
SEMA_EXCLUDED = ["driver", "baselines", "standalone"]
STANDALONE_NATIVE = "src/sema/standalone/native.rs"

# Crates that are not Bun's, with the files of Bun's crate that they keep verbatim. The directory stubs/<crate path>
# holds the rest (its manifest included).
REPLACED_CRATES = {
    "src/crash_handler": {
        "keep": [],
        "reason": "Bun's crash handler installs signal handlers and reports crashes (bun_analytics, bun_io, bun_sys, bun_which, "
                  "bun_zlib). The parser and printer use scoped_action, Action and handle_oom only; the stand-in has those.",
    },
    "src/io": {
        "keep": ["write.rs"],
        "reason": "Bun's bun_io is the event loop, pipes and polling (bun_sys, bun_uws_sys, bun_spawn_sys). The printer and "
                  "the source map writer use its byte-writer module (write.rs) only, which is kept as it is.",
    },
}

OPTIONS_TYPES_REASON = ("bun_options_types is the command line's and the bundler's configuration; the parser and printer use its "
                        "enums (jsx.rs, bundle_enums.rs). What reached bun_dotenv, bun_install_types, bun_semver, bun_sys and "
                        "bun_url (the install and compile-target settings) is left out, with the patch that drops it.")

# Files of vendored crates that the patched crate does not have. A path is a file or a directory (with a trailing slash).
EXCLUDED_FILES = [
    ("benches/", "Cargo benchmark targets: the manifests lose their [[bench]] tables."),
    *((f"src/options_types/{name}.rs", OPTIONS_TYPES_REASON) for name in [
        "code_coverage_options", "command_tag", "compile_target", "context", "global_cache", "offline_mode"]),
]

FILE_KEYS = "patches/bun-sema-file-keys.patch"
DOCUMENTATION = "patches/bun-sema-documentation.patch"
SYMBOLS_IN_SCOPE = "patches/bun-sema-symbols-in-scope.patch"
OPTIONS_TYPES = "patches/bun-options-types-reduced.patch"
SOURCEMAP = "patches/bun-sourcemap-write-only.patch"
WASM32 = "patches/bun-wasm32.patch"
PARSER = "patches/bun-js-parser-wasm32.patch"
STANDALONE = "patches/bun-standalone-native.patch"
# Written against the files as WASM32 leaves them: patches apply in the order SOURCE_ADAPTATIONS first names them.
APPLE = "patches/bun-apple-targets.patch"
APPLE_REASON = ("Bun builds for macOS only among Apple's systems, so what is Darwin's (errno values, stat fields, kqueue, "
                "Mach calls, the dispatch thread pool, os_signpost) is behind `target_os = \"macos\"`, and iOS matches no branch. "
                "Those conditions are `target_vendor = \"apple\"`: the same code on macOS, and iOS takes it too.")

# Written against the file as WASM32 and APPLE leave it.
ANDROID = "patches/bun-android.patch"

def adaptation(path, patch, reason):
    return {"path": path, "patch": patch, "reason": reason}


SOURCE_ADAPTATIONS = [
    *(adaptation(f"src/ast/{path}", WASM32, reason) for path, reason in [
        ("Cargo.toml", "bun_sys, and what only it is used for, is a dependency of non-wasm targets."),
        ("b.rs", "64-bit size asserts hold on 64-bit targets only."),
        ("e.rs", "64-bit size asserts hold on 64-bit targets only."),
        ("expr.rs", "64-bit size asserts and pointer tag bits: 64-bit targets only."),
        ("lib.rs", "File reading through bun_sys is not on wasm."),
        ("nodes.rs", "64-bit size asserts hold on 64-bit targets only."),
        ("stmt.rs", "64-bit size asserts and pointer tag bits: 64-bit targets only."),
        ("symbol.rs", "64-bit size asserts hold on 64-bit targets only."),
    ]),
    *(adaptation(f"src/bun_alloc/{path}", WASM32, reason) for path, reason in [
        ("arena_box.rs", "64-bit size asserts hold on 64-bit targets only."),
        ("baby_vec.rs", "64-bit size asserts hold on 64-bit targets only."),
        ("basic.rs", "The C allocator is the default allocator's on wasm, which has no C library."),
        ("lib.rs", "wasm has no C library: the default allocator is Rust's, and page size is a constant."),
    ]),
    *(adaptation(f"src/bun_core/{path}", WASM32, reason) for path, reason in [
        ("Global.rs", "No process exit or signals on wasm."),
        ("debug.rs", "No msync on wasm: memory is always valid."),
        ("lib.rs", "'Not Windows' is not POSIX: wasm takes the portable string paths."),
        ("output.rs", "The output stream is a file handle on every target."),
        ("string/SmolStr.rs", "64-bit size asserts hold on 64-bit targets only."),
        ("string/mod.rs", "64-bit layout asserts; the string tag bits are computed in u64."),
        ("util.rs", "No clock, process reload, executable path or polling on wasm."),
    ]),
    *(adaptation(f"src/options_types/{path}", OPTIONS_TYPES, reason) for path, reason in [
        ("Cargo.toml", "The dependencies of the left-out modules go."),
        ("lib.rs", "The modules of the install and compile-target settings go."),
        ("schema.rs", "TransformOptions and BunInstall (the command line's option bags, which name bun_dotenv, bun_install_types and "
                      "bun_url) go; the enums the parser, jsx.rs and bundle_enums.rs use stay."),
    ]),
    adaptation("src/sourcemap/Cargo.toml", SOURCEMAP, "bun_parsers and bun_sys go with the readers that used them."),
    adaptation("src/sourcemap/lib.rs", SOURCEMAP,
               "Reading a source map (parse_json, over bun_parsers) and finding a `.map` file (bun_sys) are the runtime's: "
               "source maps are written here, never read."),
    adaptation("src/sourcemap/Mapping.rs", SOURCEMAP, "Reading a source file for a stack trace needs bun_sys."),
    adaptation("src/js_parser/parse/parse_entry.rs", PARSER,
               "Bun's wasm32 branch of the parser (no macros, no transpiler cache) gives MacroContext a type (a bare pointer) that the macro call sites it type-checks have no methods on: it is the macro context type of every target, as on native."),
    adaptation("src/sema/atom.rs", WASM32, "64-bit size asserts hold on 64-bit targets only."),
    adaptation("src/sema/resolve.rs", WASM32, "wasm32-unknown-unknown has no clock: phase timing is skipped."),
    adaptation("src/sema/types.rs", WASM32, "64-bit size asserts hold on 64-bit targets only."),
    adaptation("src/sema/check/expr.rs", FILE_KEYS,
               "A key of a file and an expression kept the file in the high 32 bits of a usize, which on wasm32 drops it: keys of different files collided. It is a u64."),
    adaptation("src/sema/check/call.rs", FILE_KEYS, "unique_type_params takes that key as a u64."),
    adaptation("src/sema/check/jsdoc.rs", DOCUMENTATION,
               "The reader collects a comment's own text, as TypeScript's parser reads it into the comment's JSDocText (own_text): a description of a property carries its documentation."),
    adaptation("src/sema/check/services/jsdoc.rs", DOCUMENTATION,
               "documentation_of_property: symbol.getDocumentationComment of a property in plain text, over own_text, as TypeScript's API gives it."),
    adaptation("src/sema/check/services/symbol_at_location.rs", SYMBOLS_IN_SCOPE,
               "symbols_in_scope: TypeScript's getSymbolsInScope, which completion lists; the services had it only as the private copy_symbols_in_scope, behind symbol_in_scope's lookup of one name."),
    adaptation("src/semver/lib.rs", WASM32, "64-bit size asserts hold on 64-bit targets only (the String is eight bytes either way)."),
    adaptation("src/errno/lib.rs", WASM32, "wasm has no errno table: it takes the portable one."),
    adaptation("src/perf/Cargo.toml", WASM32, "bun_sys is a dependency of non-wasm targets."),
    adaptation("src/threading/Cargo.toml", WASM32, "The futex feature flag; bun_sys is a dependency of non-wasm targets."),
    adaptation("src/threading/Futex.rs", WASM32, "Without atomics wasm has one thread: waiting never blocks."),
    adaptation("src/threading/lib.rs", WASM32, "The futex module is cfg-gated as Futex.rs is."),
    adaptation("src/windows_sys/externs.rs", WASM32, "The inline assembly has no wasm branch."),
    *(adaptation(f"src/{path}", APPLE, APPLE_REASON) for path in [
        "bun_alloc/heap_breakdown.rs", "bun_alloc/lib.rs", "bun_core/Global.rs", "bun_core/env.rs", "bun_core/lib.rs",
        "bun_core/result.rs", "bun_core/thread_id.rs", "bun_core/util.rs", "errno/lib.rs", "perf/lib.rs", "sys/PosixStat.rs",
        "sys/copy_file.rs", "sys/fd.rs", "sys/lib.rs", "threading/ThreadPool.rs", "threading/io_thread_pool.rs"]),
    adaptation("src/bun_core/util.rs", ANDROID,
               "Thread-local random seeds come from getrandom, which Android's C library has from API level 28: a library for "
               "API level 24, the oldest Godot runs on, reads /dev/urandom."),
    adaptation(STANDALONE_NATIVE, STANDALONE,
               "Bun's native shims for binaries that link the checker and the parser (mimalloc, highway, simdutf, dtoa, ...) serve the host crate: "
               "malloc without a C library on wasm, no weak linkage there, and simdutf's base64 encoder (React Fast Refresh's hook signatures are the base64 of a hash; Bun's shim leaves it unimplemented)."),
]


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args])


def sections(text):
    return re.split(r"(?m)^(?=\[)", text)


def patched_sources(source):
    """Each reviewed patch, applied once to pristine files in a directory of its own."""
    by_patch = {}
    for entry in SOURCE_ADAPTATIONS:
        by_patch.setdefault(entry["patch"], set()).add(entry["path"])
    with tempfile.TemporaryDirectory(prefix="godot-tsc-bun-extract-") as directory:
        temporary = Path(directory)
        paths = set().union(*by_patch.values())
        for path in paths:
            target = temporary / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git(source, "show", f"{REVISION}:{path}"))
        for patch_name, expected in by_patch.items():
            patch = (PACKAGE / patch_name).read_bytes()
            stats = subprocess.check_output(["git", "apply", "--numstat", "-z"], input=patch, cwd=temporary)
            changed = {record.split(b"\t", 2)[2].decode() for record in stats.split(b"\0") if record}
            if changed != expected:
                raise SystemExit(f"{patch_name} changes {sorted(changed ^ expected)} unlike its source adaptations")
            subprocess.run(["git", "apply", "--whitespace=nowarn"], input=patch, cwd=temporary, check=True)
        return {path: (temporary / path).read_bytes() for path in paths}


def library_manifest(text):
    """The manifest without development-only tables or binary, test and bench targets."""
    kept = [s for s in sections(text) if not re.match(
        r"\[(?:dev-dependencies|target\..*\.dev-dependencies|\[test|\[bench|\[bin|\[example)\]", s)]
    return "".join(kept)


def normalise(path):
    """A path in Bun's tree (always `/`-separated, whatever the host) without its `.` and `..` components."""
    parts = []
    for part in path.parts:
        if part == "..":
            parts.pop()
        elif part != ".":
            parts.append(part)
    return PurePosixPath(*parts)


def excluded(path):
    """Whether a tracked file is one of EXCLUDED_FILES: a path, or a directory name (with a trailing slash) at any depth."""
    return any(f"/{prefix}" in f"/{path}" if prefix.endswith("/") and "/" not in prefix[:-1] else
               path.startswith(prefix) if prefix.endswith("/") else path == prefix
               for prefix, _ in EXCLUDED_FILES)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve()
    head = git(source, "rev-parse", "HEAD").decode().strip()
    if head != REVISION:
        parser.error(f"expected {REVISION}; the checkout is at {head}")
    adapted = patched_sources(source)
    if not args.verify and DESTINATION.exists():
        # Generated and ignored: written from nothing, so a file that is no longer part of the extraction cannot stay.
        shutil.rmtree(DESTINATION)
    root = git(source, "show", f"{REVISION}:Cargo.toml").decode()
    inherited = tomllib.loads(root)["workspace"]["dependencies"]
    path_to_name = {}
    closure = {}
    used = set()

    def manifest_of(package_path):
        if package_path in REPLACED_CRATES:
            return (STUBS / package_path / "Cargo.toml").read_text(encoding="utf-8")
        manifest_path = f"{package_path}/Cargo.toml"
        return library_manifest(adapted.get(manifest_path, git(source, "show", f"{REVISION}:{manifest_path}")).decode())

    def visit_path(package_path):
        if package_path in path_to_name:
            return
        manifest = manifest_of(package_path)
        data = tomllib.loads(manifest)
        name = data["package"]["name"]
        path_to_name[package_path] = name
        closure[name] = (package_path, manifest)
        groups = [data.get("dependencies", {}), data.get("build-dependencies", {})]
        for table in data.get("target", {}).values():
            groups += [table.get("dependencies", {}), table.get("build-dependencies", {})]
        for group in groups:
            for key, dependency in group.items():
                if not isinstance(dependency, dict):
                    continue
                if dependency.get("workspace"):
                    used.add(key)
                    if isinstance(inherited[key], dict) and "path" in inherited[key]:
                        visit_path(inherited[key]["path"])
                elif "path" in dependency:
                    # A path dependency that is no workspace dependency (bun_js_parser's bun_react_compiler).
                    visit_path(str(normalise(PurePosixPath(package_path) / dependency["path"])))

    for name in ROOTS:
        visit_path(inherited[name]["path"])
    hashes = {}

    def output(path, contents, upstream=None):
        target = DESTINATION / path
        if args.verify:
            if not target.is_file() or target.read_bytes() != contents:
                raise SystemExit(f"not the extraction: {target}")
        elif not target.is_file() or target.read_bytes() != contents:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(contents)
        entry = {"sha256": hashlib.sha256(contents).hexdigest()}
        if upstream:
            entry = {"upstream": upstream, "upstream_sha256": hashlib.sha256(git(source, "show", f"{REVISION}:{upstream}")).hexdigest(), **entry}
        hashes[path] = entry

    tracked = git(source, "ls-tree", "-r", "--name-only", REVISION).decode().splitlines()
    crate_paths = sorted(path for path, _ in closure.values())
    written = set()
    for path in tracked:
        # The innermost crate that holds the file: src/sema/parser is a crate of its own inside src/sema.
        holders = [p for p in crate_paths if path.startswith(p + "/")]
        if not holders or path.endswith("/Cargo.toml"):
            continue
        holder = max(holders, key=len)
        relative = path[len(holder) + 1:]
        if holder == "src/sema" and any(path.startswith(f"src/sema/{part}/") for part in SEMA_EXCLUDED):
            continue
        if holder in REPLACED_CRATES:
            if relative not in REPLACED_CRATES[holder]["keep"]:
                continue
        elif excluded(path):
            continue
        output(path, adapted.get(path, git(source, "show", f"{REVISION}:{path}")), path)
        written.add(path)
    for package_path, manifest in closure.values():
        if package_path in REPLACED_CRATES:
            continue
        output(f"{package_path}/Cargo.toml", manifest.encode(), f"{package_path}/Cargo.toml")
    for package_path in REPLACED_CRATES:
        if package_path not in crate_paths:
            raise SystemExit(f"{package_path} is replaced but no crate of the closure depends on it")
        stub_root = STUBS / package_path
        for stub in sorted(p for p in stub_root.rglob("*") if p.is_file()):
            output(f"{package_path}/{stub.relative_to(stub_root).as_posix()}", stub.read_bytes())
        for kept in REPLACED_CRATES[package_path]["keep"]:
            if f"{package_path}/{kept}" not in written:
                raise SystemExit(f"{package_path}/{kept} is kept from Bun but upstream has no such file")
    output("standalone-native.rs", adapted[STANDALONE_NATIVE], STANDALONE_NATIVE)
    unapplied = [path for path in adapted if path not in written and path != STANDALONE_NATIVE and not path.endswith("Cargo.toml")]
    if unapplied:
        raise SystemExit(f"adapted files outside the extraction: {unapplied}")
    for original, target in [("LICENSE.md", "LICENSE.md"),
                             ("test/cli/check/typescript-go/LICENSE", "licenses/typescript-go-LICENSE"),
                             ("test/cli/check/typescript-go/NOTICE.txt", "licenses/typescript-go-NOTICE.txt"),
                             ("src/runtime/cli/typescript_libs.bin", "typescript_libs.bin"),
                             ("Cargo.lock", "Cargo.lock")]:
        output(target, git(source, "show", f"{REVISION}:{original}"), original)
    dependency_section = next(s for s in sections(root) if s.startswith("[workspace.dependencies]"))
    dependency_lines = [line for line in dependency_section.splitlines()[1:]
                        if (match := re.match(r"^([\w-]+)\s*=", line)) and match[1] in used]
    manifest = ("# Generated by godot-tsc/scripts/vendor-bun.py; provenance.json lists the adaptations.\n"
                "[workspace]\nresolver = \"2\"\nmembers = " + json.dumps(crate_paths) + "\n\n"
                "[workspace.package]\nversion = \"0.0.0\"\nedition = \"2024\"\n\n"
                "[workspace.lints.rust]\nunexpected_cfgs = { level = \"warn\", check-cfg = ["
                "'cfg(bun_asan)', 'cfg(bun_debug)', 'cfg(socket_fault_injection)', "
                "'cfg(bun_disallow_code_generation_from_strings)', 'cfg(bun_sema_mimalloc)'] }\n\n"
                "[workspace.dependencies]\n" + "\n".join(dependency_lines) + "\n")
    output("Cargo.toml", manifest.encode())
    # bun_core's build script reads the build's identity from the configure step's output, which a library build
    # has not run: constants that say so.
    build_options = f'''// Standalone library build identity, generated by vendor-bun.py.
pub const SHA: &str = "{REVISION}";
pub const REPORTED_NODEJS_VERSION: &str = "";
pub const RELEASE_SAFE: bool = true;
pub const IS_CANARY: bool = false;
pub const CANARY_REVISION: &str = "";
pub const ENABLE_FUZZILLI: bool = false;
pub const FALLBACK_HTML_VERSION: &str = "0000000000000000";
pub const VERSION: crate::Version = crate::Version {{ major: 0, minor: 0, patch: 0 }};
pub const BASE_PATH: &[u8] = b"";
pub const CODEGEN_PATH: &[u8] = b"";
pub const ENABLE_LOGS: bool = false;
pub const ENABLE_ASAN: bool = false;
pub const ENABLE_TINYCC: bool = false;
'''
    output("build/debug/codegen/build_options.rs", build_options.encode())
    if args.verify:
        stale = [p for p in DESTINATION.rglob("*") if p.is_file() and p.relative_to(DESTINATION).as_posix() not in hashes
                 and p.name != "provenance.json"]
        if stale:
            raise SystemExit(f"files in vendor/bun that are not the extraction: {[str(p) for p in stale[:10]]}")
    provenance = {
        "upstream": "https://github.com/oven-sh/bun",
        "revision": REVISION,
        "crates": sorted(closure),
        "replaced_crates": {path: {"crate": path_to_name[path], **value} for path, value in sorted(REPLACED_CRATES.items())},
        "excluded_files": [{"path": path, "reason": reason} for path, reason in EXCLUDED_FILES],
        "manifest_adaptations": ["Remove development dependency tables and binary, test, bench and example targets.",
                                 "Replace Bun's workspace manifest with the dependency closure of the libraries."],
        "source_adaptations": [{**entry, "patch_sha256": hashlib.sha256((PACKAGE / entry["patch"]).read_bytes()).hexdigest()}
                               for entry in SOURCE_ADAPTATIONS],
        "files": dict(sorted(hashes.items())),
    }
    text = (json.dumps(provenance, indent=2) + "\n").encode()
    if args.verify:
        if (DESTINATION / "provenance.json").read_bytes() != text:
            raise SystemExit("provenance.json is not this extraction's")
        print(f"vendor/bun is the extraction of {REVISION}: {len(hashes)} files, {len(closure)} crates")
    else:
        (DESTINATION / "provenance.json").write_bytes(text)
        print(f"extracted {len(hashes)} files of {len(closure)} crates from {REVISION}")


if __name__ == "__main__":
    main()
