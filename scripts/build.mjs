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
const shared = { absWorkingDir: root, bundle: true, platform: 'neutral', target: 'es2022', sourcemap: true, external };

/**
 * `index` (and `godot.ts`, which it bundles) import `host` as the module it is (`./host.js`, `./host.mjs`), not a copy of it: one realm loading both entries then has one
 * `RequestCancelled` and one `Tsc`, so `instanceof` holds across them. `host` itself imports no `godot` module.
 */
function hostAsModule(extension) {
  return {
    name: 'host-as-module',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/host$/ }, () => ({ path: `./host${extension}`, external: true }));
    },
  };
}

for (const [format, extension] of [['cjs', '.js'], ['esm', '.mjs']]) {
  await build({ ...shared, format, entryPoints: ['src/host.ts'], outfile: `dist/host${extension}` });
  await build({ ...shared, format, entryPoints: ['src/index.ts'], outfile: `dist/index${extension}`, plugins: [hostAsModule(extension)] });
}
const types = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.package.json'], { cwd: root, stdio: 'inherit' });
if (types.error) throw types.error;
if (types.status !== 0) process.exit(types.status ?? 1);
