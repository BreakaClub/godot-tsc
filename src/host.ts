// godot-tsc/host: everything in the package but `openTsc`, with no `godot` import anywhere in its graph, so code that drives a `Tsc` can be loaded
// (and tested) under Node. `Tsc` takes any `TscLink`; `openTsc` (the `godot-tsc` entry) is what gives it the extension's.
export { REQUEST_DEADLINE_MS, Tsc, TscProject, type ProjectOptions, type TextRange, type TranspileOptions, type TscHost, type TscLink } from './tsc';
export { RequestCancelled, RequestScope } from './scope';
export * from './protocol';
export { LspError, LspSession, fileUri, pathOfUri, type LspDocumentHighlight, type LspLocation, type LspPosition, type LspRange, type LspTextEdit, type LspWorkspaceEdit } from './lsp';
