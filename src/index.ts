// godot-tsc: Bun's TypeScript checker and JavaScript compiler in a Godot GDExtension, and the typed host GodotJS code talks to it through.
export { openExtensionHost, type LiveCompileHost } from './host';
export { ExtensionHost, REQUEST_DEADLINE_MS, type ServiceLink } from './service';
export { RequestCancelled, RequestScope } from './scope';
export * from './protocol';
