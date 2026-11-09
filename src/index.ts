// godot-tsc: Bun's TypeScript checker and transpiler in a Godot GDExtension, and the typed API GodotJS code uses it through.
export { openTsc } from './godot';
export { REQUEST_DEADLINE_MS, Tsc, TscProject, type ProjectOptions, type TextRange, type TranspileOptions, type TscHost, type TscLink } from './tsc';
export { RequestCancelled, RequestScope } from './scope';
export * from './protocol';
