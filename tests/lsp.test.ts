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
  for (const name of ['definitionProvider', 'typeDefinitionProvider', 'referencesProvider', 'documentHighlightProvider', 'hoverProvider', 'inlayHintProvider']) assert.equal(capabilities[name], true, name);
  assert.deepEqual(capabilities.completionProvider, { triggerCharacters: ['.'] });
  assert.deepEqual(capabilities.signatureHelpProvider, { triggerCharacters: ['(', ','] });
  assert.deepEqual(capabilities.diagnosticProvider, { interFileDependencies: true, workspaceDiagnostics: true });
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
  const { contents, range } = result<{ contents: { kind: string; value: string }; range: Range }>(hover ?? []);
  assert.equal(contents.kind, 'markdown');
  assert.equal(contents.value, '```typescript\ntarget: Point\n```');
  // The range is the name's.
  assert.deepEqual(range, { start: at(B, 'target:'), end: at(B, 'target:', 0, 'target'.length) });
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

/** A full change of b.ts to `text`, as a notification. */
function changeB(text: string, version = 2): object {
  return { jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: B_URI, version }, contentChanges: [{ text }] } };
}

interface CompletionList { readonly items: readonly { readonly label: string; readonly kind: number; readonly detail?: string; readonly sortText: string; readonly textEdit: { readonly range: Range } }[] }

test("completion after a dot lists the properties of the expression's type, with their types, replacing what is typed", { skip: SKIP }, async () => {
  const dotted = `${B}export const w = target.;\n`;
  const typing = `${B}export const v = target.y;\n`;
  const [, afterDot, , typed] = await session([
    changeB(dotted),
    request('textDocument/completion', { textDocument: { uri: B_URI }, position: at(dotted, 'target.;', 0, 'target.'.length) }),
    changeB(typing, 3),
    request('textDocument/completion', { textDocument: { uri: B_URI }, position: at(typing, 'v = target.y;', 0, 'v = target.y'.length) }),
  ]);
  const members = result<CompletionList>(afterDot ?? []).items;
  assert.deepEqual(members.map(item => `${item.label}:${item.kind}:${item.detail ?? ''}`), ['x:10:number', 'y:10:number']);
  const replacing = result<CompletionList>(typed ?? []).items;
  assert.deepEqual(replacing.map(item => item.label), ['x', 'y']);
  // The item replaces the `y` being typed.
  const line = typing.split('\n').length - 2;
  assert.deepEqual(replacing[0]?.textEdit.range, { start: { line, character: 'export const v = target.'.length }, end: { line, character: 'export const v = target.y'.length } });
});

test('completion elsewhere lists what is in scope: the project first, then the lib files, then keywords; types where a type goes; nothing in a comment', { skip: SKIP }, async () => {
  const text = `${B}const p: Po;\n// in a comment: \n`;
  const [, values, types, comment] = await session([
    changeB(text),
    request('textDocument/completion', { textDocument: { uri: B_URI }, position: at(text, 'export const sum', 0, 'export const '.length) }),
    request('textDocument/completion', { textDocument: { uri: B_URI }, position: at(text, 'Po;', 0, 2) }),
    request('textDocument/completion', { textDocument: { uri: B_URI }, position: at(text, 'comment: ', 0, 'comment: '.length) }),
  ]);
  const inScope = result<CompletionList>(values ?? []).items;
  const sorted = [...inScope].sort((a, b) => a.sortText.localeCompare(b.sortText));
  const index = (label: string): number => sorted.findIndex(item => item.label === label);
  for (const name of ['distance', 'origin', 'target', 'x', 'y', 'Math', 'Array', 'const', 'return']) assert.notEqual(index(name), -1, `${name} is offered`);
  assert.ok(index('distance') < index('Math') && index('Math') < index('const'), 'the project, then the lib files, then keywords');
  assert.equal(inScope.find(item => item.label === 'distance')?.detail, '(a: Point, b: Point) => number');
  assert.equal(inScope.find(item => item.label === 'Point'), undefined, 'a type is not offered where a value goes');
  const typeNames = result<CompletionList>(types ?? []).items.map(item => item.label);
  assert.ok(typeNames.includes('Point') && typeNames.includes('Array'), typeNames.join());
  assert.ok(!typeNames.includes('distance') && !typeNames.includes('const'), 'no values or keywords where a type goes');
  assert.deepEqual(result<CompletionList>(comment ?? []).items, []);
});

interface SignatureHelp { readonly signatures: readonly { readonly label: string; readonly parameters: readonly { readonly label: readonly [number, number] }[] }[]; readonly activeSignature: number; readonly activeParameter: number }

test('signature help names the call the caret is in, and the argument it is at, a rest parameter taking the rest', { skip: SKIP }, async () => {
  const text = `${B}Math.max(1, 2, 3);\n`;
  const [, second, rest, outside] = await session([
    changeB(text),
    request('textDocument/signatureHelp', { textDocument: { uri: B_URI }, position: at(text, 'distance(origin, target)', 0, 'distance(origin, '.length) }),
    request('textDocument/signatureHelp', { textDocument: { uri: B_URI }, position: at(text, 'max(1, 2, 3)', 0, 'max(1, 2, '.length) }),
    request('textDocument/signatureHelp', { textDocument: { uri: B_URI }, position: at(text, 'const x') }),
  ]);
  const help = result<SignatureHelp>(second ?? []);
  const [signature] = help.signatures;
  assert.equal(signature?.label, 'distance(a: Point, b: Point): number');
  assert.deepEqual(signature?.parameters.map(parameter => signature.label.slice(...parameter.label)), ['a: Point', 'b: Point']);
  assert.equal(help.activeParameter, 1);
  const max = result<SignatureHelp>(rest ?? []);
  assert.equal(max.signatures[max.activeSignature]?.label, 'max(...values: number[]): number');
  assert.equal(max.activeParameter, 0);
  assert.equal(result<SignatureHelp | null>(outside ?? []), null);
});

