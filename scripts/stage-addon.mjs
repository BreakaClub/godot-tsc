// Stages the addon the package ships (addon/godot-tsc/) from the binaries in out/bin, and writes its manifest from what is there:
//
//   node scripts/stage-addon.mjs [--web-profile=stock|breaka] [--require-binaries]
//
//   addon/godot-tsc/godot_tsc.gdextension   lists each staged native library, and the Web side module of one profile (default stock)
//   addon/godot-tsc/bin/                    the binaries
//   addon/godot-tsc/build.json              each binary's SHA-256, the package version and the commit it was staged at
//   addon/godot-tsc/.version                the package version (bin/cli.mjs compares it before reinstalling)
//
// A Web manifest names one side module for `web.*.threads.wasm32`, so it can serve one profile's templates: a module linked for another engine's
// Emscripten kills the page at load (scripts/godot-api.mjs). Both profiles' modules may be staged; the manifest names the one `--web-profile` picks.
// `--require-binaries` (prepack) refuses to stage an addon without a native library, so a pack never ships an empty addon.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NATIVE_LIBRARIES, OUT_BIN, parseArguments, root, WEB_PROFILES } from './godot-api.mjs';

const ADDON_NAME = 'godot-tsc';
const MANIFEST_NAME = 'godot_tsc.gdextension';
const args = parseArguments(process.argv.slice(2), { flags: ['--require-binaries'], values: ['--web-profile'] });
const webProfileName = args.values['--web-profile'] ?? 'stock';
const webProfile = WEB_PROFILES[webProfileName];
if (webProfile === undefined) throw new Error(`Unknown Web profile ${webProfileName}: ${Object.keys(WEB_PROFILES).join(' or ')}`);
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const destination = resolve(root, 'addon', ADDON_NAME);
const resource = name => `res://addons/${ADDON_NAME}/bin/${name}`;

/** The architectures of a macOS library (`lipo -archs`): arm64, x86_64 or both for a universal one. */
function macosArchitectures(path) {
  const result = spawnSync('lipo', ['-archs', path], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`lipo -archs ${path} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim().split(/\s+/u);
}

const staged = [];
const lines = [];
const macos = join(OUT_BIN, NATIVE_LIBRARIES.macos);
if (existsSync(macos)) {
  staged.push(NATIVE_LIBRARIES.macos);
  for (const arch of macosArchitectures(macos)) for (const mode of ['debug', 'release']) lines.push(`macos.${mode}.${arch} = "${resource(NATIVE_LIBRARIES.macos)}"`);
}
if (existsSync(join(OUT_BIN, NATIVE_LIBRARIES.linux))) {
  staged.push(NATIVE_LIBRARIES.linux);
  for (const mode of ['debug', 'release']) lines.push(`linux.${mode}.x86_64 = "${resource(NATIVE_LIBRARIES.linux)}"`);
}
if (existsSync(join(OUT_BIN, NATIVE_LIBRARIES.windows))) {
  staged.push(NATIVE_LIBRARIES.windows);
  for (const mode of ['debug', 'release']) lines.push(`windows.${mode}.x86_64 = "${resource(NATIVE_LIBRARIES.windows)}"`);
}
if (args.flags.has('--require-binaries') && staged.length === 0) {
  throw new Error(`No native library in ${OUT_BIN}: run \`pnpm build:native\` (or put the release binaries there) before packing.`);
}
for (const profile of Object.values(WEB_PROFILES)) {
  if (!existsSync(join(OUT_BIN, profile.library))) continue;
  staged.push(profile.library);
  if (profile === webProfile) for (const mode of ['debug', 'release']) lines.push(`web.${mode}.threads.wasm32 = "${resource(profile.library)}"`);
}
if (args.values['--web-profile'] !== undefined && !existsSync(join(OUT_BIN, webProfile.library))) {
  throw new Error(`--web-profile=${webProfile.name} asks for ${webProfile.library}, which is not in ${OUT_BIN}: run \`pnpm build:web --profile=${webProfile.name}\`.`);
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(join(destination, 'bin'), { recursive: true });
const hashes = {};
for (const name of staged) {
  copyFileSync(join(OUT_BIN, name), join(destination, 'bin', name));
  hashes[name] = createHash('sha256').update(readFileSync(join(OUT_BIN, name))).digest('hex');
}
writeFileSync(join(destination, MANIFEST_NAME), `[configuration]
entry_symbol = "gdext_rust_init"
compatibility_minimum = "4.7"
reloadable = false

[libraries]
${lines.join('\n')}
`);
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
writeFileSync(join(destination, 'build.json'), `${JSON.stringify({
  version: pkg.version, commit: head.status === 0 ? head.stdout.trim() : null, dirty: dirty.status === 0 ? dirty.stdout.trim() !== '' : null,
  webProfile: existsSync(join(OUT_BIN, webProfile.library)) ? webProfile.name : null, binaries: hashes,
}, null, 2)}\n`);
writeFileSync(join(destination, '.version'), pkg.version);
console.log(`[stage-addon] Staged ${ADDON_NAME} v${pkg.version} with ${staged.length} binary file(s) (${staged.join(', ') || 'none'}) into ${destination}`);
