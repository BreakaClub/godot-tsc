# godot-tsc

Bun's TypeScript checker and JavaScript compiler running inside Godot, as a GDExtension, with a typed host for
[GodotJS](https://github.com/godotjs/GodotJS) code. Give it a project's files and it type-checks them, compiles TSX/TS to a
CommonJS-shaped function body you can evaluate in the running realm (optionally instrumented for React Fast Refresh), and
answers hover and inlay-hint queries. All of it runs on a thread of its own: no call waits for it, natively or on the Web.

It was built for, and extracted from, the live code editor in [godot-react-ui](https://github.com/BreakaClub/godot-react-ui)'s demo.

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
import { openExtensionHost, RequestScope } from 'godot-tsc';

const host = openExtensionHost(); // throws, saying what to do, when the extension is not loaded
host.setFiles([
  { path: '/project/tsconfig.json', text: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true }, files: ['/project/app.tsx'] }) },
  { path: '/project/app.tsx', text: source },
]);

const compiled = await host.compile('/project/app.tsx', source, /* React Fast Refresh */ true, new RequestScope());
if (compiled.ok) {
  // compiled.code is a function body over require, exports, module, $RefreshReg$ and $RefreshSig$; compiled.imports and .exports name what it uses.
} else {
  compiled.diagnostics; // syntax errors with UTF-16 start/end, line and character
}

const check = await host.requestCheck('/project/tsconfig.json', '/lib');            // { kind: 'checked', report: { diagnostics } } | superseded | failed
const hover = await host.hover('/project/tsconfig.json', '/lib', '/project/app.tsx', offset);
const hints = await host.inlayHints('/project/tsconfig.json', '/lib', '/project/app.tsx', 0, source.length, 'literals');
host.close();
```

- **Nothing blocks.** `compile`, `requestCheck`, `hover` and `inlayHints` return promises settled on a later frame; the host polls
  the extension (a 1 ms timer) only while a request is outstanding.
- **Requests can be taken back.** Cancel a `RequestScope` and its unanswered requests are withdrawn and fail with `RequestCancelled`.
  A check that has not begun when a newer one is asked for is answered as `superseded`.
- **The lib files are yours to supply.** `libDir` is a directory of the in-memory project holding TypeScript's `lib.*.d.ts`
  files (add them with `setFiles`, like any other file); a check of a program without them fails. The `typescript` package's
  `lib/` files work (5.9.3's were checked: `lib.es2022.d.ts`, the decorators and what they reference, 57 files). godot-react-ui's
  demo takes TypeScript 7.0.2's from Bun's own bundle, `vendor/bun/typescript_libs.bin` (zstd with dictionaries; its
  `scripts/live-compile-project.mjs` reads it).
  Packages resolve through `paths`; there is no `node_modules` lookup.
- **Typings.** `godot-tsc` declares the `LiveCompile` class into the `godot` module, so it needs a GodotJS project's own typings
  for `godot`. `ExtensionHost` takes any `ServiceLink`, which is how `tests/service.test.ts` drives it without Godot.

The extension's own API is the `LiveCompile` class (`ext/lib.rs`): `start`, `stop`, `setFile`, `setFiles`, `removeFile`,
`requestPing`, `requestCompile`, `requestCheck`, `requestQuery`, `cancel`, `poll` and `state`. Requests and replies are
JSON (`core/protocol.rs`; validated on the TypeScript side by `src/protocol.ts`).

## Platforms

| Platform | File | Notes |
| --- | --- | --- |
| macOS arm64 | `liblive_compile.dylib` | Bound to the Godot 4.7.2 API (`api/godot-4.7.2`), so it loads in 4.7.2 and newer, including Breaka's 4.8. |
| Web, stock Godot 4.7 templates | `live_compile.web.stock.wasm` | Emscripten 4.0.11 side module. The shipped manifest names this one. |
| Web, Breaka's Godot 4.8 templates | `live_compile.web.breaka.wasm` | Emscripten 6.0.12 with Breaka's lazy function-table ABI; built locally only (below). |

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
pnpm build:native --cli           # out/bin/liblive_compile.dylib, and target/release/live-compile-cli for the tests
pnpm test:rust && pnpm test       # Rust tests; TypeScript tests, including the compiler through live-compile-cli
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
core/      live_compile_core: Service::handle(request) -> JSON response. check.rs (bun_sema), transpile.rs (Bun's parser and
           printer), lower.rs (ES module -> CommonJS-shaped function body with live bindings), services.rs (hover, inlay hints);
           main.rs is live-compile-cli (frames on stdin/stdout), wasm.rs a wasm32-unknown-unknown export
ext/       live_compile_ext: the GDExtension, class LiveCompile; one service thread, a queue and a reply list
scripts/   vendor-bun.py extracts 35 of Bun's crates at the pinned revision into vendor/ (generated, ignored; --verify checks it);
           the build, vendor and stage scripts
patches/   seven reviewed patches to Bun's files, each with its reason in vendor-bun.py's SOURCE_ADAPTATIONS
stubs/     stand-ins for bun_crash_handler and bun_io
api/       the Godot API dumps the extension is bound to (stock 4.7.2; Breaka's 4.8 for its Web profile)
src/       the TypeScript host (dist/ when built)
```

Everything in `vendor/bun` that is not patched or stubbed is Bun's, byte for byte (`vendor/bun/provenance.json`).

## Limits

- Completions are not built. Hover is the name and the type (no documentation), printed with qualified names; inlay hints are
  parameter names and the inferred types of variable declarations.
- The compiled form is a function body: `import.meta` and top-level `await` are diagnostics, and a dynamic `import()` is left as it is.
- On the Web a panic traps the service thread; every outstanding request then fails after the host's 30 s deadline.

## License

MIT. Bun's code under `vendor/` (generated) is Bun's, under its MIT license.
