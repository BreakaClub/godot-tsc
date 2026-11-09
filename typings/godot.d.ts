// Build-only: the few GodotJS declarations `src/host.ts` names, so the package type-checks without a Godot project's generated typings.
// It is not shipped. The declarations `pnpm build` emits import from 'godot', which a GodotJS project's own typings resolve.
declare module 'godot' {
  class RefCounted {}
  class PackedStringArray {
    constructor(values?: readonly string[]);
  }
  namespace ClassDB {
    function classExists(className: string): boolean;
  }
}