test('inlay hints are the inferred types of declarations that name none, after the name', { skip: SKIP }, async () => {
  const lines = B.split('\n').length;
  const [hints] = await session([request('textDocument/inlayHint', { textDocument: { uri: B_URI }, range: { start: { line: 0, character: 0 }, end: { line: lines, character: 0 } } })]);
  const found = result<{ position: Position; label: string; kind: number }[]>(hints ?? []);
  assert.deepEqual(found.map(hint => `${hint.position.line}:${hint.position.character}:${hint.label}:${hint.kind}`), [
    `${at(B, 'd =').line}:${at(B, 'd =').character + 1}:: number:1`,
    `${at(B, 'sum =').line}:${at(B, 'sum =').character + 3}:: number:1`,
  ]);
});

interface Diagnostic { readonly range: Range; readonly severity: number; readonly code: number; readonly source: string; readonly message: string }

test('diagnostics: a file\'s, and every source\'s, with the clean ones listed empty', { skip: SKIP }, async () => {
  const text = `${B}const bad: string = d;\n`;
  const [, document, workspace] = await session([
    changeB(text),
    request('textDocument/diagnostic', { textDocument: { uri: B_URI } }),
    request('workspace/diagnostic', { previousResultIds: [] }),
  ]);
  const report = result<{ kind: string; items: Diagnostic[] }>(document ?? []);
  assert.equal(report.kind, 'full');
  assert.deepEqual(report.items.map(d => [d.code, d.severity, d.source, covered(text, d.range)]), [[2322, 1, 'ts', 'bad']]);
  assert.match(report.items[0]?.message ?? '', /Type 'number' is not assignable to type 'string'/u);
  const all = result<{ items: { uri: string; kind: string; items: Diagnostic[] }[]; filesLoaded: number }>(workspace ?? []);
  assert.deepEqual(all.items.map(item => [item.uri, item.items.length]).sort(), [[A_URI, 0], [B_URI, 1]]);
  assert.ok(all.filesLoaded > 2);
});

test('one service serves several projects, a server per session, and exit ends a session', { skip: SKIP }, async () => {
  const other = 'export const other = 1;\nexport const twice = other * 2;\n';
  const files = [
    ...await libFiles(), { path: '/project/tsconfig.json', text: CONFIG }, { path: '/project/a.ts', text: A }, { path: '/project/b.ts', text: B },
    { path: '/other/tsconfig.json', text: JSON.stringify({ compilerOptions: { lib: ['es2022'], strict: true }, files: ['/other/x.ts'] }) },
    { path: '/other/x.ts', text: other },
  ];
  const initialize = (config: string) => ({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {}, initializationOptions: { config, libDir: '/lib' } } });
  const definition = (uri: string, position: Position) => ({ jsonrpc: '2.0', id: 1, method: 'textDocument/definition', params: { textDocument: { uri }, position } });
  const frames = [
    { op: 'setFiles', files },
    { op: 'lsp', session: 'one', message: initialize('/project/tsconfig.json') },
    { op: 'lsp', session: 'two', message: definition('file:///other/x.ts', at(other, 'other * 2')) },
    { op: 'lsp', session: 'two', message: initialize('/other/tsconfig.json') },
    { op: 'lsp', session: 'two', message: definition('file:///other/x.ts', at(other, 'other * 2')) },
    { op: 'lsp', session: 'one', message: definition(B_URI, at(B, 'distance(origin')) },
    { op: 'lsp', session: 'two', message: { jsonrpc: '2.0', method: 'exit' } },
    { op: 'lsp', session: 'two', message: definition('file:///other/x.ts', at(other, 'other * 2')) },
  ];
  const reply = spawnSync(CLI, [], { input: Buffer.concat(frames.map(frame)), maxBuffer: 64 * 1024 * 1024 });
  assert.equal(reply.status, 0, reply.stderr.toString());
  const answers: Message[][] = [];
  for (let offset = 0; offset < reply.stdout.length;) {
    const length = reply.stdout.readUInt32LE(offset);
    const parsed = JSON.parse(reply.stdout.subarray(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + length).toString('utf8'));
    answers.push(parsed.messages ?? []);
    offset += FRAME_HEADER_BYTES + length;
  }
  const [, , beforeInitialize, , inTwo, inOne, , afterExit] = answers;
  // Session two is a server of its own: not initialized by session one's initialize, and gone after its exit.
  assert.equal(beforeInitialize?.[0]?.error?.code, -32002);
  assert.deepEqual(result<Location[]>(inTwo ?? []).map(l => [l.uri, l.range.start]), [['file:///other/x.ts', at(other, 'other = 1')]]);
  assert.deepEqual(shown(result<Location[]>(inOne ?? [])), ['a:5:distance']);
  assert.equal(afterExit?.[0]?.error?.code, -32002);
});
