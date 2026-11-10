// Writes vendor/bun, the pinned extraction of Bun's crates (scripts/vendor-bun.py), from a Bun checkout at the pinned revision.
//
//   node scripts/vendor.mjs [--bun=<path or URL>] [--verify]
//
// The source is `--bun`, else BUN_SOURCE, else https://github.com/oven-sh/bun.git. A local checkout that is already at the revision is read as it is
// (only read). Anything else (a URL, or a checkout at another revision) is fetched into .cache/bun at that one commit, with no working tree: the
// extraction reads objects with `git show`, never files.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArguments, root } from './godot-api.mjs';

const DEFAULT_SOURCE = 'https://github.com/oven-sh/bun.git';
const REVISION = /^REVISION = "([0-9a-f]{40})"$/mu.exec(readFileSync(resolve(root, 'scripts/vendor-bun.py'), 'utf8'))?.[1];
if (REVISION === undefined) throw new Error('scripts/vendor-bun.py names no REVISION');

function git(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
  if (result.error) throw result.error;
  return result;
}

/** A Bun checkout at REVISION: the source itself when it is a local one at the revision, else .cache/bun fetched at it. */
export function bunCheckout(source = process.env.BUN_SOURCE ?? DEFAULT_SOURCE) {
  if (existsSync(source) && git(['-C', source, 'rev-parse', 'HEAD']).stdout.trim() === REVISION) return resolve(source);
  const cache = resolve(root, '.cache/bun');
  if (!existsSync(resolve(cache, 'HEAD'))) {
    mkdirSync(cache, { recursive: true });
    if (git(['init', '-q', '--bare', cache]).status !== 0) throw new Error(`git init ${cache} failed`);
  }
  if (git(['-C', cache, 'rev-parse', 'HEAD']).stdout.trim() !== REVISION) {
    console.log(`Fetching Bun ${REVISION.slice(0, 12)} from ${source} into ${cache}`);
    if (git(['-C', cache, 'fetch', '-q', '--depth', '1', existsSync(source) ? resolve(source) : source, REVISION], { stdio: 'inherit' }).status !== 0) {
      throw new Error(`Cannot fetch Bun ${REVISION} from ${source}`);
    }
    if (git(['-C', cache, 'update-ref', '--no-deref', 'HEAD', REVISION]).status !== 0) throw new Error('git update-ref HEAD failed');
  }
  return cache;
}

/** Runs the extraction (or its `--verify`). */
export function vendor({ source, verify = false } = {}) {
  const checkout = bunCheckout(source);
  // Windows installs of Python have no `python3`.
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [resolve(root, 'scripts/vendor-bun.py'), checkout, ...(verify ? ['--verify'] : [])], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`vendor-bun.py exited ${result.status}`);
}

if (process.argv[1] === import.meta.filename) {
  const args = parseArguments(process.argv.slice(2), { flags: ['--verify'], values: ['--bun'] });
  vendor({ source: args.values['--bun'], verify: args.flags.has('--verify') });
}
