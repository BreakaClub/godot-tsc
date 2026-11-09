// godot-tsc: Bun's TypeScript checker and transpiler in a Godot GDExtension, and the typed API GodotJS code uses it through.
// `godot-tsc/host` is the same without `openTsc`, for code that must load where there is no `godot` module (Node).
export { openTsc } from './godot';
export * from './host';
