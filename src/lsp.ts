import type { LspMessage } from './protocol';
import type { RequestScope } from './scope';
import type { ProjectOptions, TscHost } from './tsc';

// The language server of the service (`core/lsp.rs`) as calls: `LspSession` gives each request an id, picks its response out of what the
// server sends back and fails with `LspError` when the server refuses. `TscHost.lsp` is the same server, one raw message at a time, for a
// host that relays LSP from elsewhere (an editor over a socket).

/** LSP's position: a line and a character in UTF-16 code units, both from 0. */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

/** A range of a document, which is a `file://` URI of a path of the service's files (`fileUri`). */
export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

export interface LspTextEdit {
  readonly range: LspRange;
  readonly newText: string;
}

/** The edits of a rename, by document. */
export interface LspWorkspaceEdit {
  readonly changes: Readonly<Record<string, readonly LspTextEdit[]>>;
}

/** `DocumentHighlightKind`: 2 is a name read, 3 one that declares. */
export interface LspDocumentHighlight {
  readonly range: LspRange;
  readonly kind: 1 | 2 | 3;
}

/** LSP's `CompletionItemKind`, of the kinds the server gives. */
export type LspCompletionItemKind = 2 | 3 | 4 | 6 | 7 | 8 | 9 | 10 | 13 | 14 | 20 | 25;

export interface LspCompletionItem {
  readonly label: string;
  readonly kind: LspCompletionItemKind;
  /** The type, for what the project declares (the lib files' globals have none). */
  readonly detail?: string;
  /** The order to show the items in: the project's names, then the lib files', then keywords. */
  readonly sortText: string;
  /** What choosing the item does: replace the name being typed. */
  readonly textEdit: LspTextEdit;
}

export interface LspCompletionList {
  readonly isIncomplete: boolean;
  readonly items: readonly LspCompletionItem[];
}

export interface LspSignatureInformation {
  readonly label: string;
  /** Each parameter as the UTF-16 range of the label it is written in. */
  readonly parameters: readonly { readonly label: readonly [number, number] }[];
}

export interface LspSignatureHelp {
  readonly signatures: readonly LspSignatureInformation[];
  readonly activeSignature: number;
  readonly activeParameter: number;
}

/** `InlayHintKind`: 1 is a type, 2 a parameter's name. */
export interface LspInlayHint {
  readonly position: LspPosition;
  readonly label: string;
  readonly kind: 1 | 2;
  readonly paddingRight: boolean;
}

/** `DiagnosticSeverity`: 1 error, 2 warning, 3 information, 4 hint. `code` is TypeScript's (2322). */
export interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity: 1 | 2 | 3 | 4;
  readonly code: number;
  readonly source: 'ts';
  readonly message: string;
  readonly relatedInformation?: readonly { readonly location: LspLocation; readonly message: string }[];
}

/** The diagnostics of every source of the project, and what the check saw: the files it loaded and those it ran out of stack in. */
export interface LspWorkspaceDiagnostics {
  readonly items: readonly { readonly uri: string; readonly kind: 'full'; readonly items: readonly LspDiagnostic[] }[];
  readonly filesLoaded: number;
  readonly incomplete: readonly string[];
}

/** Which arguments inlay hints name: none, the literals (the default), or all but those that are the parameter's name. */
export type InlayParameterNames = 'none' | 'literals' | 'all';

/** LSP's `ServerCancelled`: a diagnostics request that a newer one for the same document replaced before it began. */
export const SERVER_CANCELLED = -32802;

/** A request the language server refused: JSON-RPC's code and the server's message (`-32803`, "You cannot rename this element."). */
export class LspError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'LspError';
    this.code = code;
  }
}

/** The `file://` URI of a path of the service's files: `/project/main.ts` is `file:///project/main.ts`. */
export function fileUri(path: string): string {
  return `file://${path.split('/').map(part => encodeURIComponent(part)).join('/')}`;
}

/** The path of a `file://` URI. */
export function pathOfUri(uri: string): string {
  if (!uri.startsWith('file://')) throw new Error(`${uri} is not a file:// URI`);
  return decodeURIComponent(uri.slice('file://'.length));
}

/** The sessions made by this realm, for their names: each has a server of its own in the service. */
let sessionsMade = 0;

/**
 * A session with a language server of the service, for one project. `initialize` names the project; then the other calls ask what an editor
 * asks. Each session has a server of its own, so sessions for several projects share one `Tsc` (one service thread, one set of files) and
 * none of them initializes twice. The documents are the host's files: `open` and `change` set a file's text as `setFile` does.
 */
export class LspSession {
  private readonly host: TscHost;
  private readonly project: ProjectOptions;
  private readonly inlayParameterNames: InlayParameterNames;
  /** Which of the service's servers this session's messages go to. */
  readonly session: string;
  private nextId = 1;

  constructor(host: TscHost, project: ProjectOptions, options: { readonly inlayParameterNames?: InlayParameterNames } = {}) {
    this.host = host;
    this.project = project;
    this.inlayParameterNames = options.inlayParameterNames ?? 'literals';
    sessionsMade += 1;
    this.session = `session-${sessionsMade}`;
  }

  /** Starts the session. Resolves with the server's capabilities. */
  async initialize(scope?: RequestScope): Promise<Record<string, unknown>> {
    const result = await this.request<{ capabilities: Record<string, unknown> }>('initialize', {
      processId: null, rootUri: null, capabilities: {}, initializationOptions: { config: this.project.config, libDir: this.project.libDir, inlayParameterNames: this.inlayParameterNames },
    }, scope);
    await this.notify('initialized', {});
    return result.capabilities;
  }

