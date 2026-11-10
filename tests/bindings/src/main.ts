// The package under either setting of GodotJS's `runtime/core/camel_case_bindings_enabled` (`scripts/verify-bindings.mjs` runs this
// project with it on and with it off). This script names no engine member whose name the setting changes, apart from picking the one
// it needs to quit, so the same bundle runs under both and whatever fails is the package's.
import { Node } from 'godot';
import { LspSession, openTsc } from 'godot-tsc';
import libs from '../tsc/libs.json';

const LIB_DIR = '/lib';
const SOURCE_PATH = '/project/main.ts';
const CONFIG_PATH = '/project/tsconfig.json';
const CONFIG = JSON.stringify({ compilerOptions: { target: 'es2022', lib: ['es2022'], strict: true }, files: [SOURCE_PATH] });
const SOURCE = 'const origin = { x: 1, y: 2 };\nexport const wrong: string = origin.x;\n';
const TS_NOT_ASSIGNABLE = 2322;
const DEADLINE_MS = 20_000;
/** Calls timed per way of reaching the extension: enough that a call's cost is above the clock's resolution. */
const TIMED_CALLS = 200_000;
const NANOSECONDS_PER_MILLISECOND = 1e6;

function quit(node: Node, code: number): void {
  // The one engine member this script names: `get_tree`, or `getTree` in a camel-cased project.
  const tree = 'get_tree' in node ? (node as any).get_tree() : (node as any).getTree();
  tree.quit(code);
}

/** Nanoseconds per call of `poll` on an idle service: through the engine's module as it is, and through `godot.lib.api` as the package calls it. */
function timePoll(): string {
  const direct = new (require('godot').GodotTsc)();
  const proxied = new (require('godot.lib.api').GodotTsc)();
  const time = (service: { poll(): string }): number => {
    const start = Date.now();
    for (let call = 0; call < TIMED_CALLS; call++) service.poll();
    return ((Date.now() - start) * NANOSECONDS_PER_MILLISECOND) / TIMED_CALLS;
  };
  time(direct);
  time(proxied);
  return `poll ${time(direct).toFixed(0)} ns direct, ${time(proxied).toFixed(0)} ns through godot.lib.api`;
}

async function run(): Promise<string> {
  const tsc = openTsc();
  tsc.setFiles([...(libs as { name: string; text: string }[]).map(lib => ({ path: `${LIB_DIR}/${lib.name}`, text: lib.text })), { path: CONFIG_PATH, text: CONFIG }]);
  tsc.setFile(SOURCE_PATH, SOURCE);
  await tsc.ping();
  const transpiled = await tsc.transpile(SOURCE_PATH, SOURCE);
  if (!transpiled.ok || transpiled.exports.join() !== 'wrong') throw new Error(`The source transpiled to ${JSON.stringify(transpiled)}`);
  const lsp = new LspSession(tsc, { config: CONFIG_PATH, libDir: LIB_DIR });
  await lsp.initialize();
  await lsp.open(SOURCE_PATH, SOURCE);
  const diagnostics = await lsp.diagnostics(SOURCE_PATH);
  if (diagnostics.length !== 1 || diagnostics[0]?.code !== TS_NOT_ASSIGNABLE) throw new Error(`The diagnostics are ${JSON.stringify(diagnostics)}`);
  const hover = await lsp.hover(SOURCE_PATH, { line: 0, character: 'const o'.length });
  if (hover?.contents.value.includes('x: number') !== true) throw new Error(`Hover on origin showed ${JSON.stringify(hover)}`);
  tsc.removeFile(SOURCE_PATH);
  const state = tsc.state();
  await lsp.close();
  tsc.close();
  return `transpile, TS2322, hover, state ${JSON.stringify(state)}, ${timePoll()}`;
}

export default class Main extends Node {
  _ready(): void {
    const deadline = setTimeout(() => {
      console.error(`godot-tsc bindings failed: no result after ${DEADLINE_MS} ms`);
      quit(this, 1);
    }, DEADLINE_MS);
    run().then(summary => {
      clearTimeout(deadline);
      console.log(`godot-tsc bindings verified: ${summary}`);
      quit(this, 0);
    }, (error: unknown) => {
      clearTimeout(deadline);
      console.error(`godot-tsc bindings failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      quit(this, 1);
    });
  }
}
