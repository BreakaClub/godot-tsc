import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

// The language server (core/lsp.rs, core/navigate.rs) through godot-tsc-cli: a session of frames, each `{op:"lsp", message}` after the
// project's files are set. Needs `pnpm build:native --cli`, and the lib bundle (`pnpm vendor`) for the checker's lib files.

const root = resolve(__dirname, '..');
const CLI = resolve(root, 'target/release/godot-tsc-cli');
const LIB_BUNDLE = [resolve(root, 'libs/typescript_libs.bin'), resolve(root, 'vendor/bun/typescript_libs.bin')].find(file => existsSync(file));
const SKIP = !existsSync(CLI) ? 'godot-tsc-cli is not built: run `pnpm build:native --cli`' : LIB_BUNDLE === undefined ? 'no typescript_libs.bin: run `pnpm vendor`' : false;
const FRAME_HEADER_BYTES = 4;

const A = `export interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const origin: Point = { x: 0, y: 0 };
`;

const B = `import { distance, origin, type Point } from './a';

const x = 3;
const target: Point = { x, y: 4 };
export const d = distance(origin, target);
const { y } = target;
export const sum = y + target.y;
`;

const CONFIG = JSON.stringify({ compilerOptions: { target: 'es2022', lib: ['es2022'], module: 'esnext', moduleResolution: 'bundler', strict: true }, files: ['/project/a.ts', '/project/b.ts'] });
const A_URI = 'file:///project/a.ts';
const B_URI = 'file:///project/b.ts';

interface Position { readonly line: number; readonly character: number }
interface Range { readonly start: Position; readonly end: Position }
interface Location { readonly uri: string; readonly range: Range }
interface TextEdit { readonly range: Range; readonly newText: string }
interface Message { readonly id?: number; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } }

async function libFiles(): Promise<{ path: string; text: string }[]> {
  const { ES2022_LIB_ROOTS, libClosure, readLibBundle } = await import('../node/lib-bundle.mjs');
  if (LIB_BUNDLE === undefined) throw new Error('no lib bundle');
  return [...libClosure(readLibBundle(LIB_BUNDLE), ES2022_LIB_ROOTS)].map(([name, text]) => ({ path: `/lib/${name}`, text }));
}

