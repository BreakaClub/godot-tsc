import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { before, test } from 'node:test';

// The built package as a consumer resolves it: `godot-tsc/host` through package.json's exports map, from a project with no `godot` module (Node).
// Builds dist/ first (scripts/build.mjs), so it checks what would ship.

const root = resolve(__dirname, '..');
const HOST_VALUES = ['REQUEST_DEADLINE_MS', 'RequestCancelled', 'RequestScope', 'Tsc', 'TscProject', 'parseTranspileResult', 'transpileResultOf', 'parseReply'];

const LIB_BUNDLE = [join(root, 'libs/typescript_libs.bin'), join(root, 'vendor/bun/typescript_libs.bin')].find(file => existsSync(file));

let consumer = '';

before(() => {
  const built = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  consumer = mkdtempSync(join(tmpdir(), 'godot-tsc-consumer-'));
  const installed = join(consumer, 'node_modules', 'godot-tsc');
  mkdirSync(installed, { recursive: true });
  cpSync(join(root, 'package.json'), join(installed, 'package.json'));
  cpSync(join(root, 'dist'), join(installed, 'dist'), { recursive: true });
  cpSync(join(root, 'node'), join(installed, 'node'), { recursive: true });
  // The lib bundle the package ships (libs/, staged from vendor/bun), or vendor/bun's where nothing is staged yet (CI's native job).
  if (LIB_BUNDLE !== undefined) {
    mkdirSync(join(installed, 'libs'));
    cpSync(LIB_BUNDLE, join(installed, 'libs', 'typescript_libs.bin'));
  }
  writeFileSync(join(consumer, 'package.json'), '{ "name": "consumer", "private": true }\n');
});

function node(script: string, type: 'commonjs' | 'module'): { status: number | null; stdout: string; stderr: string } {
  const file = join(consumer, type === 'module' ? 'probe.mjs' : 'probe.cjs');
  writeFileSync(file, script);
  try {
    return spawnSync(process.execPath, [file], { cwd: consumer, encoding: 'utf8' });
  } finally {
    rmSync(file, { force: true });
  }
}

test('godot-tsc/host loads under Node through require, with no godot module, and has every value but openTsc', () => {
  const result = node(`const host = require('godot-tsc/host'); console.log(JSON.stringify(Object.keys(host).sort()));`, 'commonjs');
  assert.equal(result.status, 0, result.stderr);
  const names: string[] = JSON.parse(result.stdout);
  for (const name of HOST_VALUES) assert.ok(names.includes(name), `godot-tsc/host lacks ${name}`);
  assert.ok(!names.includes('openTsc'));
});

test('godot-tsc/host loads under Node through import, and a request cancelled there is a RequestCancelled', () => {
  const result = node(`
    import { RequestCancelled, RequestScope } from 'godot-tsc/host';
    const scope = new RequestScope();
    scope.cancel();
    try { scope.onCancel(() => {}); } catch (error) { console.log(error instanceof RequestCancelled); }
  `, 'module');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'true');
});

test('the godot-tsc entry needs the godot module, and shares the host module rather than copying it', () => {
  const result = node(`try { require('godot-tsc'); } catch (error) { console.log(error.code, error.message.split('\\n')[0]); }`, 'commonjs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MODULE_NOT_FOUND Cannot find module 'godot'/u);
  // With a stand-in for the engine's module, both entries give the same classes.
  mkdirSync(join(consumer, 'node_modules', 'godot'), { recursive: true });
  writeFileSync(join(consumer, 'node_modules', 'godot', 'index.js'), 'module.exports = {};\n');
  try {
    const shared = node(`const main = require('godot-tsc'); const host = require('godot-tsc/host');
      console.log(main.Tsc === host.Tsc && main.RequestCancelled === host.RequestCancelled && typeof main.openTsc);`, 'commonjs');
    assert.equal(shared.status, 0, shared.stderr);
    assert.equal(shared.stdout.trim(), 'function'); // false when either class differs
  } finally {
    rmSync(join(consumer, 'node_modules', 'godot'), { recursive: true, force: true });
  }
});

// TypeScript resolves the package's types the way each consumer's `moduleResolution` does: `node` (node10) ignores the exports map, so
// `godot-tsc/host` reaches its declarations through `typesVersions`; `node16` and `bundler` read the exports map.
for (const [moduleResolution, module] of [['node', 'commonjs'], ['node16', 'node16'], ['bundler', 'esnext']] as const) {
  test(`TypeScript finds both entries' types under moduleResolution ${moduleResolution}`, () => {
    const project = join(consumer, `types-${moduleResolution}`);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module, moduleResolution, target: 'es2022', strict: true, noEmit: true, skipLibCheck: true, types: [] },
      files: ['probe.ts', 'godot.d.ts'],
    }));
    // The main entry's declarations name the engine's module: a stand-in for what a GodotJS project's typings declare.
    writeFileSync(join(project, 'godot.d.ts'), `declare module 'godot' {
  export class RefCounted {}
  export class PackedStringArray { constructor(items?: string[]); }
  export const ClassDB: { classExists(name: string): boolean };
}
`);
    writeFileSync(join(project, 'probe.ts'), `import { RequestScope, Tsc, parseTranspileResult, type TranspileResult } from 'godot-tsc/host';
import { openTsc, Tsc as MainTsc } from 'godot-tsc';
const scope: RequestScope = new RequestScope();
const parsed: TranspileResult = parseTranspileResult('{}');
const same: typeof Tsc = MainTsc;
const open: () => Tsc = openTsc;
// A wrong use is an error, so the types are the package's and not \`any\`.
// @ts-expect-error
const wrong: string = scope;
export { parsed, same, open, wrong };
`);
    const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', project], { cwd: project, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test('godot-tsc/lib-bundle reads the shipped lib files, and the ES2022 closure is what a check of ES2022 code needs', { skip: LIB_BUNDLE === undefined ? 'no typescript_libs.bin: "pnpm vendor" extracts it' : false }, () => {
  const result = node(`
    import { createRequire } from 'node:module';
    import { ES2022_LIB_ROOTS, libClosure, readLibBundle } from 'godot-tsc/lib-bundle';
    const all = readLibBundle(createRequire(import.meta.url).resolve('godot-tsc/typescript_libs.bin'));
    const needed = libClosure(all, ES2022_LIB_ROOTS);
    console.log(JSON.stringify({ all: all.size, needed: needed.size, es5: needed.get('lib.es5.d.ts')?.includes('interface Array<T>') }));
  `, 'module');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { all: 108, needed: 57, es5: true });
});
