// Build-only: GodotJS's `godot.lib.api` module, which `src/godot.ts` reaches the engine through, so the package type-checks without a
// Godot project's generated typings. It is not shipped, and the declarations `pnpm build` emits name no engine module.
declare module 'godot.lib.api' {
  const api: unknown;
  export = api;
}
