import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// The installer (bin/cli.mjs) run from a package laid out as npm installs it: package.json, bin/ and a staged addon/godot-tsc/. The addon here is a
// stand-in (a manifest and one file), so the test needs no build.

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

function installedPackage(): { readonly dir: string; readonly cli: string } {
  const dir = mkdtempSync(join(tmpdir(), 'godot-tsc-package-'));
  cpSync(resolve(root, 'bin'), join(dir, 'bin'), { recursive: true });
  cpSync(resolve(root, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, 'addon', 'godot-tsc', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'addon', 'godot-tsc', 'godot_tsc.gdextension'), '[configuration]\n');
  writeFileSync(join(dir, 'addon', 'godot-tsc', 'bin', 'libgodot_tsc.dylib'), 'stand-in');
  return { dir, cli: join(dir, 'bin', 'cli.mjs') };
}

function godotProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'godot-tsc-project-'));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'project.godot'), '; Godot Project Config\n');
  return dir;
}

test('--help prints usage and exits 0', () => {
  const result = spawnSync('node', [resolve(root, 'bin/cli.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /godot-tsc v\d+\.\d+\.\d+ CLI/u);
  assert.match(result.stdout, /godot-tsc setup/u);
});

test('an unknown command prints usage and exits 1', () => {
  const result = spawnSync('node', [resolve(root, 'bin/cli.mjs'), 'install'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage:/u);
});

test('setup without project.godot fails with exit 1', () => {
  const { dir, cli } = installedPackage();
  const empty = mkdtempSync(join(tmpdir(), 'godot-tsc-empty-'));
  try {
    const result = spawnSync('node', [cli, 'setup', '--project-dir', empty], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not locate 'project\.godot'/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('postinstall without project.godot exits 0 with a note', () => {
  const { dir, cli } = installedPackage();
  const empty = mkdtempSync(join(tmpdir(), 'godot-tsc-empty-'));
  try {
    const result = spawnSync('node', [cli, '--postinstall'], { encoding: 'utf8', env: { ...process.env, INIT_CWD: empty } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No project\.godot found/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('postinstall of a package without a staged addon (its own repository) does nothing', () => {
  const project = godotProject();
  try {
    const result = spawnSync('node', [resolve(root, 'bin/cli.mjs'), '--postinstall'], { encoding: 'utf8', env: { ...process.env, INIT_CWD: project } });
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(project, 'addons')), existsSync(resolve(root, 'addon/godot-tsc')));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('setup installs the addon, writes .version and node_modules/.gdignore, is idempotent, and replaces the addon whole when forced', () => {
  const { dir, cli } = installedPackage();
  const project = godotProject();
  try {
    const first = spawnSync('node', [cli, 'setup', '--project-dir', project], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Installed GDExtension/u);
    assert.match(first.stdout, /Created node_modules\/\.gdignore/u);
    const addon = join(project, 'addons', 'godot-tsc');
    assert.ok(existsSync(join(addon, 'godot_tsc.gdextension')));
    assert.ok(existsSync(join(addon, 'bin', 'libgodot_tsc.dylib')));
    assert.equal(readFileSync(join(addon, '.version'), 'utf8'), pkg.version);
    assert.ok(existsSync(join(project, 'node_modules', '.gdignore')));

    const second = spawnSync('node', [cli, 'setup', '--project-dir', project], { encoding: 'utf8' });
    assert.equal(second.status, 0);
    assert.match(second.stdout, /Addon is already up to date/u);

    writeFileSync(join(addon, 'bin', 'left-over.wasm'), 'from an older version');
    const forced = spawnSync('node', [cli, 'setup', '--project-dir', project, '--force'], { encoding: 'utf8' });
    assert.equal(forced.status, 0);
    assert.match(forced.stdout, /Installed GDExtension/u);
    assert.ok(!existsSync(join(addon, 'bin', 'left-over.wasm')), 'a file the package no longer ships does not stay behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
