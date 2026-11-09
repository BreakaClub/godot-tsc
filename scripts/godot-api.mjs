// The Godot APIs the extension is bound to, and the Web profiles. One file names them; the build scripts and stage-addon.mjs read it.
//
// Native: one build per platform, bound to stock Godot 4.7.2's dumps (api/godot-4.7.2). A GDExtension loads in the Godot it was bound to or a
// newer one, and godot-rust's `lazy-function-tables` resolves each method on first use, so the one build also loads in Breaka's Godot 4.8.
//
// Web: a side module must be linked with the Emscripten of the engine whose templates load it, and one linked for another engine's templates kills
// the page at load. So the Web build is per profile, each with its own file name:
//   stock   stock Godot 4.7 Web templates (Emscripten 4.0.11), bound to the 4.7.2 dumps. This is the module the shipped manifest names.
//   breaka  Breaka's Godot 4.8 Web templates (Emscripten 6.0.12 with Breaka's lazy function-table ABI), bound to Breaka's 4.8 dumps (api/breaka-4.8).
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const NATIVE_API = Object.freeze({
  version: '4.7.2',
  extensionApi: resolve(root, 'api/godot-4.7.2/extension_api.json'),
  gdextensionInterface: resolve(root, 'api/godot-4.7.2/gdextension_interface.json'),
});

export const WEB_PROFILES = Object.freeze({
  stock: Object.freeze({
    name: 'stock',
    library: 'godot_tsc.web.stock.wasm',
    extensionApi: NATIVE_API.extensionApi,
    gdextensionInterface: NATIVE_API.gdextensionInterface,
    lazyFunctionTable: false,
  }),
  breaka: Object.freeze({
    name: 'breaka',
    library: 'godot_tsc.web.breaka.wasm',
    extensionApi: resolve(root, 'api/breaka-4.8/extension_api.json'),
    gdextensionInterface: resolve(root, 'api/breaka-4.8/gdextension_interface.json'),
    lazyFunctionTable: true,
  }),
});

/** The dump pair as godot-rust's variables. Cargo's `[env]` (.cargo/config.toml) does not override a variable already set, so builds set these. */
export function bindingEnvironment(api) {
  return { GDRUST_GODOT_API_JSON: api.extensionApi, GDRUST_GODOT_INTERFACE_JSON: api.gdextensionInterface };
}

/** Where builds leave the binaries that stage-addon.mjs packs (the names the manifest uses). */
export const OUT_BIN = resolve(root, 'out/bin');

/** The native library's file name on each platform Godot names in a manifest. */
export const NATIVE_LIBRARIES = Object.freeze({ macos: 'libgodot_tsc.dylib', linux: 'libgodot_tsc.so', windows: 'godot_tsc.dll' });

/** The `--name=value` argument, or undefined; any other argument that is not in `flags` is refused. */
export function parseArguments(argv, { flags = [], values = [] }) {
  const result = { flags: new Set(), values: {} };
  for (const argument of argv) {
    const [name, value] = argument.split(/=(.*)/su);
    if (value === undefined && flags.includes(name)) result.flags.add(name);
    else if (value !== undefined && values.includes(name)) result.values[name] = value;
    else throw new Error(`Unknown argument ${argument}. Takes ${[...flags, ...values.map(name => `${name}=<value>`)].join(', ') || 'none'}.`);
  }
  return result;
}
