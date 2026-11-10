// godot-tsc/host: everything in the package but `openTsc`, with no `godot` import anywhere in its graph, so code that drives a `Tsc` can be loaded
// (and tested) under Node. `Tsc` takes any `TscLink`; `openTsc` (the `godot-tsc` entry) is what gives it the extension's.
export { REQUEST_DEADLINE_MS, Tsc, type LspReply, type ProjectOptions, type TranspileOptions, type TscHost, type TscLink } from './tsc';
export { RequestCancelled, RequestScope } from './scope';
export * from './protocol';
export {
  LspError, LspSession, SERVER_CANCELLED, fileUri, pathOfUri, type InlayParameterNames, type LspCompletionItem, type LspCompletionItemKind, type LspCompletionList,
  type LspDiagnostic, type LspDocumentHighlight, type LspInlayHint, type LspLocation, type LspPosition, type LspRange, type LspSignatureHelp,
  type LspSignatureInformation, type LspTextEdit, type LspWorkspaceDiagnostics, type LspWorkspaceEdit,
} from './lsp';
