import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseTranspileResult, type TranspileResult } from '../src/protocol';

// What Bun's parser and printer, and the lowering pass of core/lower.rs, make of the shapes a module can take: a function body
// that JavaScript parses, whose imports and exports are the ones the source names. Needs `pnpm build:native --cli`.

const CLI = resolve(__dirname, '..', 'target/release/godot-tsc-cli');
const NEEDS_CLI = existsSync(CLI) ? false : 'godot-tsc-cli is not built: run `pnpm build:native --cli`';
const FRAME_HEADER_BYTES = 4;

function compile(source: string, path = '/app.tsx', refresh = true): TranspileResult {
  const body = Buffer.from(JSON.stringify({ op: 'transpile', path, source, refresh }));
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32LE(body.length);
  const reply = spawnSync(CLI, [], { input: Buffer.concat([header, body]), maxBuffer: 64 * 1024 * 1024 });
  assert.equal(reply.status, 0);
  return parseTranspileResult(reply.stdout.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + reply.stdout.readUInt32LE(0)).toString('utf8'));
}

/** The compiled module, parsed as the registry will run it. */
function compiled(source: string): { readonly code: string; readonly imports: readonly string[]; readonly exports: readonly string[] } {
  const result = compile(source);
  assert.ok(result.ok, result.ok ? '' : result.diagnostics.map(diagnostic => diagnostic.message).join('; '));
  assert.doesNotThrow(() => new Function('require', 'exports', 'module', '$RefreshReg$', '$RefreshSig$', result.code));
  return result;
}

test('a component with hooks is instrumented for Fast Refresh and its default export is a getter on exports', { skip: NEEDS_CLI }, () => {
  const result = compiled(`import { useState } from 'react';\nexport default function Counter() { const [n] = useState(0); return <b>{n}</b>; }\n`);
  assert.deepEqual(result.imports, ['react/jsx-runtime', 'react']);
  assert.deepEqual(result.exports, ['default']);
  assert.match(result.code, /\$RefreshSig\$\(\)/u);
  assert.match(result.code, /\$RefreshReg\$\(/u);
  assert.match(result.code, /get: \(\) => /u);
  assert.doesNotMatch(result.code, /^(import|export) /mu, 'no module syntax is left');
});

test('imported names are read off the module at the time of the use: live bindings', { skip: NEEDS_CLI }, () => {
  const { code } = compiled(`import { View } from 'godot-react-ui';\nexport const C = () => <View />;\n`);
  assert.match(code, /_godot_react_ui\.View/u);
  assert.doesNotMatch(code, /const \{[^}]*View/u);
});

test('arrow components, memo and forwardRef, class and default expressions, re-exports and namespaces compile', { skip: NEEDS_CLI }, () => {
  assert.deepEqual(compiled(`export default () => <div />;`).exports, ['default']);
  assert.deepEqual(compiled(`export const Foo = () => <><b /></>;`).exports, ['Foo']);
  assert.deepEqual(compiled(`import { memo, forwardRef } from 'react'; export const A = memo(function A() { return <i />; }); export const B = forwardRef((p, r) => <u ref={r} />);`).exports, ['A', 'B']);
  assert.deepEqual(compiled(`export default class Foo { x = 1; static y = 2; }`).exports, ['default']);
  assert.deepEqual(compiled(`const v = 1; export default v + 1;`).exports, ['default']);
  const reexports = compiled(`export { x as y } from './m'; export * from './n'; export * as ns from './o'; import def, { a as b } from './p'; export { def, b };`);
  assert.deepEqual(reexports.exports, ['y', 'ns', 'def', 'b']);
  assert.deepEqual(reexports.imports, ['./m', './n', './o', './p']);
  assert.deepEqual(compiled(`import './side'; import * as lib from 'godot-react-ui'; export const v = lib.View;`).imports, ['./side', 'godot-react-ui']);
});

test('TypeScript is stripped: types, enums\' declarations, satisfies and unused type imports', { skip: NEEDS_CLI }, () => {
  const { code, imports } = compiled(`import type { T } from './t';\ninterface P { a: number }\nconst p = { a: 1 } satisfies P;\nexport const q: P = p as P;\nexport enum E { A, B }\n`);
  assert.deepEqual(imports, []);
  assert.doesNotMatch(code, /interface|satisfies|: P/u);
});

test('a module that reads the global Object compiles, and its exports are defined on that same Object', { skip: NEEDS_CLI }, () => {
  // The parser puts a name nothing declares in the module scope, unbound: it is the global, not a binding the pass's `Object` would collide with.
  const { code } = compiled(`export const keys = Object.keys({ a: 1, b: 2 });\n`);
  assert.match(code, /\bObject\.defineProperty\(exports/u);
  assert.doesNotMatch(code, /\bObject\d/u, 'the pass reads the global by its own name, not a renamed one');
  const exports: Record<string, unknown> = {};
  new Function('require', 'exports', 'module', '$RefreshReg$', '$RefreshSig$', code)(() => ({}), exports, { exports }, () => {}, () => () => {});
  assert.deepEqual(exports.keys, ['a', 'b']);
});

test('a module-level binding named Object is still a diagnostic: the pass would read it in place of the global', { skip: NEEDS_CLI }, () => {
  const declared = compile(`const Object = { keys: () => [] };\nexport const keys = Object.keys({ a: 1 });\n`);
  assert.ok(!declared.ok && /`Object` collides/u.test(declared.diagnostics[0]?.message ?? ''), JSON.stringify(declared));
});

test('what a function body cannot say is a diagnostic: import.meta and top-level await', { skip: NEEDS_CLI }, () => {
  const meta = compile(`export const u = import.meta.url;`);
  assert.ok(!meta.ok && /import\.meta/u.test(meta.diagnostics[0]?.message ?? ''));
  const wait = compile(`export const x = await Promise.resolve(1);`);
  assert.ok(!wait.ok);
});

test('a syntax error has UTF-16 offsets, line and character, with a pair of code units before it', { skip: NEEDS_CLI }, () => {
  const text = `export const label = '\u{1F600}';\nexport const broken = ;\n`;
  const result = compile(text);
  assert.ok(!result.ok);
  const [diagnostic] = result.diagnostics;
  assert.ok(diagnostic);
  assert.equal(diagnostic.severity, 'error');
  assert.equal(diagnostic.start, text.indexOf(';\n', text.indexOf('broken')), 'the offset counts the emoji as two code units, as a JavaScript string index does');
  assert.equal(diagnostic.line, 1);
  assert.equal(diagnostic.character, 'export const broken = '.length);
});

test('compiling without Fast Refresh leaves the components alone', { skip: NEEDS_CLI }, () => {
  const result = compile(`import { useState } from 'react';\nexport function A() { const [n] = useState(0); return <b>{n}</b>; }\n`, '/a.tsx', false);
  assert.ok(result.ok);
  assert.doesNotMatch(result.code, /\$Refresh/u);
});
