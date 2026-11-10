// Builds the native extension into out/bin, where stage-addon.mjs packs it from:
//
//   node scripts/build-native.mjs [--target=<name>] [--cli]
//
// `--target` names a build of scripts/godot-api.mjs's NATIVE_TARGETS (`linux.arm64`, `macos.universal`, `android.arm64`, ...); without it the
// build is this machine's. Each needs its Rust target installed (`rustup target add <triple>`) and a linker for it:
//
//   macOS, iOS   Xcode (the iOS build needs its iOS SDK)
//   Linux        the machine's own compiler: build on the architecture the library is for
//   Windows      Visual Studio's build tools, with the ARM64 ones for `windows.arm64`
//   Android      the NDK: ANDROID_NDK_HOME (or ANDROID_NDK_LATEST_HOME, which GitHub's runners set)
//
// It is bound to stock Godot 4.7.2's API (scripts/godot-api.mjs), so one build serves 4.7.2 and newer engines. `--cli` also builds
// `godot-tsc-cli` for this machine, a native process that answers the same requests framed on stdin and stdout (tests/compile.test.ts drives it).
// Bun's crates are extracted into vendor/ first when they are not there (scripts/vendor.mjs). The toolchain is rust-toolchain.toml's nightly.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  bindingEnvironment, hostNativeTarget, NATIVE_API, NATIVE_TARGETS, OUT_BIN, parseArguments, root, rustToolchain, withToolchainPath,
} from './godot-api.mjs';
import { vendor } from './vendor.mjs';

// The oldest Android that Godot 4.7's export templates run on (their minSdk): the NDK compiler wrapper of that API level links the library.
const ANDROID_API_LEVEL = 24;
// Android devices with 16 KB memory pages load only libraries whose segments are aligned to them; the alignment also serves 4 KB devices.
const ANDROID_MAX_PAGE_SIZE = 16384;
// The oldest iOS that Godot 4.7's export templates run on. rustc's default is older, and the linker warns about each object built for less.
const IOS_DEPLOYMENT_TARGET = '14.0';
// Bun's crates are built as they come, with their lints reported, not enforced (.cargo/config.toml says the same for a plain cargo build).
const RUSTFLAGS = ['--cap-lints=warn'];

const args = parseArguments(process.argv.slice(2), { flags: ['--cli'], values: ['--target'] });
const name = args.values['--target'] ?? hostNativeTarget();
const target = NATIVE_TARGETS[name];
if (target === undefined) {
  throw new Error(`No native build named ${name ?? `for ${process.platform} ${process.arch}`}. --target takes ${Object.keys(NATIVE_TARGETS).join(', ')}.`);
}
const toolchain = rustToolchain();
const cargo = toolchain.cargo;

/** Cargo's environment variable infix for a target triple. */
const cargoTargetVariable = triple => triple.toUpperCase().replaceAll('-', '_');

/** The NDK's clang wrapper for a triple, which links with the NDK's sysroot and libraries. */
function androidLinker(triple) {
  const ndk = process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK_LATEST_HOME;
  if (ndk === undefined) throw new Error('An Android build needs the NDK: set ANDROID_NDK_HOME to it.');
  const prebuilt = join(ndk, 'toolchains/llvm/prebuilt');
  const [host] = existsSync(prebuilt) ? readdirSync(prebuilt).filter(entry => !entry.startsWith('.')) : [];
  if (host === undefined) throw new Error(`${prebuilt} has no toolchain: is ${ndk} an NDK?`);
  const linker = join(prebuilt, host, 'bin', `${triple}${ANDROID_API_LEVEL}-clang${process.platform === 'win32' ? '.cmd' : ''}`);
  if (!existsSync(linker)) throw new Error(`The NDK at ${ndk} has no ${linker}`);
  return linker;
}

function environment(triple) {
  const env = withToolchainPath(toolchain, { ...process.env, ...bindingEnvironment(NATIVE_API) });
  const rustflags = [...RUSTFLAGS];
  if (target.platform === 'android') {
    env[`CARGO_TARGET_${cargoTargetVariable(triple)}_LINKER`] = androidLinker(triple);
    rustflags.push('-C', `link-arg=-Wl,-z,max-page-size=${ANDROID_MAX_PAGE_SIZE}`);
  }
  // A shared object links with symbols left undefined unless told otherwise, and then fails when Godot loads it. The Apple and Windows
  // linkers refuse them already.
  if (target.platform === 'android' || target.platform === 'linux') rustflags.push('-C', 'link-arg=-Wl,-z,defs');
  if (target.platform === 'ios') env.IPHONEOS_DEPLOYMENT_TARGET = IOS_DEPLOYMENT_TARGET;
  // A target's rustflags from the environment replace .cargo/config.toml's for it, so these are the whole set.
  env[`CARGO_TARGET_${cargoTargetVariable(triple)}_RUSTFLAGS`] = rustflags.join(' ');
  return env;
}

function run(command, commandArgs, env) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(resolve(root, 'vendor/bun/Cargo.toml'))) vendor();
const built = [];
for (const triple of target.triples) {
  run(cargo, ['build', '--locked', '--release', '-p', 'godot_tsc_ext', '--target', triple], environment(triple));
  built.push(resolve(root, 'target', triple, 'release', target.artifact));
}
if (args.flags.has('--cli')) {
  if (name !== hostNativeTarget()) throw new Error(`--cli builds godot-tsc-cli for this machine (${hostNativeTarget()}), not for ${name}.`);
  // Its own build, not one with both packages: `--bin` selects the targets of every package named, and the extension (a library) would not be built.
  // No --target: tests/compile.test.ts runs target/release/godot-tsc-cli.
  run(cargo, ['build', '--locked', '--release', '-p', 'godot_tsc_core', '--bin', 'godot-tsc-cli'], withToolchainPath(toolchain, { ...process.env, ...bindingEnvironment(NATIVE_API) }));
}
mkdirSync(OUT_BIN, { recursive: true });
// Staged and renamed, so a Godot that has the old library mapped keeps its inode.
const installed = resolve(OUT_BIN, target.library);
const staged = `${installed}.${process.pid}.tmp`;
if (built.length === 1) copyFileSync(built[0], staged);
else run('lipo', ['-create', ...built, '-output', staged], process.env);
renameSync(staged, installed);
console.log(`Built ${target.library} (${name}: ${target.triples.join(', ')}) bound to Godot API ${NATIVE_API.version}: ${installed}`);
