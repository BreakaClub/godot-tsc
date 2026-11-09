// `cargo test` of the two crates, with the same toolchain and API binding the builds use (rust-toolchain.toml's toolchain first on PATH, so a
// rustc elsewhere on PATH, Homebrew's for one, is not the one cargo runs; and the 4.7.2 dumps set explicitly, as scripts/build-native.mjs sets them).
import { spawnSync } from 'node:child_process';
import { bindingEnvironment, NATIVE_API, parseArguments, root, rustToolchain, withToolchainPath } from './godot-api.mjs';

parseArguments(process.argv.slice(2), {});
const toolchain = rustToolchain();
const env = withToolchainPath(toolchain, { ...process.env, ...bindingEnvironment(NATIVE_API) });
const result = spawnSync(toolchain.cargo, ['test', '--locked', '--release', '-p', 'godot_tsc_core', '-p', 'godot_tsc_ext'], { cwd: root, stdio: 'inherit', env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
