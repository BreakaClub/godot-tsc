# godot-tsc

TypeScript type checking and transpiling inside a running Godot game or editor.

godot-tsc is a GDExtension that runs [Bun](https://github.com/oven-sh/bun)'s TypeScript checker (`bun_sema`, a port of
[typescript-go](https://github.com/microsoft/typescript-go)) and its JavaScript parser and printer on a thread of their own, with a typed,
non-blocking API for [GodotJS](https://github.com/godotjs/GodotJS) code. Give it a project's files and it:

- **type-checks** them and reports TypeScript's diagnostics, with positions;
- **transpiles** TS/TSX to a CommonJS-shaped function body you can run in the live JavaScript realm, optionally instrumented for React
  Fast Refresh;
- answers **hover** (the name and type at an offset) and **inlay hint** queries.

Nothing waits for it: every request is answered on a later frame, natively and on the Web. It is for in-game code editors, live
scripting and modding tools, and anything else that needs TypeScript's answers while the game runs.

> **Status: 7.0.0, pre-release.** It is not on npm yet, and the only prebuilt binaries are for macOS (Apple silicon) and the Web; other
> desktop platforms build from source (below) but are untested.

## Requirements

- Godot 4.7.2 or newer, with [GodotJS](https://github.com/godotjs/GodotJS) (tested on its V8 runtime).
- GodotJS's camel-cased bindings, in `project.godot`:

  ```ini
  [GodotJS]
  runtime/core/camel_case_bindings_enabled=true
  ```

- Node 18 or newer to install it (Node 24 for `godot-tsc/lib-bundle`, below).

## Install

```bash
npm install godot-tsc            # or pnpm add godot-tsc, or yarn add godot-tsc
```

Install it in your Godot project's directory (or below it). The package's `postinstall` copies the GDExtension into the nearest
project above it, at `res://addons/godot-tsc/`, and writes `node_modules/.gdignore` so the editor does not import npm's files. pnpm 10
and later run a dependency's install script only when the project allows it: add `"pnpm": { "onlyBuiltDependencies": ["godot-tsc"] }`
to `package.json`, or run `pnpm approve-builds`. To install or update the addon by hand:

```bash
npx godot-tsc setup [--project-dir <path>] [--force]
```

Then open the project in the Godot editor once, so it imports the extension.

## Use

```ts
import { openTsc } from 'godot-tsc';

const tsc = openTsc(); // starts the service thread; throws, saying what to do, when the extension is not loaded

tsc.setFiles([
  { path: '/project/tsconfig.json', text: JSON.stringify({ compilerOptions: { strict: true, lib: ['es2022'] }, files: ['/project/main.ts'] }) },
  { path: '/project/main.ts', text: source },
  ...libFiles, // TypeScript's lib.*.d.ts, as { path: '/lib/lib.es2022.d.ts', text } (see "Lib files")
]);

// Transpile: syntax only, no type checking.
const result = await tsc.transpile('/project/main.ts', source);
if (result.ok) {
  const module = { exports: {} };
  new Function('require', 'exports', 'module', '$RefreshReg$', '$RefreshSig$', result.code)(require, module.exports, module, () => {}, () => () => {});
} else {
  result.diagnostics; // syntax errors: UTF-16 start and end, line and character
}

// Check, hover and inlay hints: against a project (its tsconfig, and where its lib files are).
const project = tsc.project({ config: '/project/tsconfig.json', libDir: '/lib' });
const check = await project.check();
if (check.kind === 'checked') check.report.diagnostics; // TypeScript's diagnostics: code, message, positions
const hover = await project.hover('/project/main.ts', offset); // { start, end, name, type } or null
const hints = await project.inlayHints('/project/main.ts', { from: 0, to: source.length });

tsc.close();
```

| Call | What it does |
| --- | --- |
| `openTsc()` | Opens the extension and starts its service thread. |
| `tsc.setFile(path, text)`, `setFiles(files)`, `removeFile(path)` | The checker's in-memory files, at absolute paths. They return at once. There is no file system: the checker reads only what it is given. |
| `tsc.transpile(path, source, { reactRefresh? }, scope?)` | One file to JavaScript. `code` is a function body over `require`, `exports`, `module`, `$RefreshReg$` and `$RefreshSig$`; `imports` and `exports` list what it requires and exports. |
| `tsc.project({ config, libDir })` | A project: the tsconfig at `config`, with its lib files in `libDir`. |
| `project.check(scope?)` | Type-checks the project: `checked` with a report, `failed`, or `superseded` when a newer check was asked for before this one began. |
| `project.hover(path, offset, scope?)` | The name and type at a UTF-16 offset. |
| `project.inlayHints(path, { from, to }, parameterNames?, scope?)` | Inferred variable types and argument parameter names in a range. `parameterNames` is `'literals'` (the default), `'all'` or `'none'`. |
| `tsc.close()` | Stops the service. Every outstanding request fails with `RequestCancelled`. |

- **Nothing blocks.** Every call but the file calls returns a promise that settles on a later frame. `Tsc` polls the extension on a 1 ms
  timer, and only while a request is outstanding. `transpileTimed` also returns the time the service thread took.
- **Requests can be taken back.** Pass a `RequestScope` and cancel it (an edit that overtakes the last one, an editor that closes): its
  unanswered requests are withdrawn and fail with `RequestCancelled`, so an answer you gave up on is never delivered.
- **A request that is never answered fails.** After 30 s (`REQUEST_DEADLINE_MS`) a request fails, saying what the service's queue looked like.
- **Modules.** The transpiled form is a function body, so `import.meta` and top-level `await` are reported as errors, and a dynamic
  `import()` is left as it is. Imports between your files resolve through the tsconfig's `paths`; there is no `node_modules` lookup.

### Lib files

A check needs TypeScript's `lib.*.d.ts` files among the in-memory files, under `libDir`; without them it fails. The package ships Bun's
bundle of TypeScript 7.0.2's lib files as `godot-tsc/typescript_libs.bin`, and `godot-tsc/lib-bundle` reads it under Node 24, so a build
step can write the ones your project needs to a file your game loads:

```js
// build-libs.mjs (Node 24): writes res://tsc/libs.json
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ES2022_LIB_ROOTS, libClosure, readLibBundle } from 'godot-tsc/lib-bundle';

const all = readLibBundle(createRequire(import.meta.url).resolve('godot-tsc/typescript_libs.bin'));
const libs = libClosure(all, ES2022_LIB_ROOTS); // lib.es2022.d.ts, the decorators, and everything they reference: 57 files
writeFileSync('tsc/libs.json', JSON.stringify([...libs].map(([name, text]) => ({ path: `/lib/${name}`, text }))));
```

```ts
// In the game
const libFiles = JSON.parse(FileAccess.getFileAsString('res://tsc/libs.json'));
```

The `typescript` package's `lib/` files work as well (5.9.3's were checked).

### Under Node

`godot-tsc` imports the engine's `godot` module, so it loads only under GodotJS. `godot-tsc/host` is everything except `openTsc`, with
no `godot` import, so code that drives a `Tsc`, cancels with `RequestScope` or parses replies can be loaded and tested under Node. A
`Tsc` takes any `TscLink`, which is how this package's own tests drive it without Godot. The two entries share one module, so a
`RequestCancelled` from either is the same class. Both entries' types resolve under every `moduleResolution`.

### Typings

`godot-tsc` declares the extension's `GodotTsc` class in the `godot` module, so it needs your project's GodotJS typings for `godot`.
Typings generated with the extension loaded declare `GodotTsc` as well, and the two declarations conflict: generate them with the addon
out of the project, as `scripts/demo.mjs` does.

The extension's own API is the `GodotTsc` class (`ext/lib.rs`): `start`, `stop`, `setFile`, `setFiles`, `removeFile`, `requestPing`,
`requestCompile` (the transpile), `requestCheck`, `requestQuery` (hover and inlay hints), `requestStall` (a test hook that holds the
service thread), `cancel`, `poll` (one reply as JSON, or an empty string) and `state`. Requests and replies are JSON (`core/protocol.rs`,
validated by `src/protocol.ts`).

## Demo

`demo/` is a Godot project that uses the package the way yours would: a TypeScript editor whose problems, transpiled JavaScript, the
module's exports (it runs the transpiled code), inlay hints and the type under the caret all come from godot-tsc.

```bash
pnpm install && pnpm vendor && pnpm build:native   # build the extension (see "Build from source")
GODOT=/path/to/godot pnpm demo                      # build the demo and open it
GODOT=/path/to/godot pnpm demo:verify               # the same, headless: the demo drives itself and checks every answer
```

`GODOT` is a Godot 4.7.2 or newer with GodotJS (or `godot` on `PATH`). `scripts/demo.mjs` installs the addon with `godot-tsc setup`,
writes the lib files, generates GodotJS's typings for that engine, type-checks and bundles `demo/src`, and runs the demo.
`--capture=<png>` opens a window, saves a screenshot and quits. The demo has been verified with stock Godot 4.7.2 and upstream GodotJS,
and with Breaka's Godot 4.8.

## Platforms

| Platform | File | Status |
| --- | --- | --- |
| macOS (Apple silicon) | `libgodot_tsc.dylib` | Prebuilt. Built against the Godot 4.7.2 API, so it loads in 4.7.2 and newer. |
| Web (stock Godot 4.7 templates) | `godot_tsc.web.stock.wasm` | Prebuilt. An Emscripten 4.0.11 side module for threaded Web exports. |
| Linux, Windows, macOS (Intel) | `libgodot_tsc.so`, `godot_tsc.dll` | Build from source (`pnpm build:native --target=<triple>`); untested. |

GodotJS's native V8 has no WebAssembly, which is why the checker runs as a GDExtension rather than as a wasm module in JavaScript.

On the Web, a side module must be linked with the same Emscripten as the export templates that load it; one linked for other templates
stops the page at load. The `breaka` Web profile (`pnpm build:web --profile=breaka`, `pnpm stage:addon --web-profile=breaka`) is for
Breaka's custom Godot 4.8 templates, which use Emscripten 6.0.12 and a lazy function-table ABI. Its requirements are in
`scripts/build-web.mjs`; it is not needed for stock Godot.

`addons/godot-tsc/build.json` records the package version, the commit, each binary's SHA-256 and the Godot API it was built against, so
a project can check what it installed.

## Versions

The major and minor follow the TypeScript the checker implements (its lib files are TypeScript 7.0.2's); the patch is this package's
own. 7.0.0 is the first release.

## Build from source

You need rustup (the nightly in `rust-toolchain.toml` installs itself), Node 24 (`.node-version`; avoid 24.7.0, which can crash at
exit), pnpm, Python 3 and git. The Web build also needs the `wasm32-unknown-emscripten` target and `rust-src` for that nightly, and an
Emscripten SDK in `EMSDK`.

```bash
pnpm install
pnpm vendor                       # extracts Bun's crates into vendor/bun (fetches Bun at the pinned revision; --bun=<checkout> uses a local one)
pnpm build:native --cli           # out/bin/libgodot_tsc.dylib, and target/release/godot-tsc-cli for the tests
pnpm test:rust && pnpm test
EMSDK=<emsdk 4.0.11> pnpm build:web --profile=stock
pnpm build                        # dist/: CommonJS, ES modules and declarations
pnpm stage:addon                  # addon/godot-tsc/ from out/bin, with its manifest, build.json and the licenses
pnpm pack
```

Pushing a tag `v<version>` that matches `package.json` runs `.github/workflows/release.yml`, which builds the macOS and stock Web
binaries, packs the package and attaches it to a GitHub release.

## Tests

| Command | What it covers |
| --- | --- |
| `pnpm test` | The host's request flow (ids, polling, cancelling, the deadline, superseded checks, projects) against a stand-in link; the transpiler through `godot-tsc-cli`; the installer; and the built package as a consumer resolves it, under Node and TypeScript's module resolutions. |
| `pnpm test:rust` | The extension's request queue, and the checker's symbol and position helpers. |
| `pnpm test:types` | The package's TypeScript. |
| `pnpm demo:verify` | The extension in Godot: transpile, run, check (an error found, then fixed), hover, inlay hints and a typed syntax error, through the demo's UI. |
| `pnpm vendor --verify` | `vendor/bun` is Bun's code at the pinned revision plus the reviewed patches. |
| `pnpm notices --check` | `THIRD_PARTY_NOTICES.md` matches the dependencies. |

CI runs `test:types`, `test`, `test:rust` and `notices --check`, with Bun vendored fresh at the pinned revision. The demo needs a Godot
with GodotJS, so it is run locally.

## Layout

```
core/      godot_tsc_core: the service (requests in, JSON out). check.rs (bun_sema), transpile.rs (Bun's parser and printer),
           lower.rs (ES module to a CommonJS-shaped function body with live bindings), services.rs (hover, inlay hints);
           main.rs is godot-tsc-cli (requests framed on stdin and stdout)
ext/       godot_tsc_ext: the GDExtension, class GodotTsc: one service thread, a request queue and a reply list
src/       the TypeScript API: tsc.ts (Tsc, TscProject), godot.ts (openTsc), host.ts (godot-tsc/host), protocol.ts, scope.ts
node/      godot-tsc/lib-bundle
bin/       the installer (godot-tsc setup, and the postinstall)
scripts/   vendoring, builds, staging, notices and the demo runner
patches/   the patches applied to Bun's files, each with its reason in scripts/vendor-bun.py
stubs/     stand-ins for two of Bun's crates
api/       the Godot API dumps the extension is built against (stock 4.7.2; Breaka's 4.8 for the breaka Web profile)
demo/      the demo project
tests/     the TypeScript tests
```

`vendor/bun` is generated by `pnpm vendor` and not committed. Everything in it that is not patched or stubbed is Bun's, byte for byte
(`vendor/bun/provenance.json` records each file's hash).

## Limits

- No completions yet. Hover gives the name and the type, not documentation.
- Inlay hints cover parameter names and the inferred types of variable declarations.
- On the Web a panic stops the service thread; outstanding requests then fail after the 30 s deadline.

## License

MIT (`LICENSE`). The extension contains Bun's code (MIT) and code ported from typescript-go (Apache-2.0), is built with godot-rust
(MPL-2.0) and other Rust crates, and ships TypeScript's lib files (Apache-2.0): `THIRD_PARTY_NOTICES.md` has their licenses, and it is
installed with the addon.
