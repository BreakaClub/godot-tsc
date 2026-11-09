// Build-only: the timers GodotJS's realms provide (native and Web), which `src/tsc.ts` polls with. The package's declarations are emitted
// without Node's types (tsconfig.package.json), so these stand in for them; nothing here is shipped.
declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
