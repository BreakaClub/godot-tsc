# godot-tsc

Bun's TypeScript checker and transpiler running inside Godot, as a GDExtension, with a typed API for
[GodotJS](https://github.com/godotjs/GodotJS) code. Give it a project's files and it type-checks them, transpiles TSX/TS to a
CommonJS-shaped function body you can evaluate in the running realm (optionally instrumented for React Fast Refresh), and
answers hover and inlay-hint queries. All of it runs on a thread of its own: no call waits for it, natively or on the Web.

It was built for, and extracted from, the code editor in [godot-react-ui](https://github.com/BreakaClub/godot-react-ui)'s demo.

**Versions** follow TypeScript's: the major and minor are those of the TypeScript the checker implements (Bun's `bun_sema` at the
pinned revision, whose lib files are TypeScript 7.0.2's), and the patch is this package's own. 7.0.0 is the first.

## Install

```bash
pnpm add godot-tsc
```

The package's `postinstall` copies the GDExtension into the nearest Godot project above where you installed it, at
`res://addons/godot-tsc/` (and writes `node_modules/.gdignore` so the editor does not import npm's tree). pnpm 10 runs a
dependency's install script only when the project allows it (`"pnpm": { "onlyBuiltDependencies": ["godot-tsc"] }` in
`package.json`, or `pnpm approve-builds`). Either way, to install or update it by hand:

```bash
pnpm exec godot-tsc setup [--project-dir <path>] [--force]
```

Open the project in the editor once afterwards so Godot imports the extension.

## Use

```ts
import { openTsc, RequestScope } from 'godot-tsc';

const tsc = openTsc(); // starts the service thread; throws, saying what to do, when the extension is not loaded
tsc.setFiles([
  { path: '/project/tsconfig.json', text: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true }, files: ['/project/app.tsx'] }) },
  { path: '/project/app.tsx', text: source },
  ...libFiles, // TypeScript's lib.*.d.ts under /lib (below)
]);

const result = await tsc.transpile('/project/app.tsx', source, { reactRefresh: true });
if (result.ok) {
  result.code;    // a function body over require, exports, module, $RefreshReg$ and $RefreshSig$
  result.imports; // the specifiers it requires; result.exports, the names it exports
} else {
  result.diagnostics; // syntax errors with UTF-16 start/end, line and character
}

const project = tsc.project({ config: '/project/tsconfig.json', libDir: '/lib' });
const check = await project.check();                            // { kind: 'checked', report: { diagnostics } } | { kind: 'superseded' } | { kind: 'failed' }
const hover = await project.hover('/project/app.tsx', offset);  // { start, end, name, type } | null
const hints = await project.inlayHints('/project/app.tsx', { from: 0, to: source.length }, 'literals');
tsc.close();
```

| Call | What it does |
| --- | --- |
| `openTsc()` | The `Tsc` over the extension, its service thread started. |
| `tsc.setFile(path, text)`, `setFiles(files)`, `removeFile(path)` | The checker's in-memory files: absolute paths (`/project/app.tsx`). Return at once. |
| `tsc.transpile(path, source, { reactRefresh? }, scope?)` | One file to JavaScript with Bun's parser and printer. Syntax only: it type-checks nothing. |
| `tsc.project({ config, libDir })` | A `TscProject`: the project whose tsconfig is `config`, with its lib files in `libDir`. |
| `project.check(scope?)` | Type-checks the project. A check not begun when the next is asked for is answered as `superseded`. |
| `project.hover(path, offset, scope?)` | The name and type under a UTF-16 offset. |
| `project.inlayHints(path, { from, to }, parameterNames?, scope?)` | Inferred declaration types and argument parameter names in a range (`'literals'` by default, or `'all'`, `'none'`). |
| `tsc.close()` | Stops the service; every outstanding request fails with `RequestCancelled`. |

- **Nothing blocks.** Every call but the file calls returns a promise settled on a later frame; `Tsc` polls the extension (a 1 ms
  timer) only while a request is outstanding. `transpileTimed` also gives the time the service thread took.
- **Requests can be taken back.** Pass a `RequestScope` and cancel it: its unanswered requests are withdrawn and fail with
  `RequestCancelled`, so an answer that was given up is never delivered.
- **The lib files are yours to supply.** `libDir` is a directory of the in-memory files holding TypeScript's `lib.*.d.ts`; a check
  of a program without them fails. The `typescript` package's `lib/` files work (5.9.3's were checked: `lib.es2022.d.ts`, the
  decorators and what they reference, 57 files). Bun's own bundle of TypeScript 7.0.2's is `vendor/bun/typescript_libs.bin`
  (zstd with dictionaries; godot-react-ui's demo reads it). Packages resolve through `paths`; there is no `node_modules` lookup.
- **Typings.** `godot-tsc` declares the `GodotTsc` class into the `godot` module, so it needs a GodotJS project's own typings for
  `godot`. `Tsc` takes any `TscLink`, which is how `tests/tsc.test.ts` drives it without Godot, and `TscHost` is the interface
  a stand-in implements.

The extension's own API is the `GodotTsc` class (`ext/lib.rs`): `start`, `stop`, `setFile`, `setFiles`, `removeFile`,
`requestPing`, `requestCompile` (the transpile), `requestCheck`, `requestQuery` (hover and inlay hints as JSON), `requestStall`
(a test hook that holds the service thread), `cancel`, `poll` (one reply as JSON, or an empty string) and `state`. Requests and
replies are JSON (`core/protocol.rs`; validated on the TypeScript side by `src/protocol.ts`).

## Platforms

| Platform | File | Notes |
| --- | --- | --- |
| macOS arm64 | `libgodot_tsc.dylib` | Bound to the Godot 4.7.2 API (`api/godot-4.7.2`), so it loads in 4.7.2 and newer, including Breaka's 4.8. |
| Web, stock Godot 4.7 templates | `godot_tsc.web.stock.wasm` | Emscripten 4.0.11 side module. The shipped manifest names this one. |
| Web, Breaka's Godot 4.8 templates | `godot_tsc.web.breaka.wasm` | Emscripten 6.0.12 with Breaka's lazy function-table ABI; built locally only (below). |

A Web side module must be linked with the Emscripten of the engine whose templates load it; one linked for the other engine
kills the page at load. A manifest can name one module for `web.*.threads.wasm32`, so `stage-addon.mjs --web-profile=breaka`
stages an addon for Breaka's templates instead. Linux and Windows are not built yet. GodotJS's native V8 has no
WebAssembly, which is why the native side is a GDExtension and not a wasm checker.

## Build from source

Prerequisites: rustup (the nightly in `rust-toolchain.toml` installs itself), Node 24, pnpm, Python 3 and git. The Web build
also needs `wasm32-unknown-emscripten` and `rust-src` for that nightly, and an Emscripten SDK in `EMSDK`.

```bash
pnpm install
pnpm vendor                       # Bun's crates into vendor/bun (fetches Bun at the pinned revision; --bun=<checkout> reads a local one)
pnpm build:native --cli           # out/bin/libgodot_tsc.dylib, and target/release/godot-tsc-cli for the tests
pnpm test:rust && pnpm test       # Rust tests; TypeScript tests, including the transpiler through godot-tsc-cli
EMSDK=<emsdk 4.0.11> pnpm build:web --profile=stock
pnpm build                        # dist/: CommonJS, ES modules and declarations
pnpm stage:addon                  # addon/godot-tsc/ from out/bin, with its manifest and build.json
pnpm pack
```

The Breaka profile's Web build takes `EMSDK` (Breaka's Emscripten 6.0.12), `BINARYEN_ROOT`, `BINARYEN_MANIFEST_SHA256` and
`GODOT_EMSCRIPTEN_HELPER` (Breaka's `platform/web/emscripten_helpers.py`); `scripts/build-web.mjs` describes each one.

Releases: pushing a tag `v<version>` that matches `package.json` runs `.github/workflows/release.yml`, which builds macOS arm64
and the stock Web module, stages the addon, packs the tarball and attaches both to a GitHub release. Publishing to npm is not
switched on yet.

## What is inside

```
core/      godot_tsc_core: Service::handle(request) -> JSON response. check.rs (bun_sema), transpile.rs (Bun's parser and
           printer), lower.rs (ES module -> CommonJS-shaped function body with live bindings), services.rs (hover, inlay hints);
           main.rs is godot-tsc-cli (frames on stdin/stdout), wasm.rs a wasm32-unknown-unknown export
ext/       godot_tsc_ext: the GDExtension, class GodotTsc; one service thread, a queue and a reply list
scripts/   vendor-bun.py extracts 35 of Bun's crates at the pinned revision into vendor/ (generated, ignored; --verify checks it);
           the build, vendor and stage scripts
patches/   seven reviewed patches to Bun's files, each with its reason in vendor-bun.py's SOURCE_ADAPTATIONS
stubs/     stand-ins for bun_crash_handler and bun_io
api/       the Godot API dumps the extension is bound to (stock 4.7.2; Breaka's 4.8 for its Web profile)
src/       the TypeScript API: tsc.ts (Tsc, TscProject), godot.ts (openTsc), protocol.ts, scope.ts (dist/ when built)
```

Everything in `vendor/bun` that is not patched or stubbed is Bun's, byte for byte (`vendor/bun/provenance.json`).

## Limits

- Completions are not built. Hover is the name and the type (no documentation), printed with qualified names; inlay hints are
  parameter names and the inferred types of variable declarations.
- The transpiled form is a function body: `import.meta` and top-level `await` are diagnostics, and a dynamic `import()` is left as it is.
- On the Web a panic traps the service thread; every outstanding request then fails after the host's 30 s deadline.

## License

MIT. Bun's code under `vendor/` (generated) is Bun's, under its MIT license.
