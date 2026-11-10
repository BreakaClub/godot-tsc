// Runs the package in a GodotJS project with camel-cased bindings on, then off (tests/bindings/): the package reaches the engine through
// `godot.lib.api` (src/godot.ts), so it must work under both. Each run also times a call through that module against a direct one.
//
//   node scripts/verify-bindings.mjs
//
// Needs what the demo needs: the native library in out/bin (`pnpm build:native`) and a Godot 4.7+ with GodotJS on V8 as `GODOT` or `godot`.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ES2022_LIB_ROOTS, libClosure, readLibBundle } from '../node/lib-bundle.mjs';
import { root } from './godot-api.mjs';

const godot = process.env.GODOT ?? 'godot';
const project = join(root, 'tests/bindings');
const LIB_BUNDLES = [join(root, 'libs/typescript_libs.bin'), join(root, 'vendor/bun/typescript_libs.bin')];
const EDITOR_TIMEOUT_MS = 120_000;
/** The project's own deadline is 20 s (tests/bindings/src/main.ts). */
const RUN_TIMEOUT_MS = 60_000;
const VERIFIED = 'godot-tsc bindings verified:';

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status ?? result.signal}`);
}

const bundle = LIB_BUNDLES.find(file => existsSync(file));
if (!bundle) throw new Error(`No typescript_libs.bin (${LIB_BUNDLES.join(', ')}): run "pnpm vendor" and "pnpm stage:addon"`);
mkdirSync(join(project, 'tsc'), { recursive: true });
writeFileSync(join(project, 'tsc/libs.json'), JSON.stringify([...libClosure(readLibBundle(bundle), ES2022_LIB_ROOTS)].map(([name, text]) => ({ name, text }))));

await build({
  absWorkingDir: root,
  entryPoints: ['tests/bindings/src/main.ts'],
  outdir: 'tests/bindings/.godot/GodotJS/src',
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  format: 'cjs',
  external: ['godot', 'godot.lib.api', 'godot.annotations', 'godot-jsb'],
  alias: { 'godot-tsc': join(root, 'src/index.ts') },
});

run(process.execPath, ['scripts/stage-addon.mjs']);

for (const camelCase of [true, false]) {
  writeFileSync(join(project, 'project.godot'), `; Written by scripts/verify-bindings.mjs, once for each setting of the bindings' names.

config_version=5

[application]

config/name="godot-tsc bindings"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.7", "GL Compatibility")

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"

[GodotJS]

runtime/core/camel_case_bindings_enabled=${camelCase}
`);
  run(process.execPath, ['bin/cli.mjs', 'setup', '--project-dir', project, '--force']);
  run(godot, ['--headless', '--audio-driver', 'Dummy', '--editor', '--import', '--path', project], { timeout: EDITOR_TIMEOUT_MS });
  const result = spawnSync(godot, ['--headless', '--audio-driver', 'Dummy', '--path', project], { cwd: root, encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
  if (result.error) throw result.error;
  const verified = result.stdout.split('\n').find(line => line.includes(VERIFIED));
  if (result.status !== 0 || !verified) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    console.error(`The package did not verify with camel_case_bindings_enabled=${camelCase} (exit ${result.status ?? result.signal})`);
    process.exit(1);
  }
  console.log(`\ncamel_case_bindings_enabled=${camelCase}: ${verified.slice(verified.indexOf(VERIFIED) + VERIFIED.length).trim()}\n`);
}
