// Builds the native extension for this machine (or for `--target=<rust triple>`) into out/bin, where stage-addon.mjs packs it from:
//
//   node scripts/build-native.mjs [--target=<triple>] [--cli]
//
// It is bound to stock Godot 4.7.2's API (scripts/godot-api.mjs), so one build serves 4.7.2 and newer engines. `--cli` also builds
// `godot-tsc-cli`, a native process that answers the same requests framed on stdin and stdout (tests/compile.test.ts drives it).
// Bun's crates are extracted into vendor/ first when they are not there (scripts/vendor.mjs). The toolchain is rust-toolchain.toml's nightly.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { bindingEnvironment, NATIVE_API, NATIVE_LIBRARIES, OUT_BIN, parseArguments, root } from './godot-api.mjs';
import { vendor } from './vendor.mjs';

const args = parseArguments(process.argv.slice(2), { flags: ['--cli'], values: ['--target'] });
const target = args.values['--target'];
const cargo = process.env.CARGO ?? resolve(homedir(), '.cargo/bin/cargo');
const platform = target === undefined
  ? { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform]
  : target.includes('apple-darwin') ? 'macos' : target.includes('linux') ? 'linux' : target.includes('windows') ? 'windows' : undefined;
if (platform === undefined) throw new Error(`No Godot platform for ${target ?? process.platform}`);
const library = NATIVE_LIBRARIES[platform];
const env = { ...process.env, ...bindingEnvironment(NATIVE_API), PATH: `${resolve(homedir(), '.cargo/bin')}:${process.env.PATH ?? ''}` };

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(resolve(root, 'vendor/bun/Cargo.toml'))) vendor();
const targetArgs = target === undefined ? [] : ['--target', target];
// Two builds, not one with both packages: `--bin` selects the targets of every package named, and the extension (a library) would not be built.
run(cargo, ['build', '--locked', '--release', '-p', 'godot_tsc_ext', ...targetArgs]);
if (args.flags.has('--cli')) run(cargo, ['build', '--locked', '--release', '-p', 'godot_tsc_core', '--bin', 'godot-tsc-cli', ...targetArgs]);
const built = resolve(root, 'target', ...(target === undefined ? [] : [target]), 'release', library);
mkdirSync(OUT_BIN, { recursive: true });
// Staged and renamed, so a Godot that has the old library mapped keeps its inode.
const installed = resolve(OUT_BIN, library);
const staged = `${installed}.${process.pid}.tmp`;
copyFileSync(built, staged);
renameSync(staged, installed);
console.log(`Built ${library} bound to Godot API ${NATIVE_API.version}: ${installed}`);