function frame(request: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(request));
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/** Runs one session: the project's files, `initialize`, then `messages`. Returns what the server sent back for each of `messages`. */
async function session(messages: readonly object[], options: { readonly initialize?: boolean } = {}): Promise<Message[][]> {
  const files = [...await libFiles(), { path: '/project/tsconfig.json', text: CONFIG }, { path: '/project/a.ts', text: A }, { path: '/project/b.ts', text: B }];
  const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {}, initializationOptions: { config: '/project/tsconfig.json', libDir: '/lib' } } };
  const sent = [...(options.initialize === false ? [] : [initialize]), ...messages];
  const input = Buffer.concat([frame({ op: 'setFiles', files }), ...sent.map(message => frame({ op: 'lsp', message }))]);
  const reply = spawnSync(CLI, [], { input, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(reply.status, 0, reply.stderr.toString());
  const responses: string[] = [];
  for (let at = 0; at < reply.stdout.length;) {
    const length = reply.stdout.readUInt32LE(at);
    responses.push(reply.stdout.subarray(at + FRAME_HEADER_BYTES, at + FRAME_HEADER_BYTES + length).toString('utf8'));
    at += FRAME_HEADER_BYTES + length;
  }
  const answers = responses.slice(1 + (options.initialize === false ? 0 : 1)).map(json => {
    const parsed: { ok: boolean; messages: Message[] } = JSON.parse(json);
    assert.ok(parsed.ok, json);
    return parsed.messages;
  });
  assert.equal(answers.length, messages.length);
  return answers;
}

let nextId = 1;
function request(method: string, params: object): object {
  return { jsonrpc: '2.0', id: nextId++, method, params };
}

/** A position in `text`: the `occurrence`th (from 0) appearance of `needle`, `offset` characters into it. */
function at(text: string, needle: string, occurrence = 0, offset = 0): Position {
  let index = -1;
  for (let seen = 0; seen <= occurrence; seen += 1) {
    index = text.indexOf(needle, index + 1);
    assert.notEqual(index, -1, `"${needle}" #${occurrence} is not in the text`);
  }
  const before = text.slice(0, index + offset).split('\n');
  return { line: before.length - 1, character: (before.at(-1) ?? '').length };
}

/** The text a range covers. */
function covered(text: string, range: Range): string {
  const lines = text.split('\n');
  assert.equal(range.start.line, range.end.line, 'a name is on one line');
  return (lines[range.start.line] ?? '').slice(range.start.character, range.end.character);
}

function result<T>(messages: Message[]): T {
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.ok(message && message.error === undefined, JSON.stringify(message));
  return message.result as T;
}

function textOf(uri: string): string {
  return uri === A_URI ? A : B;
}

/** Each location as "file:line:text". */
function shown(locations: readonly Location[]): string[] {
  return locations.map(location => `${location.uri === A_URI ? 'a' : 'b'}:${location.range.start.line}:${covered(textOf(location.uri), location.range)}`).sort();
}

test('initialize names the project and says what is served; a request before it is refused', { skip: SKIP }, async () => {
  const [before] = await session([request('textDocument/definition', { textDocument: { uri: B_URI }, position: { line: 0, character: 0 } })], { initialize: false });
  assert.equal(before?.[0]?.error?.code, -32002);
  const [initialized] = await session([request('initialize', { capabilities: {}, initializationOptions: { config: '/project/tsconfig.json', libDir: '/lib' } })], { initialize: false });
  const capabilities = (result<{ capabilities: Record<string, unknown> }>(initialized ?? [])).capabilities;
  for (const name of ['definitionProvider', 'typeDefinitionProvider', 'referencesProvider', 'documentHighlightProvider', 'hoverProvider']) assert.equal(capabilities[name], true, name);
  assert.deepEqual(capabilities.renameProvider, { prepareProvider: true });
  assert.equal(capabilities.positionEncoding, 'utf-16');
});

test('definition goes from a use in one file to the declaration in another, through the import', { skip: SKIP }, async () => {
  const [call, imported, property, literal] = await session([
    request('textDocument/definition', { textDocument: { uri: B_URI }, position: at(B, 'distance(origin', 0, 3) }),
    request('textDocument/definition', { textDocument: { uri: B_URI }, position: at(B, 'origin, target') }),
    request('textDocument/definition', { textDocument: { uri: B_URI }, position: at(B, 'target.y', 0, 7) }),
    // The name of a property in an object literal that is a Point: Point's property.
    request('textDocument/definition', { textDocument: { uri: A_URI }, position: at(A, '{ x: 0', 0, 2) }),
  ]);
  assert.deepEqual(shown(result<Location[]>(call ?? [])), ['a:5:distance']);
  assert.deepEqual(shown(result<Location[]>(imported ?? [])), ['a:9:origin']);
  assert.deepEqual(shown(result<Location[]>(property ?? [])), ['a:2:y']);
  assert.deepEqual(shown(result<Location[]>(literal ?? [])), ['a:1:x']);
});

test('type definition goes to the declaration of the type', { skip: SKIP }, async () => {
  const [typed] = await session([request('textDocument/typeDefinition', { textDocument: { uri: B_URI }, position: at(B, 'target)') })]);
  assert.deepEqual(shown(result<Location[]>(typed ?? [])), ['a:0:Point']);
});

test('references find a function across files, with or without its declaration', { skip: SKIP }, async () => {
  const [all, uses] = await session([
    request('textDocument/references', { textDocument: { uri: A_URI }, position: at(A, 'distance'), context: { includeDeclaration: true } }),
    request('textDocument/references', { textDocument: { uri: A_URI }, position: at(A, 'distance'), context: { includeDeclaration: false } }),
  ]);
  assert.deepEqual(shown(result<Location[]>(all ?? [])), ['a:5:distance', 'b:0:distance', 'b:4:distance']);
  assert.deepEqual(shown(result<Location[]>(uses ?? [])), ['b:0:distance', 'b:4:distance']);
});

test("references of an interface's property include accesses, object literals, a shorthand and a destructuring", { skip: SKIP }, async () => {
  const [ofX, ofY] = await session([
    request('textDocument/references', { textDocument: { uri: A_URI }, position: at(A, 'x: number'), context: { includeDeclaration: true } }),
    request('textDocument/references', { textDocument: { uri: A_URI }, position: at(A, 'y: number'), context: { includeDeclaration: true } }),
  ]);
  // Point.x: its declaration, a.x and b.x, `{ x: 0 }` in a.ts and `{ x, ... }` in b.ts.
  assert.deepEqual(shown(result<Location[]>(ofX ?? [])), ['a:1:x', 'a:6:x', 'a:6:x', 'a:9:x', 'b:3:x']);
  // Point.y: its declaration, a.y and b.y, `y: 0`, `y: 4`, `const { y }` and target.y.
  assert.deepEqual(shown(result<Location[]>(ofY ?? [])), ['a:2:y', 'a:6:y', 'a:6:y', 'a:9:y', 'b:3:y', 'b:5:y', 'b:6:y']);
});

test('document highlights are the references in the file, a declaration written and a use read', { skip: SKIP }, async () => {
  const [highlights] = await session([request('textDocument/documentHighlight', { textDocument: { uri: B_URI }, position: at(B, 'target:') })]);
  const found = result<{ range: Range; kind: number }[]>(highlights ?? []).map(h => `${h.range.start.line}:${covered(B, h.range)}:${h.kind}`).sort();
  assert.deepEqual(found, ['3:target:3', '4:target:2', '5:target:2', '6:target:2']);
});

function applied(text: string, edits: readonly TextEdit[]): string {
  const lines = text.split('\n');
  const offset = (position: Position): number => lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
  return [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))
    .reduce((current, edit) => current.slice(0, offset(edit.range.start)) + edit.newText + current.slice(offset(edit.range.end)), text);
}