  /** Sends a request and resolves with its result, or fails with `LspError`. The request is in the service's queue when the call returns. */
  async request<T>(method: string, params: unknown, scope?: RequestScope): Promise<T> {
    return (await this.requestTimed<T>(method, params, scope)).result;
  }

  /** `request`, with the time the service thread took over it. */
  async requestTimed<T>(method: string, params: unknown, scope?: RequestScope): Promise<{ readonly result: T; readonly serviceMs: number }> {
    const id = this.nextId++;
    const reply = await this.host.lsp({ jsonrpc: '2.0', id, method, params }, scope, this.session);
    const response = reply.messages.find(message => message.id === id && message.method === undefined);
    if (response === undefined) throw new Error(`The language server did not answer ${method}`);
    if (response.error !== undefined) throw new LspError(response.error.code, response.error.message);
    // The server's result has the shape LSP gives this method; `T` names it.
    return { result: response.result as T, serviceMs: reply.serviceMs };
  }

  /** Sends a notification. */
  async notify(method: string, params: unknown, scope?: RequestScope): Promise<void> {
    await this.host.lsp({ jsonrpc: '2.0', method, params }, scope, this.session);
  }

  /** Opens the file at `path` with `text` (which becomes the file's text). */
  open(path: string, text: string, scope?: RequestScope): Promise<void> {
    return this.notify('textDocument/didOpen', { textDocument: { uri: fileUri(path), languageId: languageOf(path), version: 1, text } }, scope);
  }

  /** Replaces the text of the file at `path`. */
  change(path: string, text: string, version: number, scope?: RequestScope): Promise<void> {
    return this.notify('textDocument/didChange', { textDocument: { uri: fileUri(path), version }, contentChanges: [{ text }] }, scope);
  }

  /**
   * The name and type at `position`, or null. `contents.value` is one TypeScript code block, "```typescript\n<name>: <type>\n```", or the
   * type alone where there is no name; `range` is the name's.
   */
  hover(path: string, position: LspPosition, scope?: RequestScope): Promise<{ readonly contents: { readonly kind: 'markdown'; readonly value: string }; readonly range: LspRange } | null> {
    return this.request('textDocument/hover', { textDocument: { uri: fileUri(path) }, position }, scope);
  }

  completion(path: string, position: LspPosition, scope?: RequestScope): Promise<LspCompletionList> {
    return this.request('textDocument/completion', { textDocument: { uri: fileUri(path) }, position }, scope);
  }

  /** The signatures of the call whose arguments `position` is in, or null. */
  signatureHelp(path: string, position: LspPosition, scope?: RequestScope): Promise<LspSignatureHelp | null> {
    return this.request('textDocument/signatureHelp', { textDocument: { uri: fileUri(path) }, position }, scope);
  }

  inlayHints(path: string, range: LspRange, scope?: RequestScope): Promise<LspInlayHint[]> {
    return this.request('textDocument/inlayHint', { textDocument: { uri: fileUri(path) }, range }, scope);
  }

  /**
   * Checks the project, and resolves with the diagnostics of every source and the time the check took. A check that a newer one replaced
   * before it began fails with `LspError` whose code is `SERVER_CANCELLED`.
   */
  workspaceDiagnostics(scope?: RequestScope): Promise<{ readonly result: LspWorkspaceDiagnostics; readonly serviceMs: number }> {
    return this.requestTimed('workspace/diagnostic', { previousResultIds: [] }, scope);
  }

  /** Checks the project, and resolves with the diagnostics of the file at `path`. */
  async diagnostics(path: string, scope?: RequestScope): Promise<LspDiagnostic[]> {
    const report = await this.request<{ readonly items: LspDiagnostic[] }>('textDocument/diagnostic', { textDocument: { uri: fileUri(path) } }, scope);
    return report.items;
  }

  definition(path: string, position: LspPosition, scope?: RequestScope): Promise<LspLocation[]> {
    return this.request('textDocument/definition', { textDocument: { uri: fileUri(path) }, position }, scope);
  }

  typeDefinition(path: string, position: LspPosition, scope?: RequestScope): Promise<LspLocation[]> {
    return this.request('textDocument/typeDefinition', { textDocument: { uri: fileUri(path) }, position }, scope);
  }

  references(path: string, position: LspPosition, includeDeclaration = true, scope?: RequestScope): Promise<LspLocation[]> {
    return this.request('textDocument/references', { textDocument: { uri: fileUri(path) }, position, context: { includeDeclaration } }, scope);
  }

  documentHighlight(path: string, position: LspPosition, scope?: RequestScope): Promise<LspDocumentHighlight[]> {
    return this.request('textDocument/documentHighlight', { textDocument: { uri: fileUri(path) }, position }, scope);
  }

  /** The name under `position` and its range, if it can be renamed; fails with `LspError` saying why it cannot. */
  prepareRename(path: string, position: LspPosition, scope?: RequestScope): Promise<{ readonly range: LspRange; readonly placeholder: string }> {
    return this.request('textDocument/prepareRename', { textDocument: { uri: fileUri(path) }, position }, scope);
  }

  rename(path: string, position: LspPosition, newName: string, scope?: RequestScope): Promise<LspWorkspaceEdit> {
    return this.request('textDocument/rename', { textDocument: { uri: fileUri(path) }, position, newName }, scope);
  }

  /** Ends the session: `shutdown`, then `exit`. */
  async close(scope?: RequestScope): Promise<void> {
    await this.request('shutdown', null, scope);
    await this.notify('exit', null, scope);
  }
}

function languageOf(path: string): string {
  if (path.endsWith('.tsx')) return 'typescriptreact';
  if (path.endsWith('.jsx')) return 'javascriptreact';
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'javascript';
  return 'typescript';
}
