#!/usr/bin/env node
// Installs the packaged addon (addon/godot-tsc/) into a Godot project at res://addons/godot-tsc/. It runs as the package's postinstall, and as
// `godot-tsc setup`.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADDON_NAME = 'godot-tsc';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ADDON_DIR = join(PACKAGE_ROOT, 'addon', ADDON_NAME);
const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

/** The nearest directory at or above `startDir` that holds project.godot, or null. */
function findGodotRoot(startDir) {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, 'project.godot'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Writes node_modules/.gdignore if node_modules exists without one: Godot must not import npm's tree. Returns whether it wrote it. */
function ensureGdignore(godotRoot) {
  const nodeModulesDir = join(godotRoot, 'node_modules');
  if (!existsSync(nodeModulesDir)) return false;
  const gdignorePath = join(nodeModulesDir, '.gdignore');
  if (existsSync(gdignorePath)) return false;
  writeFileSync(gdignorePath, '');
  return true;
}

function printHelp() {
  console.log(`
${ADDON_NAME} v${pkg.version} CLI

Usage:
  ${ADDON_NAME} setup [options]     Install or update the GDExtension in your Godot project (res://addons/${ADDON_NAME}/)

Options:
  --project-dir <path>  Path to the Godot project directory (defaults to searching upwards)
  --force               Reinstall addon files even if the version matches
  --help, -h            Show this help message
`);
}

// Failure sets `process.exitCode` and returns, so Node exits once stderr is written: `process.exit` straight after `console.error`
// crashes Node 24.7.0 itself (SIGSEGV in roughly one run in ten), and 24.15.0 does not.
function run() {
  const args = process.argv.slice(2);
  const isPostinstall = args.includes('--postinstall');
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (!isPostinstall && args[0] !== 'setup') {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const dirArgIndex = args.indexOf('--project-dir');
  const customDir = dirArgIndex === -1 ? null : args[dirArgIndex + 1];
  if (dirArgIndex !== -1 && (customDir === undefined || customDir.startsWith('--'))) {
    console.error(`[${ADDON_NAME}] Error: --project-dir needs a path`);
    process.exitCode = 1;
    return;
  }
  // npm, pnpm and yarn set INIT_CWD to the directory the user ran the install in.
  const searchStart = customDir ?? process.env.INIT_CWD ?? process.cwd();

  // The package's own repository: nothing to install into.
  if (isPostinstall && resolve(searchStart) === PACKAGE_ROOT) return;

  if (!existsSync(SOURCE_ADDON_DIR)) {
    if (isPostinstall) return;
    console.error(`[${ADDON_NAME}] Error: Prebuilt addon directory not found at ${SOURCE_ADDON_DIR}`);
    process.exitCode = 1;
    return;
  }

  const godotRoot = findGodotRoot(searchStart);
  if (!godotRoot) {
    if (isPostinstall) {
      console.log(`[${ADDON_NAME}] Note: No project.godot found near ${searchStart}. Run 'pnpm exec ${ADDON_NAME} setup' in your Godot project root to install the extension.`);
      return;
    }
    console.error(`[${ADDON_NAME}] Error: Could not locate 'project.godot' ascending from: ${searchStart}`);
    console.error('Please run the command from inside your Godot project directory or specify --project-dir <path>.');
    process.exitCode = 1;
    return;
  }

  const targetAddonDir = join(godotRoot, 'addons', ADDON_NAME);
  const stampFile = join(targetAddonDir, '.version');
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === pkg.version && !args.includes('--force')) {
    if (!isPostinstall) console.log(`[${ADDON_NAME}] Addon is already up to date (v${pkg.version}) at res://addons/${ADDON_NAME}/`);
    return;
  }

  // The addon is the package's: replaced whole, so a binary a newer version no longer ships does not stay behind (Godot would keep loading what the manifest
  // names, and an old manifest could name it). The .uid files Godot writes beside them are regenerated on import.
  rmSync(targetAddonDir, { recursive: true, force: true });
  mkdirSync(targetAddonDir, { recursive: true });
  cpSync(SOURCE_ADDON_DIR, targetAddonDir, { recursive: true, force: true });
  writeFileSync(stampFile, pkg.version, 'utf8');
  const createdGdignore = ensureGdignore(godotRoot);

  console.log(`✓ [${ADDON_NAME}] Installed GDExtension v${pkg.version} to res://addons/${ADDON_NAME}/`);
  if (createdGdignore) console.log(`✓ [${ADDON_NAME}] Created node_modules/.gdignore (prevents Godot editor hang)`);
}

run();
