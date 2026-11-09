// `cargo test` of the two crates, with the same toolchain and API binding the builds use (rustup's cargo first on PATH, so a rustc elsewhere on
// PATH, Homebrew's for one, is not the one cargo runs; and the 4.7.2 dumps set explicitly, as scripts/build-native.mjs sets them).
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { bindingEnvironment, NATIVE_API, parseArguments, root } from './godot-api.mjs';

parseArguments(process.argv.slice(2), {});
const cargo = process.env.CARGO ?? resolve(homedir(), '.cargo/bin/cargo');
const env = { ...process.env, ...bindingEnvironment(NATIVE_API), PATH: `${resolve(homedir(), '.cargo/bin')}:${process.env.PATH ?? ''}` };
const result = spawnSync(cargo, ['test', '--locked', '--release', '-p', 'live_compile_core', '-p', 'live_compile_ext'], { cwd: root, stdio: 'inherit', env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
