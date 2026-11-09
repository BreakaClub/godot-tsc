// The package's JavaScript: CommonJS (what GodotJS loads) and ES modules, plus declarations, into dist/.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Written from nothing, so a module that no longer exists does not ship its old declarations.
rmSync(resolve(root, 'dist'), { recursive: true, force: true });
// GodotJS's modules are the engine's, never bundled.
const external = ['godot', 'godot.lib.api', 'godot.annotations', 'godot-jsb'];
const shared = { absWorkingDir: root, bundle: true, platform: 'neutral', target: 'es2022', sourcemap: true, entryPoints: ['src/index.ts'], external };
await build({ ...shared, format: 'cjs', outfile: 'dist/index.js' });
await build({ ...shared, format: 'esm', outfile: 'dist/index.mjs' });
const types = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.package.json'], { cwd: root, stdio: 'inherit' });
if (types.error) throw types.error;
if (types.status !== 0) process.exit(types.status ?? 1);
