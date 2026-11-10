// Loads the staged addon in a stock Godot, one without GodotJS, and has it compile a source (tests/stock/main.gd):
//
//   GODOT=<a Godot 4.7.2 or newer> node scripts/verify-load.mjs [--arch=<arch>]
//
// It is the check that a platform's library loads and runs where it is meant to: release and CI builds run it on each desktop system with the
// official 4.7.2 editor. The addon is the one stage-addon.mjs stages from out/bin, installed as the package's installer does.
// `--arch` runs the engine as another architecture of a universal macOS build (`arch -<arch>`: x86_64 under Rosetta), to load that slice.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArguments, root } from './godot-api.mjs';

const args = parseArguments(process.argv.slice(2), { values: ['--arch'] });
const godot = process.env.GODOT ?? 'godot';
const project = join(root, 'tests/stock');
const MANIFEST = 'res://addons/godot-tsc/godot_tsc.gdextension';
/** The project's own deadline is 20 s (tests/stock/main.gd). */
const RUN_TIMEOUT_MS = 60_000;
/**
 * Under Rosetta the engine is translated before it starts, and it prints nothing until that is done: 26 s on a GitHub runner in one run,
 * more than RUN_TIMEOUT_MS in another.
 */
const TRANSLATED_RUN_TIMEOUT_MS = 300_000;
const VERIFIED = 'godot-tsc loaded:';
const arch = args.values['--arch'];

function engine(engineArgs, timeout) {
  const [command, ...commandArgs] = [...(arch === undefined ? [] : ['arch', `-${arch}`]), godot, '--headless', '--audio-driver', 'Dummy', '--path', project, ...engineArgs];
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8', timeout });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result;
}

const stage = spawnSync(process.execPath, ['scripts/stage-addon.mjs', '--require-binaries'], { cwd: root, stdio: 'inherit' });
if (stage.status !== 0) process.exit(stage.status ?? 1);
for (const generated of ['addons', '.godot']) rmSync(join(project, generated), { recursive: true, force: true });
cpSync(join(root, 'addon/godot-tsc'), join(project, 'addons/godot-tsc'), { recursive: true });

// What an editor's first scan records, and what makes a run load the extension. Written here, not by `--import`: a headless import that finds
// a new extension queues EditorHelp::_gen_extensions_docs, which Main::cleanup flushes after the documentation is freed, and Godot 4.7.2
// crashes on the way out (in DocTools::generate, with any extension).
mkdirSync(join(project, '.godot'), { recursive: true });
writeFileSync(join(project, '.godot/extension_list.cfg'), `${MANIFEST}\n`);
const run = engine(['--script', 'res://main.gd'], arch === undefined ? RUN_TIMEOUT_MS : TRANSLATED_RUN_TIMEOUT_MS);
const verified = run.stdout.split('\n').find(line => line.includes(VERIFIED));
if (run.status !== 0 || !verified) {
  console.error(`The extension did not load and compile in ${godot} (exit ${run.status ?? run.signal})`);
  process.exit(1);
}
console.log(`\n${verified.slice(verified.indexOf(VERIFIED)).trim()}`);
