// Builds the extension as a Web side module (wasm32-unknown-emscripten) for a Web profile (scripts/godot-api.mjs) into out/bin:
//
//   node scripts/build-web.mjs [--profile=stock|breaka]
//
//   stock   (the default) for stock Godot 4.7 Web templates. Needs Emscripten 4.0.11: EMSDK names the SDK (emsdk_env sets it; so does CI's setup-emsdk).
//   breaka  for Breaka's Godot 4.8 Web templates. Needs Breaka's Emscripten 6.0.12 SDK (EMSDK), the Binaryen its lazy function-table ABI is linked
//           with (BINARYEN_ROOT, BINARYEN_MANIFEST_SHA256) and the engine's own validator for it (GODOT_EMSCRIPTEN_HELPER, `platform/web/emscripten_helpers.py`
//           of Breaka's Godot source), run with SCONS_PYTHON (default python3).
//
// The recipe is a side module (`SIDE_MODULE=2`) with hidden symbols, a rebuilt standard library with atomics and pthreads, and `panic=abort` (the `wasm`
// cargo profile), which leaves it no landing pads for either kind of exception handling, so it needs none of Emscripten's.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { bindingEnvironment, OUT_BIN, parseArguments, root, WEB_PROFILES } from './godot-api.mjs';
import { vendor } from './vendor.mjs';

const args = parseArguments(process.argv.slice(2), { values: ['--profile'] });
const profileName = args.values['--profile'] ?? 'stock';
const profile = WEB_PROFILES[profileName];
if (profile === undefined) throw new Error(`Unknown Web profile ${profileName}: ${Object.keys(WEB_PROFILES).join(' or ')}`);
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`The ${profile.name} Web build needs ${name} (scripts/build-web.mjs says what each variable is).`);
  return value;
}

const sdk = required('EMSDK');
const cargo = process.env.CARGO ?? resolve(homedir(), '.cargo/bin/cargo');
const targetDirectory = resolve(root, 'target', `web-${profile.name}`);
// The SDK's own Node, whichever version it ships, for emcc.
const sdkNode = existsSync(join(sdk, 'node')) ? readdirSync(join(sdk, 'node')).map(name => join(sdk, 'node', name, 'bin')).filter(existsSync) : [];
const env = {
  ...process.env,
  ...bindingEnvironment(profile),
  PATH: [dirname(cargo), join(sdk, 'upstream', 'emscripten'), ...sdkNode, process.env.PATH ?? ''].join(delimiter),
  EM_CONFIG: process.env.EM_CONFIG ?? join(sdk, '.emscripten'),
  CARGO_TARGET_DIR: targetDirectory,
};
// Another SDK's Binaryen must not leak into a build that has none of its own to override.
if (!profile.lazyFunctionTable) delete env.EM_BINARYEN_ROOT;

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit', timeout: BUILD_TIMEOUT_MS, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? `exit ${result.status}`}`);
  return result.stdout;
}

/** The module's `breaka.lazy-table` custom sections: Breaka's lazy function-table ABI is recorded per module, and a stock module has none. */
function lazyTableSections(bytes) {
  return WebAssembly.Module.customSections(new WebAssembly.Module(bytes), 'breaka.lazy-table').length;
}

const flags = [
  '-C', 'link-args=-pthread', '-C', 'target-feature=+atomics', '-C', 'link-args=-sSIDE_MODULE=2',
  '-C', 'llvm-args=-enable-emscripten-cxx-exceptions=0', '-Z', 'default-visibility=hidden', '-Z', 'link-native-libraries=no',
  // Bun's crates are built as they come, with their lints reported and not enforced (.cargo/config.toml).
  '--cap-lints=warn',
];
if (profile.lazyFunctionTable) {
  // Breaka's lazy function-table ABI: the engine's own validator gives the link flags and the Binaryen to link with.
  const validate = `import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('godot_web_build_helpers',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Environment(dict):
    def Append(self, **items):
        for key, values in items.items(): self.setdefault(key, []).extend(values)
env=Environment(platform='web',ENV=dict(os.environ))
module.configure_binaryen_toolchain(env,sys.argv[2],sys.argv[3],role='side')
print(json.dumps({'binaryen':env['ENV']['EM_BINARYEN_ROOT'],'linkFlags':env['LINKFLAGS']}))
`;
  const python = process.env.SCONS_PYTHON ?? 'python3';
  const output = run(python, ['-c', validate, required('GODOT_EMSCRIPTEN_HELPER'), required('BINARYEN_ROOT'), required('BINARYEN_MANIFEST_SHA256')], {
    stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8',
  });
  const validation = JSON.parse(output);
  env.EM_BINARYEN_ROOT = validation.binaryen;
  flags.push(...validation.linkFlags.flatMap(flag => ['-C', `link-args=${flag}`]));
}
env.CARGO_ENCODED_RUSTFLAGS = flags.join('\x1f');
delete env.RUSTFLAGS;

if (!existsSync(resolve(root, 'vendor/bun/Cargo.toml'))) vendor();
console.log(`godot-tsc Web side module, ${profile.name} profile: Emscripten ${sdk}, target ${targetDirectory}`);
run(cargo, ['build', '--locked', '--profile', 'wasm', '-p', 'godot_tsc_ext', '--features', 'web', '-Zbuild-std=std,panic_abort', '--target', 'wasm32-unknown-emscripten']);
const built = join(targetDirectory, 'wasm32-unknown-emscripten', 'wasm', 'godot_tsc.wasm');
const bytes = readFileSync(built);
// The ABI the module was linked with must be the profile's: a lazy-table module in a stock page, or a plain one in Breaka's, fails at load.
if ((lazyTableSections(bytes) > 0) !== profile.lazyFunctionTable) {
  throw new Error(`The module has ${lazyTableSections(bytes)} breaka.lazy-table section(s), but the ${profile.name} profile's templates ${profile.lazyFunctionTable ? 'need' : 'do not take'} Breaka's lazy function-table ABI; it was not installed.`);
}
mkdirSync(OUT_BIN, { recursive: true });
const installed = resolve(OUT_BIN, profile.library);
const staged = `${installed}.${process.pid}.tmp`;
copyFileSync(built, staged);
renameSync(staged, installed);
console.log(`Built ${profile.library} (${profile.name} profile, ${bytes.length} bytes): ${installed}`);
