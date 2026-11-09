import { ClassDB, GodotTsc, PackedStringArray, RefCounted } from 'godot';
import { Tsc, type ProjectFile, type TscLink } from './host';

// `GodotTsc` is the class of this package's GDExtension (`ext/lib.rs`, installed at `res://addons/godot-tsc/`). A project's
// generated GodotJS typings describe it only if they were generated with the extension loaded, so it is declared here, and
// `openTsc` says what to do when it is missing. The names are camel-cased by GodotJS (`runtime/core/camel_case_bindings_enabled`).
declare module 'godot' {
  class GodotTsc extends RefCounted {
    start(): void;
    stop(): void;
    setFile(path: string, text: string): void;
    setFiles(paths: PackedStringArray, texts: PackedStringArray): void;
    removeFile(path: string): void;
    requestPing(): number;
    requestCompile(path: string, source: string, refresh: boolean): number;
    requestCheck(config: string, libDir: string): number;
    requestQuery(requestJson: string): number;
    requestStall(milliseconds: number): number;
    cancel(id: number): boolean;
    poll(): string;
    state(): string;
  }
}

/** The extension's `GodotTsc` object behind the typed link `Tsc` speaks (`tsc.ts`). */
class GodotLink implements TscLink {
  private readonly service = new GodotTsc();

  start(): void {
    this.service.start();
  }

  stop(): void {
    this.service.stop();
  }

  setFile(path: string, text: string): void {
    this.service.setFile(path, text);
  }

  setFiles(files: readonly ProjectFile[]): void {
    this.service.setFiles(new PackedStringArray(files.map(file => file.path)), new PackedStringArray(files.map(file => file.text)));
  }

  removeFile(path: string): void {
    this.service.removeFile(path);
  }

  requestPing(): number {
    return this.service.requestPing();
  }

  requestCompile(path: string, source: string, refresh: boolean): number {
    return this.service.requestCompile(path, source, refresh);
  }

  requestCheck(config: string, libDir: string): number {
    return this.service.requestCheck(config, libDir);
  }

  requestQuery(requestJson: string): number {
    return this.service.requestQuery(requestJson);
  }

  requestStall(milliseconds: number): number {
    return this.service.requestStall(milliseconds);
  }

  cancel(id: number): boolean {
    return this.service.cancel(id);
  }

  poll(): string {
    return this.service.poll();
  }

  state(): string {
    return this.service.state();
  }
}

/** Bun's checker and transpiler in the godot-tsc extension, its service thread started; throws, saying how to get the extension, when it is not loaded. */
export function openTsc(): Tsc {
  // Ask the engine before naming the class. A build without the extension has no such class, and on the Web naming a class the engine lacks makes the engine log
  // `godot class not found` as an error, caught or not: a Web export without the extension's module would then log an error for a
  // fallback that works. The class is also a property of the engine's module only when the extension loaded.
  if (!ClassDB.classExists('GodotTsc') || typeof GodotTsc !== 'function') {
    throw new Error('The godot-tsc extension is not loaded: install it with "godot-tsc setup" (res://addons/godot-tsc/) and let the editor import the project once; a Web export needs the side module for its engine\'s Emscripten (README.md)');
  }
  const link = new GodotLink();
  // The thread starts now, not at the first request, so a browser has begun its worker by the time the first request is asked for. Nothing waits for it.
  link.start();
  return new Tsc(link);
}

