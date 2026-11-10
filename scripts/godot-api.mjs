// The Godot APIs the extension is bound to, and the Web profiles. One file names them; the build scripts and stage-addon.mjs read it.
//
// Native: one build per platform and architecture (NATIVE_TARGETS), bound to stock Godot 4.7.2's dumps (api/godot-4.7.2). A GDExtension loads in
// the Godot it was bound to or a newer one, and godot-rust's `lazy-function-tables` resolves each method on first use, so the one build also loads
// in newer engines.
//
// Web: a side module must be linked with the Emscripten of the engine whose templates load it, and one linked for another engine's templates kills
// the page at load. So the Web build is per profile, each with its own file name:
//   stock   stock Godot 4.7 Web templates (Emscripten 4.0.11), bound to the 4.7.2 dumps. This is the module the shipped manifest names.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const NATIVE_API = Object.freeze({
  version: '4.7.2',
  extensionApi: resolve(root, 'api/godot-4.7.2/extension_api.json'),
  gdextensionInterface: resolve(root, 'api/godot-4.7.2/gdextension_interface.json'),
});

export const WEB_PROFILES = Object.freeze({
  stock: Object.freeze({
    name: 'stock',
    library: 'godot_tsc.web.stock.wasm',
    extensionApi: NATIVE_API.extensionApi,
    gdextensionInterface: NATIVE_API.gdextensionInterface,
  }),
});

/** The dump pair as godot-rust's variables. Cargo's `[env]` (.cargo/config.toml) does not override a variable already set, so builds set these. */
export function bindingEnvironment(api) {
  return { GDRUST_GODOT_API_JSON: api.extensionApi, GDRUST_GODOT_INTERFACE_JSON: api.gdextensionInterface };
}

/** Where builds leave the binaries that stage-addon.mjs packs (the names the manifest uses). */
export const OUT_BIN = resolve(root, 'out/bin');

/** The macOS library: one file, with one architecture (a build for this machine) or both (`macos.universal`). The manifest lists what it has. */
export const MACOS_LIBRARY = 'libgodot_tsc.dylib';
const MACOS_TRIPLES = Object.freeze({ arm64: 'aarch64-apple-darwin', x86_64: 'x86_64-apple-darwin' });

/**
 * The native builds, by the name `build-native.mjs --target=` takes. `triples` are the Rust targets built (more than one are joined with
 * `lipo`), `artifact` is the file cargo writes for each, `library` is the file's name in out/bin and in the addon, and `features` are the
 * manifest's feature tags after the build mode (`linux.debug.x86_64`); the macOS library's are read from the file instead.
 * 32-bit targets are not built: Bun's Windows bindings do not compile for them, and Godot's 64-bit targets cover current devices.
 */
export const NATIVE_TARGETS = Object.freeze({
  'macos.universal': { platform: 'macos', triples: Object.values(MACOS_TRIPLES), artifact: 'libgodot_tsc.dylib', library: MACOS_LIBRARY },
  'macos.arm64': { platform: 'macos', triples: [MACOS_TRIPLES.arm64], artifact: 'libgodot_tsc.dylib', library: MACOS_LIBRARY },
  'macos.x86_64': { platform: 'macos', triples: [MACOS_TRIPLES.x86_64], artifact: 'libgodot_tsc.dylib', library: MACOS_LIBRARY },
  'linux.x86_64': { platform: 'linux', triples: ['x86_64-unknown-linux-gnu'], artifact: 'libgodot_tsc.so', library: 'libgodot_tsc.linux.x86_64.so', features: ['x86_64'] },
  'linux.arm64': { platform: 'linux', triples: ['aarch64-unknown-linux-gnu'], artifact: 'libgodot_tsc.so', library: 'libgodot_tsc.linux.arm64.so', features: ['arm64'] },
  'windows.x86_64': { platform: 'windows', triples: ['x86_64-pc-windows-msvc'], artifact: 'godot_tsc.dll', library: 'godot_tsc.windows.x86_64.dll', features: ['x86_64'] },
  'windows.arm64': { platform: 'windows', triples: ['aarch64-pc-windows-msvc'], artifact: 'godot_tsc.dll', library: 'godot_tsc.windows.arm64.dll', features: ['arm64'] },
  'android.arm64': { platform: 'android', triples: ['aarch64-linux-android'], artifact: 'libgodot_tsc.so', library: 'libgodot_tsc.android.arm64.so', features: ['arm64'] },
  'android.x86_64': { platform: 'android', triples: ['x86_64-linux-android'], artifact: 'libgodot_tsc.so', library: 'libgodot_tsc.android.x86_64.so', features: ['x86_64'] },
  // A device build only. A simulator build would be a second arm64 library, which a manifest cannot tell from the device's by feature tags.
  'ios.arm64': { platform: 'ios', triples: ['aarch64-apple-ios'], artifact: 'libgodot_tsc.dylib', library: 'libgodot_tsc.ios.arm64.dylib', features: ['arm64'] },
});

/** The file names a native library can have in out/bin, each once. */
export const NATIVE_LIBRARY_NAMES = Object.freeze([...new Set(Object.values(NATIVE_TARGETS).map(target => target.library))]);

/** The build for this machine: the name of a NATIVE_TARGETS entry, or undefined where there is none (a 32-bit host, another system). */
export function hostNativeTarget() {
  const platform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  const name = `${platform}.${arch}`;
  return name in NATIVE_TARGETS ? name : undefined;
}

/** The `--name=value` argument, or undefined; any other argument that is not in `flags` is refused. */
export function parseArguments(argv, { flags = [], values = [] }) {
  const result = { flags: new Set(), values: {} };
  for (const argument of argv) {
    const [name, value] = argument.split(/=(.*)/su);
    if (value === undefined && flags.includes(name)) result.flags.add(name);
    else if (value !== undefined && values.includes(name)) result.values[name] = value;
    else throw new Error(`Unknown argument ${argument}. Takes ${[...flags, ...values.map(name => `${name}=<value>`)].join(', ') || 'none'}.`);
  }
  return result;
}

/**
 * The cargo of the toolchain rust-toolchain.toml names, and its `bin` directory, which the build scripts put first on PATH so that cargo
 * runs that toolchain's rustc and never another on PATH (Homebrew's rustc aborts here). rustup is asked (`rustup which cargo`): it knows
 * where its toolchains are, which is not always ~/.cargo/bin (GitHub's macOS runners have rustup on PATH and nothing there). `CARGO`
 * names a cargo to use instead.
 */
export function rustToolchain() {
  if (process.env.CARGO) return { cargo: process.env.CARGO, bin: dirname(process.env.CARGO) };
  const tried = [];
  for (const rustup of ['rustup', join(homedir(), '.cargo/bin/rustup')]) {
    const result = spawnSync(rustup, ['which', 'cargo'], { cwd: root, encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') {
      tried.push(rustup);
      continue;
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${rustup} which cargo failed (${result.status}): ${result.stderr.trim()}`);
    const cargo = result.stdout.trim();
    return { cargo, bin: dirname(cargo) };
  }
  throw new Error(`No rustup (tried ${tried.join(', ')}): install rustup, or set CARGO to a cargo of the toolchain in rust-toolchain.toml`);
}

/** `env` with the toolchain's `bin` first on PATH. */
export function withToolchainPath(toolchain, env, ...more) {
  return { ...env, PATH: [toolchain.bin, ...more, env.PATH ?? ''].join(delimiter) };
}
