/**
 * What godot-tsc's library says, as data (`core/protocol.rs`, `check.rs`): the extension answers in JSON text, and these are the
 * shapes it is read into. A reply that is none of them is an error, not a value (`parse*` throw). The wire's names (a reply's
 * `kind`, `compile` for a transpile) are the library's; the types here are named for what they are.
 */

export type Severity = 'error' | 'warning';

/** A syntax error (or warning) the transpiler found: positions in UTF-16 code units, as a JavaScript string index is; `line` and `character` count from 0. */
export interface SyntaxDiagnostic {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly character: number;
  readonly severity: Severity;
  readonly message: string;
}

export interface Transpiled {
  readonly ok: true;
  /** A function body: `require`, `exports`, `module`, `$RefreshReg$` and `$RefreshSig$` are its free identifiers. */
  readonly code: string;
  /** The specifiers it requires, once each, in order. */
  readonly imports: readonly string[];
  readonly exports: readonly string[];
  readonly diagnostics: readonly SyntaxDiagnostic[];
}

export interface TranspileFailed {
  readonly ok: false;
  readonly diagnostics: readonly SyntaxDiagnostic[];
}

export type TranspileResult = Transpiled | TranspileFailed;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isSyntaxDiagnostic(value: unknown): value is SyntaxDiagnostic {
  return isRecord(value) && typeof value.start === 'number' && typeof value.end === 'number' && typeof value.line === 'number'
    && typeof value.character === 'number' && (value.severity === 'error' || value.severity === 'warning') && typeof value.message === 'string';
}

function diagnosticsOf(value: unknown): SyntaxDiagnostic[] {
  if (!Array.isArray(value) || !value.every(isSyntaxDiagnostic)) throw new Error('A reply of the compiler has diagnostics that are not diagnostics');
  return value;
}

/** The transpiler's answer, as the service's JSON had it (a `compile` reply's `result`). */
export function transpileResultOf(reply: unknown): TranspileResult {
  if (!isRecord(reply)) throw new Error(`The compiler's reply is not an object: ${JSON.stringify(reply)?.slice(0, 200)}`);
  if (reply.ok === true) {
    const { code, imports, exports } = reply;
    if (typeof code !== 'string' || !isStringArray(imports) || !isStringArray(exports)) throw new Error('The compiler said ok without code, imports and exports');
    return { ok: true, code, imports, exports, diagnostics: diagnosticsOf(reply.diagnostics) };
  }
  return { ok: false, diagnostics: diagnosticsOf(reply.diagnostics) };
}

export function parseTranspileResult(json: string): TranspileResult {
  return transpileResultOf(JSON.parse(json));
}

/** What `ping` says: the library's name and the Bun revision its parser and printer come from. */
export interface Pong {
  readonly name: string;
  readonly bunRevision: string;
}

/** A reply `poll` handed over: the id of the request it answers, and what came of it. */
export type Reply =
  | { readonly id: number; readonly kind: 'query'; readonly serviceMs: number; readonly result: Record<string, unknown> }
  | { readonly id: number; readonly kind: 'compile'; readonly serviceMs: number; readonly result: TranspileResult }
  | { readonly id: number; readonly kind: 'ping'; readonly serviceMs: number; readonly result: Pong }
  | { readonly id: number; readonly kind: 'stall'; readonly serviceMs: number };

export function parseReply(json: string): Reply {
  const reply: unknown = JSON.parse(json);
  if (!isRecord(reply) || typeof reply.id !== 'number') throw new Error(`A reply of the service is not one: ${json.slice(0, 200)}`);
  const { id } = reply;
  const serviceMs = typeof reply.ms === 'number' ? reply.ms : 0;
  switch (reply.kind) {
    case 'query':
      if (!isRecord(reply.result)) throw new Error('A query has no result');
      return { id, kind: 'query', serviceMs, result: reply.result };
    case 'compile':
      return { id, kind: 'compile', serviceMs, result: transpileResultOf(reply.result) };
    case 'ping':
      if (!isRecord(reply.result) || typeof reply.result.name !== 'string' || typeof reply.result.bunRevision !== 'string') throw new Error('A ping has no name and revision');
      return { id, kind: 'ping', serviceMs, result: { name: reply.result.name, bunRevision: reply.result.bunRevision } };
    case 'stall':
      return { id, kind: 'stall', serviceMs };
    default:
      throw new Error(`A reply of the service is not one: ${json.slice(0, 200)}`);
  }
}

/** A Language Server Protocol message: a JSON-RPC request, notification or response. */
export interface LspMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

function isLspMessage(value: unknown): value is LspMessage {
  return isRecord(value) && value.jsonrpc === '2.0';
}

/** The messages the language server sent back for one message (`{"op":"lsp"}`): the response to a request among them. */
export function parseLspMessages(result: Record<string, unknown>): LspMessage[] {
  if (result.ok !== true) {
    const first = Array.isArray(result.diagnostics) ? result.diagnostics[0] : undefined;
    throw new Error(isSyntaxDiagnostic(first) ? first.message : `the language server failed: ${JSON.stringify(result).slice(0, 300)}`);
  }
  const messages = result.messages;
  if (!Array.isArray(messages) || !messages.every(isLspMessage)) throw new Error('The language server answered with something that is not a list of LSP messages');
  return messages;
}

/** What the extension can say of its queue without asking the thread (`GodotTsc.state`). */
export interface ServiceState {
  /** A service object has been made for this host (it is made at the first request or `start`). */
  readonly started: boolean;
  /** The service thread has begun running, and has not ended: in a browser, its worker has started. */
  readonly threadRunning: boolean;
  readonly queued: number;
  /** The id of the request being served, or null. */
  readonly running: number | null;
  /** Replies finished and not yet taken. */
  readonly replies: number;
  /** The service threads running in the whole process. */
  readonly threadsAlive: number;
}

export function parseServiceState(json: string): ServiceState {
  const state: unknown = JSON.parse(json);
  if (!isRecord(state) || typeof state.started !== 'boolean' || typeof state.threadRunning !== 'boolean' || typeof state.queued !== 'number'
    || (state.running !== null && typeof state.running !== 'number') || typeof state.replies !== 'number' || typeof state.threadsAlive !== 'number') {
    throw new Error(`The service's state is not one: ${json.slice(0, 200)}`);
  }
  return { started: state.started, threadRunning: state.threadRunning, queued: state.queued, running: state.running, replies: state.replies, threadsAlive: state.threadsAlive };
}

/** A file of the checker's in-memory project: an absolute path in the checker's format (`/project/app.tsx`) and its text. */
export interface ProjectFile {
  readonly path: string;
  readonly text: string;
}
