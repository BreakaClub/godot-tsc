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

/**
 * A session with the service's language server, for one project. `initialize` names the project; then the other calls ask what an editor
 * asks. The documents are the host's files: `open` and `change` set a file's text as `setFile` does, through the server.
 */
export class LspSession {
  private readonly host: TscHost;
  private readonly project: ProjectOptions;
  private nextId = 1;

  constructor(host: TscHost, project: ProjectOptions) {
    this.host = host;
    this.project = project;
  }

  /** Starts the session. Resolves with the server's capabilities. */
  async initialize(scope?: RequestScope): Promise<Record<string, unknown>> {
    const result = await this.request<{ capabilities: Record<string, unknown> }>('initialize', {
      processId: null, rootUri: null, capabilities: {}, initializationOptions: { config: this.project.config, libDir: this.project.libDir },
    }, scope);
    await this.notify('initialized', {});
    return result.capabilities;
  }

  /** Sends a request and resolves with its result, or fails with `LspError`. */
  async request<T>(method: string, params: unknown, scope?: RequestScope): Promise<T> {
    const id = this.nextId++;
    const messages = await this.host.lsp({ jsonrpc: '2.0', id, method, params }, scope);
    const response = messages.find(message => message.id === id && message.method === undefined);
    if (response === undefined) throw new Error(`The language server did not answer ${method}`);
    if (response.error !== undefined) throw new LspError(response.error.code, response.error.message);
    return response.result as T;
  }

  /** Sends a notification. */
  async notify(method: string, params: unknown, scope?: RequestScope): Promise<void> {
    await this.host.lsp({ jsonrpc: '2.0', method, params }, scope);
  }

  /** Opens the file at `path` with `text` (which becomes the file's text). */
  open(path: string, text: string, scope?: RequestScope): Promise<void> {
    return this.notify('textDocument/didOpen', { textDocument: { uri: fileUri(path), languageId: languageOf(path), version: 1, text } }, scope);
  }

  /** Replaces the text of the file at `path`. */
  change(path: string, text: string, version: number, scope?: RequestScope): Promise<void> {
    return this.notify('textDocument/didChange', { textDocument: { uri: fileUri(path), version }, contentChanges: [{ text }] }, scope);
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
