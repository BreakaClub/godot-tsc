// Stages the addon the package ships (addon/godot-tsc/) from the binaries in out/bin, and writes its manifest from what is there:
//
//   node scripts/stage-addon.mjs [--web-profile=stock] [--require-binaries] [--require-all-platforms]
//
//   addon/godot-tsc/godot_tsc.gdextension   lists each staged native library, and the Web side module of one profile (default stock)
//   addon/godot-tsc/bin/                    the binaries
//   addon/godot-tsc/build.json              each binary's SHA-256, the package version and the commit it was staged at
//   addon/godot-tsc/.version                the package version (bin/cli.mjs compares it before reinstalling)
//   addon/godot-tsc/LICENSE, THIRD_PARTY_NOTICES.md   the licenses, so a game exported with the addon carries them
//   libs/typescript_libs.bin                Bun's bundle of TypeScript's lib.*.d.ts (vendor/bun), for a project's libDir (README.md)
//
// build.json also records what each binary is bound to: the Godot API dumps' SHA-256 (natively, and per Web profile) and the Bun revision.
//
// A Web manifest names one side module for `web.*.threads.wasm32`, so it can serve one profile's templates: a module linked for another engine's
// Emscripten kills the page at load (scripts/godot-api.mjs). The manifest names the module of the profile `--web-profile` picks.
// `--require-binaries` (prepack) refuses to stage an addon without a native library, so a pack never ships an empty addon.
// `--require-all-platforms` (a release) refuses to stage one that lacks any platform's library, an architecture of the macOS one, or the Web module.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MACOS_LIBRARY, NATIVE_API, NATIVE_LIBRARY_NAMES, NATIVE_TARGETS, OUT_BIN, parseArguments, root, WEB_PROFILES } from './godot-api.mjs';

const ADDON_NAME = 'godot-tsc';
const MANIFEST_NAME = 'godot_tsc.gdextension';
const args = parseArguments(process.argv.slice(2), { flags: ['--require-binaries', '--require-all-platforms'], values: ['--web-profile'] });
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
for (const target of Object.values(NATIVE_TARGETS)) {
  if (staged.includes(target.library) || !existsSync(join(OUT_BIN, target.library))) continue;
  staged.push(target.library);
  // The macOS library has one architecture or both: the manifest lists the ones the file has.
  const features = target.library === MACOS_LIBRARY ? macosArchitectures(join(OUT_BIN, MACOS_LIBRARY)) : target.features;
  for (const feature of features) for (const mode of ['debug', 'release']) lines.push(`${target.platform}.${mode}.${feature} = "${resource(target.library)}"`);
}
if (args.flags.has('--require-binaries') && staged.length === 0) {
  throw new Error(`No native library in ${OUT_BIN}: run \`pnpm build:native\` (or put the release binaries there) before packing.`);
}
for (const profile of Object.values(WEB_PROFILES)) {
  if (!existsSync(join(OUT_BIN, profile.library))) continue;
  staged.push(profile.library);
  if (profile === webProfile) for (const mode of ['debug', 'release']) lines.push(`web.${mode}.threads.wasm32 = "${resource(profile.library)}"`);
}
if (args.flags.has('--require-all-platforms')) {
  const universal = NATIVE_TARGETS['macos.universal'].triples.length;
  const missing = [
    ...NATIVE_LIBRARY_NAMES.filter(library => !staged.includes(library)),
    ...(staged.includes(webProfile.library) ? [] : [webProfile.library]),
    ...(lines.filter(line => line.startsWith('macos.release.')).length === universal ? [] : [`${MACOS_LIBRARY} with ${universal} architectures`]),
  ];
  if (missing.length > 0) throw new Error(`Not every platform's binary is in ${OUT_BIN}. Missing: ${missing.join(', ')}.`);
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
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const binding = api => ({ extensionApiSha256: sha256(api.extensionApi), gdextensionInterfaceSha256: sha256(api.gdextensionInterface) });
const bunRevision = /^REVISION = "([0-9a-f]{40})"$/mu.exec(readFileSync(resolve(root, 'scripts/vendor-bun.py'), 'utf8'))?.[1] ?? null;
const webModules = Object.fromEntries(Object.values(WEB_PROFILES).filter(profile => staged.includes(profile.library))
  .map(profile => [profile.library, { profile: profile.name, binding: binding(profile) }]));

// Bun's lib bundle, beside the addon (not in it: Godot has no use for it).
const libBundle = resolve(root, 'vendor/bun/typescript_libs.bin');
if (!existsSync(libBundle)) throw new Error(`${libBundle} is missing: run \`pnpm vendor\`.`);
mkdirSync(resolve(root, 'libs'), { recursive: true });
copyFileSync(libBundle, resolve(root, 'libs/typescript_libs.bin'));

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
writeFileSync(join(destination, 'build.json'), `${JSON.stringify({
  version: pkg.version, commit: head.status === 0 ? head.stdout.trim() : null, dirty: dirty.status === 0 ? dirty.stdout.trim() !== '' : null,
  webProfile: existsSync(join(OUT_BIN, webProfile.library)) ? webProfile.name : null, bunRevision,
  nativeApi: { version: NATIVE_API.version, ...binding(NATIVE_API) }, webModules, binaries: hashes,
}, null, 2)}\n`);
writeFileSync(join(destination, '.version'), pkg.version);
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) copyFileSync(resolve(root, name), join(destination, name));
console.log(`[stage-addon] Staged ${ADDON_NAME} v${pkg.version} with ${staged.length} binary file(s) (${staged.join(', ') || 'none'}) into ${destination}`);
