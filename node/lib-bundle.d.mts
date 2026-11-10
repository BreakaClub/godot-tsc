/** Every file of Bun's lib bundle at `file` (`godot-tsc/typescript_libs.bin`): its name (`lib.es2022.d.ts`) to its text. Needs Node 24. */
export function readLibBundle(file: string): Map<string, string>;

/** The lib files `roots` need: the roots and every file they reach through `/// <reference lib="..." />`. */
export function libClosure(texts: ReadonlyMap<string, string>, roots: readonly string[]): Map<string, string>;

/** `lib.es2022.d.ts` and the decorators' lib files. */
export const ES2022_LIB_ROOTS: readonly string[];