test("renaming an interface's property renames every use, writing a shorthand and a destructuring out", { skip: SKIP }, async () => {
  const [prepared, renamed] = await session([
    request('textDocument/prepareRename', { textDocument: { uri: A_URI }, position: at(A, 'y: number') }),
    request('textDocument/rename', { textDocument: { uri: A_URI }, position: at(A, 'y: number'), newName: 'vertical' }),
  ]);
  const prepare = result<{ range: Range; placeholder: string }>(prepared ?? []);
  assert.equal(prepare.placeholder, 'y');
  const changes = result<{ changes: Record<string, TextEdit[]> }>(renamed ?? []).changes;
  assert.equal(applied(A, changes[A_URI] ?? []), A.replace('y: number', 'vertical: number').replace('a.y - b.y', 'a.vertical - b.vertical').replace('y: 0', 'vertical: 0'));
  assert.equal(applied(B, changes[B_URI] ?? []), B.replace('y: 4', 'vertical: 4').replace('const { y }', 'const { vertical: y }').replace('target.y', 'target.vertical'));
});

test('renaming a variable used in a shorthand keeps the property', { skip: SKIP }, async () => {
  const [renamed] = await session([request('textDocument/rename', { textDocument: { uri: B_URI }, position: at(B, 'x = 3'), newName: 'across' })]);
  const changes = result<{ changes: Record<string, TextEdit[]> }>(renamed ?? []).changes;
  assert.deepEqual(Object.keys(changes), [B_URI]);
  assert.equal(applied(B, changes[B_URI] ?? []), B.replace('const x = 3', 'const across = 3').replace('{ x, y: 4 }', '{ x: across, y: 4 }'));
});

test('a rename across files renames the import, and what cannot be renamed is refused', { skip: SKIP }, async () => {
  const [renamed, library, invalid] = await session([
    request('textDocument/rename', { textDocument: { uri: B_URI }, position: at(B, 'distance(origin'), newName: 'length' }),
    request('textDocument/prepareRename', { textDocument: { uri: A_URI }, position: at(A, 'hypot') }),
    request('textDocument/rename', { textDocument: { uri: A_URI }, position: at(A, 'distance'), newName: 'class' }),
  ]);
  const changes = result<{ changes: Record<string, TextEdit[]> }>(renamed ?? []).changes;
  assert.equal(applied(A, changes[A_URI] ?? []), A.replace('function distance', 'function length'));
  assert.equal(applied(B, changes[B_URI] ?? []), B.replace('{ distance,', '{ length,').replace('distance(origin', 'length(origin'));
  assert.match(library?.[0]?.error?.message ?? '', /standard TypeScript library/u);
  assert.match(invalid?.[0]?.error?.message ?? '', /not a valid name/u);
});

