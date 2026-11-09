import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { before, test } from 'node:test';

// The built package as a consumer resolves it: `godot-tsc/host` through package.json's exports map, from a project with no `godot` module (Node).
// Builds dist/ first (scripts/build.mjs), so it checks what would ship.

const root = resolve(__dirname, '..');
const HOST_VALUES = ['REQUEST_DEADLINE_MS', 'RequestCancelled', 'RequestScope', 'Tsc', 'TscProject', 'parseTranspileResult', 'transpileResultOf', 'parseReply'];

let consumer = '';

before(() => {
  const built = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  consumer = mkdtempSync(join(tmpdir(), 'godot-tsc-consumer-'));
  const installed = join(consumer, 'node_modules', 'godot-tsc');
  mkdirSync(installed, { recursive: true });
  cpSync(join(root, 'package.json'), join(installed, 'package.json'));
  cpSync(join(root, 'dist'), join(installed, 'dist'), { recursive: true });
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
