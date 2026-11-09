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

/** `DiagnosticCategory` in TypeScript's API. */
export const CATEGORY_ERROR = 1;

export interface Position {
  readonly line: number;
  readonly character: number;
}

/** A diagnostic of the checker, as TypeScript's API gives it: `pos` and `end` are UTF-16 offsets into the file's text. */
export interface CheckDiagnostic {
  readonly fileName?: string;
  readonly pos: number;
  readonly end: number;
  readonly startPosition?: Position;
  readonly endPosition?: Position;
  readonly code: number;
  readonly category: number;
  readonly messageText: string;
}

export interface CheckReport {
  readonly diagnostics: readonly CheckDiagnostic[];
  readonly filesLoaded: number;
  /** The files the check ran out of stack in: their diagnostics may be missing. */
  readonly incomplete: readonly string[];
  readonly deepestStack: number;
}

/** What is under a position: the name there and its type, as TypeScript's quick info has them. `start` and `end` are UTF-16 offsets. */
export interface Hover {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly type: string;
}

/** A hint drawn in the text: the type TypeScript inferred for a declaration (after its name), or the name of the parameter an argument is for (before it). */
export interface InlayHint {
  readonly position: number;
  readonly kind: 'type' | 'parameter';
  readonly label: string;
}

/** Which arguments get their parameter's name: none, the literals, or all but the ones that are the name. */
export type ParameterNames = 'none' | 'literals' | 'all';

/** What a check came to: its report, a failure, or that a newer check took its place before it began. */
export type CheckOutcome =
  | { readonly kind: 'checked'; readonly report: CheckReport; /** The time the service thread took, from its own clock: the answer reaches JavaScript a frame later at the soonest. */ readonly serviceMs: number }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'superseded'; readonly by: number };

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

function isCheckDiagnostic(value: unknown): value is CheckDiagnostic {
  return isRecord(value) && typeof value.pos === 'number' && typeof value.end === 'number' && typeof value.code === 'number'
    && typeof value.category === 'number' && typeof value.messageText === 'string';
}

function isCheckReport(value: unknown): value is CheckReport {
  return isRecord(value) && Array.isArray(value.diagnostics) && value.diagnostics.every(isCheckDiagnostic) && typeof value.filesLoaded === 'number'
    && isStringArray(value.incomplete) && typeof value.deepestStack === 'number';
}

/** What `ping` says: the library's name and the Bun revision its parser and printer come from. */
export interface Pong {
  readonly name: string;
  readonly bunRevision: string;
}

/** A reply `poll` handed over: the id of the request it answers, and what came of it. */
export type Reply =
  | { readonly id: number; readonly kind: 'check'; readonly outcome: CheckOutcome }
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
    case 'check':
      return parseCheckReply(reply, id);
    default:
      throw new Error(`A reply of the service is not one: ${json.slice(0, 200)}`);
  }
}

function parseCheckReply(reply: Record<string, unknown>, id: number): Reply {
  if (reply.superseded === true) {
    if (typeof reply.by !== 'number') throw new Error('A superseded check says nothing of what superseded it');
    return { id, kind: 'check', outcome: { kind: 'superseded', by: reply.by } };
  }
  const result = reply.result;
  if (!isRecord(result)) throw new Error('A check has no result');
  if (result.ok === true && isCheckReport(result.report) && typeof reply.ms === 'number') {
    return { id, kind: 'check', outcome: { kind: 'checked', report: result.report, serviceMs: reply.ms } };
  }
  const first = Array.isArray(result.diagnostics) ? result.diagnostics[0] : undefined;
  const message = isSyntaxDiagnostic(first) ? first.message : `the check failed: ${JSON.stringify(result).slice(0, 300)}`;
  return { id, kind: 'check', outcome: { kind: 'failed', message } };
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

export function parseHover(result: Record<string, unknown>): Hover | null {
  if (result.ok !== true) throw new Error(`A hover failed: ${JSON.stringify(result).slice(0, 300)}`);
  const hover = result.hover;
  if (hover === null) return null;
  if (!isRecord(hover) || typeof hover.start !== 'number' || typeof hover.end !== 'number' || typeof hover.name !== 'string' || typeof hover.type !== 'string') {
    throw new Error('A hover has no span, name and type');
  }
  return { start: hover.start, end: hover.end, name: hover.name, type: hover.type };
}

export function parseInlayHints(result: Record<string, unknown>): InlayHint[] {
  if (result.ok !== true || !Array.isArray(result.hints)) throw new Error(`Inlay hints failed: ${JSON.stringify(result).slice(0, 300)}`);
  return result.hints.map((hint: unknown): InlayHint => {
    if (!isRecord(hint) || typeof hint.position !== 'number' || (hint.kind !== 'type' && hint.kind !== 'parameter') || typeof hint.label !== 'string') {
      throw new Error('An inlay hint has no position, kind and label');
    }
    return { position: hint.position, kind: hint.kind, label: hint.label };
  });
}