test('an incremental change is applied before the next question', { skip: SKIP }, async () => {
  // Rename the declaration `origin` to `start` by an edit, then ask where `start` (the use in b.ts, edited too) is defined.
  const originAt = at(A, 'origin');
  const useAt = at(B, 'origin, target');
  const [, , definition] = await session([
    { jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: A_URI, version: 2 }, contentChanges: [{ range: { start: originAt, end: { line: originAt.line, character: originAt.character + 'origin'.length } }, text: 'start' }] } },
    { jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: B_URI, version: 2 }, contentChanges: [{ text: B.replace(/origin/gu, 'start') }] } },
    request('textDocument/definition', { textDocument: { uri: B_URI }, position: useAt }),
  ]);
  const locations = result<Location[]>(definition ?? []);
  assert.equal(locations.length, 1);
  assert.deepEqual(locations[0]?.range.start, originAt);
  assert.equal(locations[0]?.range.end.character, originAt.character + 'start'.length);
});

test('hover answers in markdown, and an unknown method is refused', { skip: SKIP }, async () => {
  const [hover, unknown] = await session([
    request('textDocument/hover', { textDocument: { uri: B_URI }, position: at(B, 'target:') }),
    request('textDocument/frobnicate', {}),
  ]);
  const contents = result<{ contents: { kind: string; value: string } }>(hover ?? []).contents;
  assert.equal(contents.kind, 'markdown');
  assert.match(contents.value, /target: Point/u);
  assert.equal(unknown?.[0]?.error?.code, -32601);
});

const C = `import { distance as dist, type Point } from './a';

enum Shape { Round, Square }

namespace Geometry {
  export const unit = 1;
}

class Walker {
  #steps = 0;
  speed = Geometry.unit;
  walk(to: Point): number {
    this.#steps += 1;
    return dist({ x: 0, y: 0 }, to) * this.speed;
  }
}

export const walked = new Walker().walk({ x: 1, y: 1 }) + Shape.Square;
`;

test('an import that renames, class members, a private name, an enum member and a namespace member', { skip: SKIP }, async () => {
  const C_URI = 'file:///project/c.ts';
  const config = { path: '/project/tsconfig.json', text: CONFIG.replace('"/project/b.ts"]', '"/project/b.ts","/project/c.ts"]') };
  const open = { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: C_URI, languageId: 'typescript', version: 1, text: C } } };
  const configChange = { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///project/tsconfig.json', languageId: 'json', version: 1, text: config.text } } };
  const [, , dist, renameDistance, steps, speed, square, unit] = await session([
    configChange,
    open,
    request('textDocument/references', { textDocument: { uri: C_URI }, position: at(C, 'dist(') , context: { includeDeclaration: true } }),
    request('textDocument/rename', { textDocument: { uri: A_URI }, position: at(A, 'distance'), newName: 'length' }),
    request('textDocument/references', { textDocument: { uri: C_URI }, position: at(C, '#steps', 0, 1), context: { includeDeclaration: true } }),
    request('textDocument/definition', { textDocument: { uri: C_URI }, position: at(C, 'this.speed', 0, 5) }),
    request('textDocument/definition', { textDocument: { uri: C_URI }, position: at(C, 'Shape.Square', 0, 6) }),
    request('textDocument/references', { textDocument: { uri: C_URI }, position: at(C, 'unit = 1'), context: { includeDeclaration: true } }),
  ]);
  const line = (location: Location): string => {
    const text = location.uri === C_URI ? C : textOf(location.uri);
    return `${location.uri.slice('file:///project/'.length, -'.ts'.length)}:${location.range.start.line}:${covered(text, location.range)}`;
  };
  // `dist` is `distance`: its references are distance's, under both names.
  assert.deepEqual(result<Location[]>(dist ?? []).map(line).sort(), ['a:5:distance', 'b:0:distance', 'b:4:distance', 'c:0:dist', 'c:0:distance', 'c:13:dist']);
  // Renaming distance renames c.ts's import of it, and not the name it is imported as.
  const edits = result<{ changes: Record<string, TextEdit[]> }>(renameDistance ?? []).changes[C_URI] ?? [];
  assert.equal(applied(C, edits), C.replace('{ distance as dist', '{ length as dist'));
  assert.deepEqual(result<Location[]>(steps ?? []).map(line).sort(), ['c:12:#steps', 'c:9:#steps']);
  assert.deepEqual(result<Location[]>(speed ?? []).map(line), ['c:10:speed']);
  assert.deepEqual(result<Location[]>(square ?? []).map(line), ['c:2:Square']);
  assert.deepEqual(result<Location[]>(unit ?? []).map(line).sort(), ['c:10:unit', 'c:5:unit']);
});
