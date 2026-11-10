// Reads Bun's bundle of TypeScript's lib files (`typescript_libs.bin`, which this package ships as `godot-tsc/typescript_libs.bin`).
//
// The bundle is a `u32` count, that many 52-byte records (name length, a 39-byte name, the frame's start and length, its dictionary),
// then the files, each a zstd frame of its own (Bun's `src/runtime/cli/typescript_libs.rs`). Two of the files are the others'
// dictionaries; `node:zlib` decompresses with a dictionary from Node 24.
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const NAME_LENGTH = 39;
const U32 = 4;
const RECORD_LENGTH = 1 + NAME_LENGTH + U32 + U32 + U32;
/** The files that are the others' dictionaries; a record's dictionary is 1 or 2, or 0 for none. */
const DICTIONARIES = ['lib.es5.d.ts', 'lib.dom.d.ts'];
const NODE_WITH_ZSTD_DICTIONARIES = 24;

/** Every file of the bundle at `file`: its name (`lib.es2022.d.ts`) to its text. */
export function readLibBundle(file) {
  if (Number(process.versions.node.split('.')[0]) < NODE_WITH_ZSTD_DICTIONARIES) {
    throw new Error(`Reading Bun's lib bundle needs Node ${NODE_WITH_ZSTD_DICTIONARIES} or newer (zstd dictionaries in node:zlib); this is ${process.version}`);
  }
  const bundle = readFileSync(file);
  const count = bundle.readUInt32LE(0);
  const records = Array.from({ length: count }, (_, index) => {
    const record = bundle.subarray(U32 + index * RECORD_LENGTH, U32 + (index + 1) * RECORD_LENGTH);
    const start = record.readUInt32LE(1 + NAME_LENGTH);
    const frame = bundle.subarray(start, start + record.readUInt32LE(1 + NAME_LENGTH + U32));
    return { name: record.subarray(1, 1 + record[0]).toString('utf8'), frame, dictionary: record.readUInt32LE(1 + NAME_LENGTH + U32 + U32) };
  });
  const dictionaries = DICTIONARIES.map(name => {
    const record = records.find(entry => entry.name === name);
    if (!record) throw new Error(`${file} has no ${name}`);
    return zstdDecompressSync(record.frame);
  });
  const texts = new Map();
  for (const record of records) {
    if (record.dictionary === 0) {
      texts.set(record.name, zstdDecompressSync(record.frame).toString('utf8'));
      continue;
    }
    const dictionary = dictionaries[record.dictionary - 1];
    if (!dictionary) throw new Error(`${record.name} names dictionary ${record.dictionary}, which ${file} does not have`);
    texts.set(record.name, zstdDecompressSync(record.frame, { dictionary }).toString('utf8'));
  }
  return texts;
}

/** The lib files `roots` need: the roots and every file they reach through `/// <reference lib="..." />`. */
export function libClosure(texts, roots) {
  const needed = new Map();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop();
    if (needed.has(name)) continue;
    const text = texts.get(name);
    if (text === undefined) throw new Error(`The lib bundle has no ${name}`);
    needed.set(name, text);
    for (const match of text.matchAll(/^\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/gm)) pending.push(`lib.${match[1].toLowerCase()}.d.ts`);
  }
  return needed;
}
