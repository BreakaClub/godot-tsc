# godot-tsc

TypeScript type checking and transpiling inside a running Godot game or editor.

godot-tsc is a GDExtension that runs [Bun](https://github.com/oven-sh/bun)'s TypeScript checker (`bun_sema`, a port of
[typescript-go](https://github.com/microsoft/typescript-go)) and its JavaScript parser and printer on a thread of their own, with a typed,
non-blocking API for [GodotJS](https://github.com/godotjs/GodotJS) code. Give it a project's files and it:

- **transpiles** TS/TSX to a CommonJS-shaped function body you can run in the live JavaScript realm, optionally instrumented for React
  Fast Refresh;
- runs a **language server** (LSP) over them: TypeScript's diagnostics, completion, signature help, hover, inlay hints, go to definition
  and type definition, find references, document highlights and rename.

Nothing waits for it: every request is answered on a later frame, natively and on the Web. It is for in-game code editors, live
scripting and modding tools, and anything else that needs TypeScript's answers while the game runs.

> **Status: 7.0.0, pre-release.** It is not on npm yet, and the only prebuilt binaries are for macOS (Apple silicon) and the Web; other
> desktop platforms build from source (below) but are untested.

## Contents

- [Requirements](#requirements) and [Install](#install)
- [Use](#use): transpiling, the [language server](#language-server), [lib files](#lib-files), [use under Node](#under-node), [typings](#typings)
- [Demo](#demo), [Platforms](#platforms), [Versions](#versions)
- [Build from source](#build-from-source), [Tests](#tests), [Layout](#layout)
- [Limits](#limits), [License](#license), [AI disclosure](#ai-disclosure)

## Requirements

- Godot 4.7.2 or newer, with [GodotJS](https://github.com/godotjs/GodotJS) (tested on its V8 runtime).
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

npm owns the addon, as it owns `node_modules`: the installer writes `addons/godot-tsc/.gitignore` (`*`), so git leaves the folder out, and
an install on a fresh clone (or `npx godot-tsc setup`) puts it back. A project that has to commit the addon (an export machine with no
Node, say) deletes that `.gitignore` after each install.

## Use

```ts
import { LspSession, openTsc } from 'godot-tsc';

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

// Everything else: the language server, for the project whose tsconfig is `config`, with its lib files in `libDir`.
const lsp = new LspSession(tsc, { config: '/project/tsconfig.json', libDir: '/lib' });
await lsp.initialize();
const position = { line: 4, character: 18 };                                // LSP's: from 0, in UTF-16 code units
const { result: report } = await lsp.workspaceDiagnostics();                 // every source's diagnostics: code, message, range
const completions = await lsp.completion('/project/main.ts', position);      // { items: [{ label, kind, detail, textEdit }] }
const help = await lsp.signatureHelp('/project/main.ts', position);          // the call's signatures and the active parameter
const [definition] = await lsp.definition('/project/main.ts', position);     // { uri: 'file:///project/a.ts', range }
const edit = await lsp.rename('/project/main.ts', position, 'length');       // { changes: { [uri]: TextEdit[] } }

tsc.close();
```

| Call | What it does |
| --- | --- |
| `openTsc()` | Opens the extension and starts its service thread. |
| `tsc.setFile(path, text)`, `setFiles(files)`, `removeFile(path)` | The service's in-memory files, at absolute paths: the server's file system. They return at once. The checker reads only what it is given. |
| `tsc.transpile(path, source, { reactRefresh? }, scope?)` | One file to JavaScript. `code` is a function body over `require`, `exports`, `module`, `$RefreshReg$` and `$RefreshSig$`; `imports` and `exports` list what it requires and exports. |
| `new LspSession(tsc, { config, libDir }, { inlayParameterNames? })` | A language server session for the project whose tsconfig is `config`, with its lib files in `libDir`. |
| `tsc.lsp(message, scope?)` | Any one LSP message, and the messages the server sends back. |
| `tsc.close()` | Stops the service. Every outstanding request fails with `RequestCancelled`. |

- **Nothing blocks.** Every call but the file calls returns a promise that settles on a later frame. `Tsc` polls the extension on a 1 ms
  timer, and only while a request is outstanding. `transpileTimed` and `requestTimed` also return the time the service thread took.
- **Requests can be taken back.** Pass a `RequestScope` and cancel it (an edit that overtakes the last one, an editor that closes): its
  unanswered requests are withdrawn and fail with `RequestCancelled`, so an answer you gave up on is never delivered.
- **A request that is never answered fails.** After 30 s (`REQUEST_DEADLINE_MS`) a request fails, saying what the service's queue looked like.
- **Modules.** The transpiled form is a function body, so `import.meta` and top-level `await` are reported as errors, and a dynamic
  `import()` is left as it is. Imports between your files resolve through the tsconfig's `paths`; there is no `node_modules` lookup.

### Language server

`LspSession` names the project in `initialize` (`initializationOptions: { config, libDir, inlayParameterNames }`) and gives each request an
id and a typed result; a refusal fails with `LspError`. `tsc.lsp(message, scope, session)` relays any one JSON-RPC message instead, so a
host can connect an editor of its own (over a socket, say).

The service holds a language server per session. Each `LspSession` is a session of its own, so several projects (an editor with a
tsconfig per tab, say) share one `Tsc` (one service thread and one set of files, parsed once) without initializing anything twice. A
raw `tsc.lsp` message goes to the session it names, `""` by default; `exit` ends a session.

| Request | `LspSession` | |
| --- | --- | --- |
| `textDocument/diagnostic`, `workspace/diagnostic` | `diagnostics(path)`, `workspaceDiagnostics()` | A check of the project: one file's diagnostics, or every source's (the clean ones listed empty). A request that a newer one for the same document replaced before it began fails with `SERVER_CANCELLED`, so typing does not queue checks. |
| `textDocument/completion` | `completion(path, position)` | After `expression.`, the properties of its type, with their types; elsewhere what is in scope: the project's names, then the lib files', then keywords (types only where a type is written). Nothing in a comment or a string. Each item replaces the name being typed. |
| `textDocument/signatureHelp` | `signatureHelp(path, position)` | The signatures of the call the position is in the arguments of, the one the arguments resolve to active, and the parameter it is at (a rest parameter takes the rest). |
| `textDocument/hover` | `hover(path, position)` | The name and its type, as one TypeScript code block (`name: type`, or the type alone where there is no name), and the name's `range`. |
| `textDocument/inlayHint` | `inlayHints(path, range)` | The inferred types of declarations that write none, and the parameter names of arguments (`inlayParameterNames`: `'literals'` by default, `'all'` or `'none'`). |
| `textDocument/definition`, `typeDefinition` | `definition`, `typeDefinition` | The declarations' names. An import goes to what it imports. |
| `textDocument/references`, `documentHighlight` | `references`, `documentHighlight` | Every name that refers to the same symbol, in the project or in the file, in text order. A highlight is `3` (declares) or `2` (reads). |
| `textDocument/prepareRename`, `rename` | `prepareRename`, `rename` | The edits for every reference. A shorthand is written out (`{ x }` becomes `{ x: renamed }` or `{ renamed: x }`); a name an import gives another name keeps it (`import { a as b }` renames `a` only). A symbol of the lib files cannot be renamed. |
| `initialize`, `shutdown`, `exit`, `textDocument/didOpen`, `didChange`, `didClose` | `initialize`, `close`, `open`, `change` | The session and the documents. A document is a `file://` URI of a path of the service's files; opening or changing it (in full or by ranges) sets that file's text. |

References follow what TypeScript's do: through imports and exports, to an interface's property from the object literals typed by it
and from destructurings, and across class members, private names, enum members and namespace members.

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

`godot-tsc` imports GodotJS's `godot.lib.api` module, so it loads only under GodotJS. `godot-tsc/host` is everything except `openTsc`, with
no `godot` import, so code that drives a `Tsc`, cancels with `RequestScope` or parses replies can be loaded and tested under Node. A
`Tsc` takes any `TscLink`, which is how this package's own tests drive it without Godot. The two entries share one module, so a
`RequestCancelled` from either is the same class. Both entries' types resolve under every `moduleResolution`.

### Typings

`godot-tsc`'s declarations name no engine module, so they resolve whatever your project's GodotJS typings are. The package reaches
the engine through GodotJS's `godot.lib.api` module, which takes Godot's own names under either setting of
`runtime/core/camel_case_bindings_enabled`: it works in a project with camel-cased bindings and in one without (`pnpm verify:bindings`
runs it under both). A bundler that keeps `godot` external must keep `godot.lib.api` external too.

The extension's own API is the `GodotTsc` class (`ext/lib.rs`), named here as Godot names it: `start`, `stop`, `set_file`, `set_files`,
`remove_file`, `request_ping`, `request_compile` (the transpile), `request_query` (an LSP message), `request_stall` (a test hook that
holds the service thread), `cancel`,
`poll` (one reply as JSON, or an empty string) and `state`. Requests and replies are JSON (`core/protocol.rs`,
validated by `src/protocol.ts`).

## Demo

`demo/` is a Godot project that uses the package the way yours would: a TypeScript editor whose problems, transpiled JavaScript, the
module's exports (it runs the transpiled code), inlay hints, the type under the caret, the signature of the call the caret is in, its
references, completion (typing `.`, or Ctrl+Space), go to definition (a button, or Ctrl+click) and rename all come from godot-tsc, the
checking, hover and the rest through `LspSession`.

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
exit), pnpm, Python 3.11 or newer and git. The Web build also needs the `wasm32-unknown-emscripten` target and `rust-src` for that nightly, and an
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
binaries, packs the package, attaches it to a GitHub release and publishes that tarball to npm. Publishing uses npm's trusted publishing:
the package's settings on npmjs.com trust this repository's `release.yml` in its `npm` environment, so no npm token is stored. Run by hand, the same workflow is a dry run: it makes everything a release
would publish, uploads it as the run's `godot-tsc-release` artifact and runs `pnpm publish --dry-run` on the tarball, and publishes nothing.

```bash
gh workflow run release.yml --ref main
```

Every CI run also uploads its builds, kept 14 days: the extension (`native-macos`), `godot-tsc-cli` (`godot-tsc-cli-macos`), the stock Web module
(`native-web-stock`), and the npm tarball with the addon zip (`godot-tsc-package`).

## Tests

| Command | What it covers |
| --- | --- |
| `pnpm test` | The host's request flow (ids, polling, cancelling, the deadline, LSP sessions and superseded diagnostics) against a stand-in link; the transpiler and the language server (every request, several sessions in one service) through `godot-tsc-cli`; the installer; and the built package as a consumer resolves it, under Node and TypeScript's module resolutions. |
| `pnpm test:rust` | The extension's request queue (keyed superseding included), superseding keys, and the helpers for positions, symbols, signatures and code-or-comment. |
| `pnpm test:types` | The package's TypeScript. |
| `pnpm demo:verify` | The extension in Godot: transpile, run, diagnostics (an error found, then fixed), hover, inlay hints, references, go to definition, rename, completion, signature help and a typed syntax error, through the demo's UI. |
| `pnpm verify:bindings` | The package in a GodotJS project with camel-cased bindings on, then off (`tests/bindings/`): transpile, a diagnostic, hover, and the cost of a call through `godot.lib.api`. |
| `pnpm vendor --verify` | `vendor/bun` is Bun's code at the pinned revision plus the reviewed patches. |
| `pnpm notices --check` | `THIRD_PARTY_NOTICES.md` matches the dependencies. |

CI runs `test:types`, `test`, `test:rust` and `notices --check`, with Bun vendored fresh at the pinned revision. The demo and
`verify:bindings` need a Godot with GodotJS, so they are run locally.

## Layout

```
core/      godot_tsc_core: the service (requests in, JSON out). check.rs (bun_sema), transpile.rs (Bun's parser and printer),
           lower.rs (ES module to a CommonJS-shaped function body with live bindings), services.rs (hover, inlay hints),
           navigate.rs (definitions, references, rename), complete.rs (completion, signature help), lsp.rs (the language server);
           main.rs is godot-tsc-cli (requests framed on stdin and stdout)
ext/       godot_tsc_ext: the GDExtension, class GodotTsc: one service thread, a request queue and a reply list
src/       the TypeScript API: tsc.ts (Tsc), lsp.ts (LspSession), godot.ts (openTsc), host.ts (godot-tsc/host), protocol.ts,
           scope.ts
node/      godot-tsc/lib-bundle
bin/       the installer (godot-tsc setup, and the postinstall)
scripts/   vendoring, builds, staging, notices and the demo runner
patches/   the patches applied to Bun's files, each with its reason in scripts/vendor-bun.py
stubs/     stand-ins for two of Bun's crates
api/       the Godot API dumps the extension is built against (stock 4.7.2; Breaka's 4.8 for the breaka Web profile)
demo/      the demo project
tests/     the TypeScript tests, and the project `verify:bindings` runs (tests/bindings/)
```

`vendor/bun` is generated by `pnpm vendor` and not committed. Everything in it that is not patched or stubbed is Bun's, byte for byte
(`vendor/bun/provenance.json` records each file's hash).

## Limits

- Hover and completion give names and types, not documentation; completion offers no snippets, auto-imports or module specifiers.
- Diagnostics are pulled (`textDocument/diagnostic`, `workspace/diagnostic`), not pushed (`publishDiagnostics`).
- Definitions in the lib files are not returned: the checker keeps no text of them, so they have no position. Their symbols cannot be renamed.
- Inlay hints cover parameter names and the inferred types of variable declarations.
- On the Web a panic stops the service thread; outstanding requests then fail after the 30 s deadline.

## License

MIT (`LICENSE`). The extension contains Bun's code (MIT) and code ported from typescript-go (Apache-2.0), is built with godot-rust
(MPL-2.0) and other Rust crates, and ships TypeScript's lib files (Apache-2.0): `THIRD_PARTY_NOTICES.md` has their licenses, and it is
installed with the addon.

## AI disclosure

This project makes extensive use of LLM-generated code. If that's a problem for you or your employer, do not use this project.

Realistically, this project is far from novel: it is a wrapper around Bun's library.

Bun's TypeScript library is itself an LLM-driven Rust port of Microsoft's Go codebase. It passes Microsoft's extensive TypeScript test
suite, and has far superior performance to the original codebase. Make of that what you will.
