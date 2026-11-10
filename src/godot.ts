import libApi = require('godot.lib.api');
import { Tsc, type ProjectFile, type TscLink } from './host';

/**
 * The extension's class (`ext/lib.rs`, installed at `res://addons/godot-tsc/`), under the names Godot gives its methods. GodotJS exposes
 * them camel-cased or as they are, by the project's `runtime/core/camel_case_bindings_enabled`; `godot.lib.api` takes Godot's own names
 * under either setting, so this package works in both kinds of project.
 */
interface GodotTsc {
  start(): void;
  stop(): void;
  set_file(path: string, text: string): void;
  set_files(paths: unknown, texts: unknown): void;
  remove_file(path: string): void;
  request_ping(): number;
  request_compile(path: string, source: string, refresh: boolean): number;
  request_query(requestJson: string): number;
  request_stall(milliseconds: number): number;
  cancel(id: number): boolean;
  poll(): string;
  state(): string;
}

/** What this file uses of the engine's API. `GodotTsc` is there only when the extension loaded. */
interface EngineApi {
  readonly ClassDB: { class_exists(name: string): boolean };
  readonly PackedStringArray: new (values: readonly string[]) => unknown;
  readonly GodotTsc?: new () => GodotTsc;
}

// A cast, because nothing narrower can be written: `godot.lib.api` is typed by the project's generated typings, which spell the engine's
// members the way that project's setting does and describe `GodotTsc` only if they were generated with the extension loaded. At run time
// the module answers to Godot's own names whatever the setting, which is what `EngineApi` states; `openTsc` checks the class is there
// before using it.
const engine = libApi as unknown as EngineApi;

/** The extension's `GodotTsc` object behind the typed link `Tsc` speaks (`tsc.ts`). */
class GodotLink implements TscLink {
  constructor(private readonly service: GodotTsc) {}

  start(): void {
    this.service.start();
  }

  stop(): void {
    this.service.stop();
  }

  setFile(path: string, text: string): void {
    this.service.set_file(path, text);
  }

  setFiles(files: readonly ProjectFile[]): void {
    this.service.set_files(new engine.PackedStringArray(files.map(file => file.path)), new engine.PackedStringArray(files.map(file => file.text)));
  }

  removeFile(path: string): void {
    this.service.remove_file(path);
  }

  requestPing(): number {
    return this.service.request_ping();
  }

  requestCompile(path: string, source: string, refresh: boolean): number {
    return this.service.request_compile(path, source, refresh);
  }

  requestQuery(requestJson: string): number {
    return this.service.request_query(requestJson);
  }

  requestStall(milliseconds: number): number {
    return this.service.request_stall(milliseconds);
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
  const GodotTscClass = engine.ClassDB.class_exists('GodotTsc') ? engine.GodotTsc : undefined;
  if (typeof GodotTscClass !== 'function') {
    throw new Error('The godot-tsc extension is not loaded: install it with "godot-tsc setup" (res://addons/godot-tsc/) and let the editor import the project once; a Web export needs the side module for its engine\'s Emscripten (README.md)');
  }
  const link = new GodotLink(new GodotTscClass());
  // The thread starts now, not at the first request, so a browser has begun its worker by the time the first request is asked for. Nothing waits for it.
  link.start();
  return new Tsc(link);
}

