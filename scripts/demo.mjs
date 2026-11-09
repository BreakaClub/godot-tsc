// Builds and runs the demo (demo/): a TypeScript editor whose checking, transpiling, hover and inlay hints come from the godot-tsc
// extension, installed into the demo the way a project installs the package.
//
//   node scripts/demo.mjs [--verify | --capture=<png>]
//
// It stages the addon from out/bin (`pnpm build:native` first) and installs it with the package's own installer (`godot-tsc setup`),
// writes the lib files the checker reads (demo/tsc/libs.json, from the shipped typescript_libs.bin), has the editor write GodotJS's
// typings for the engine (once; without the extension loaded, since the package declares `GodotTsc` itself), type-checks and bundles
// demo/src, and lets the editor import the project. Then it opens the demo, or with `--verify` runs it headless: the demo checks every
// answer itself (demo/src/main.ts) and this script fails unless it says so. `--capture=<png>` opens it in a window, saves the window's
// raster once the sample is checked and quits.
//
// The demo needs a Godot with GodotJS (V8) and its camel-cased bindings: `GODOT` names the binary (Breaka's Godot 4.8 by default).
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { libClosure, readLibBundle } from './lib-bundle.mjs';
import { NATIVE_LIBRARIES, OUT_BIN, parseArguments, root } from './godot-api.mjs';

const args = parseArguments(process.argv.slice(2), { flags: ['--verify'], values: ['--capture'] });
const verify = args.flags.has('--verify');
const capture = args.values['--capture'];
if (verify && capture !== undefined) throw new Error('Pass --verify or --capture, not both');

const DEFAULT_GODOT = '/Applications/Godot48.app/Contents/MacOS/Godot';
const godot = process.env.GODOT ?? DEFAULT_GODOT;
if (!existsSync(godot)) throw new Error(`No Godot at ${godot}: set GODOT to a Godot with GodotJS (V8)`);

const demo = join(root, 'demo');
const addons = join(demo, 'addons');
const typings = join(demo, 'typings');
const LIB_ROOTS = ['lib.es2022.d.ts', 'lib.decorators.d.ts', 'lib.decorators.legacy.d.ts'];
const LIB_BUNDLES = [join(root, 'libs/typescript_libs.bin'), join(root, 'vendor/bun/typescript_libs.bin')];
/** An import or a typings run of a project this size takes seconds; a minute is a hang. */
const EDITOR_TIMEOUT_MS = 120_000;
/** The demo's own deadline is 20 s (VERIFY_DEADLINE_MS in demo/src/main.ts); this one catches an engine that never gets that far. */
const VERIFY_TIMEOUT_MS = 60_000;
const VERIFIED = 'godot-tsc demo verified:';

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status ?? result.signal}`);
  return result;
}

function editor(extraArgs) {
  run(godot, ['--headless', '--audio-driver', 'Dummy', '--editor', ...extraArgs, '--path', demo], { timeout: EDITOR_TIMEOUT_MS });
}

// demo/src, bundled where GodotJS reads res://src/*.ts from (first: the editor's typings run loads the scene's script).
await build({
  absWorkingDir: root,
  entryPoints: ['demo/src/main.ts'],
  outdir: 'demo/.godot/GodotJS/src',
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  format: 'cjs',
  sourcemap: true,
  external: ['godot', 'godot.lib.api', 'godot.annotations', 'godot-jsb'],
  alias: { 'godot-tsc': join(root, 'src/index.ts') },
});

// GodotJS's typings for this engine. The editor writes them with whatever extensions it loads, and the package declares `GodotTsc` into
// the `godot` module itself (src/godot.ts), so they are written with the addon out of the project: two declarations of one class do not
// merge.
if (!existsSync(typings)) {
  const aside = join(root, '.cache/demo-addons');
  rmSync(aside, { recursive: true, force: true });
  if (existsSync(addons)) {
    mkdirSync(join(root, '.cache'), { recursive: true });
    renameSync(addons, aside);
  }
  // The editor's list of extensions would load it from where it was.
  rmSync(join(demo, '.godot/extension_list.cfg'), { force: true });
  try {
    editor(['--generate-types']);
  } finally {
    if (existsSync(aside)) renameSync(aside, addons);
  }
  if (!existsSync(typings)) throw new Error(`${godot} --generate-types wrote no ${typings}`);
}

// The addon, staged from out/bin and installed by the package's installer.
if (!existsSync(join(OUT_BIN, NATIVE_LIBRARIES.macos)) && !existsSync(join(OUT_BIN, NATIVE_LIBRARIES.linux)) && !existsSync(join(OUT_BIN, NATIVE_LIBRARIES.windows))) {
  throw new Error(`No native library in ${OUT_BIN}: run "pnpm build:native" first`);
}
run(process.execPath, ['scripts/stage-addon.mjs']);
run(process.execPath, ['bin/cli.mjs', 'setup', '--project-dir', demo, '--force']);

// The lib files the checker reads: ES2022 and the decorators, and what they reference.
const bundle = LIB_BUNDLES.find(file => existsSync(file));
if (!bundle) throw new Error(`No typescript_libs.bin (${LIB_BUNDLES.join(', ')}): run "pnpm vendor" and "pnpm stage:addon"`);
const libs = libClosure(readLibBundle(bundle), LIB_ROOTS);
mkdirSync(join(demo, 'tsc'), { recursive: true });
writeFileSync(join(demo, 'tsc/libs.json'), JSON.stringify([...libs].map(([name, text]) => ({ name, text }))));

// demo/src, checked against the engine's typings and the package's source.
run(join(root, 'node_modules/.bin/tsc'), ['-p', join(demo, 'tsconfig.json')]);

editor(['--import']);

if (capture !== undefined) {
  run(godot, ['--audio-driver', 'Dummy', '--path', demo, '--', `--capture=${resolve(capture)}`], { timeout: VERIFY_TIMEOUT_MS });
} else if (!verify) {
  run(godot, ['--audio-driver', 'Dummy', '--path', demo]);
} else {
  const result = spawnSync(godot, ['--headless', '--audio-driver', 'Dummy', '--path', demo, '--', '--verify'], {
    cwd: root, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const verified = result.stdout.split('\n').find(line => line.includes(VERIFIED));
  if (result.status !== 0 || !verified) {
    console.error(`The demo did not verify (exit ${result.status ?? result.signal})`);
    process.exit(1);
  }
  console.log(`\n${verified.slice(verified.indexOf(VERIFIED))}`);
}
