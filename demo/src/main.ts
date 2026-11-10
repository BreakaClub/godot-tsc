import { Button, Callable, CodeEdit, Color, Control, Engine, FileAccess, GError, HBoxContainer, HSplitContainer, ItemList, Label, LineEdit, MarginContainer, OS, RenderingServer, TabContainer, VBoxContainer } from 'godot';
import {
  LspError, LspSession, RequestCancelled, RequestScope, SERVER_CANCELLED, fileUri, openTsc,
  type LspCompletionItem, type LspCompletionItemKind, type LspDiagnostic, type LspInlayHint, type LspLocation, type LspPosition, type LspTextEdit,
  type ProjectFile, type TranspileResult, type Tsc,
} from 'godot-tsc';

/** Where the demo's lib files are (written by `scripts/demo.mjs` from the package's `typescript_libs.bin`). */
const LIBS_RESOURCE = 'res://tsc/libs.json';
const LIB_DIR = '/lib';
const SOURCE_PATH = '/project/main.ts';
const CONFIG_PATH = '/project/tsconfig.json';
const CONFIG = JSON.stringify({ compilerOptions: { target: 'es2022', lib: ['es2022'], strict: true }, files: [SOURCE_PATH] });
/** How long typing may pause before the source is checked again: every keystroke would be a check the next one supersedes. */
const EDIT_SETTLE_MS = 150;
/** The longest a `--verify` run may take before it fails: a first check is a fraction of a second. */
const VERIFY_DEADLINE_MS = 20_000;
const VERIFY_ARGUMENT = '--verify';
/** `--capture=<png>`: shows the sample with the caret on a name, saves the window's raster there and quits (scripts/demo.mjs --capture). */
const CAPTURE_PREFIX = '--capture=';
/** Frames a capture lets pass after the last answer, so the containers have laid out and drawn what it changed. */
const CAPTURE_SETTLE_FRAMES = 3;
const FRAME_POLL_MS = 16;
/** TypeScript's "Type '{0}' is not assignable to type '{1}'" (its `diagnosticMessages.json`), the error the sample shows. */
const TS_NOT_ASSIGNABLE = 2322;
/** The window's inset around everything, in logical pixels. */
const EDGE_MARGIN = 8;
const ERROR_LINE_COLOUR = new Color(1, 0.3, 0.3, 0.18);
const CLEAR_LINE_COLOUR = new Color(0, 0, 0, 0);

const SAMPLE = `interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const origin = { x: 0, y: 0 };
export const d = distance(origin, { x: 3, y: 4 });

// The checker answers here: a number is not a string.
export const label: string = d;
`;

/** What a check came to: the diagnostics of the source, that a newer check took its place before it began, or a failure. */
type Checked =
  | { readonly kind: 'checked'; readonly diagnostics: readonly LspDiagnostic[]; readonly serviceMs: number }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'failed'; readonly message: string };

/** LSP's `DiagnosticSeverity` of an error. */
const SEVERITY_ERROR = 1;
/** LSP's `InlayHintKind` of a type. */
const INLAY_TYPE = 1;
/** What signature help shows around the parameter the caret is at. */
const ACTIVE_PARAMETER_OPEN = '«';
const ACTIVE_PARAMETER_CLOSE = '»';

/** What one look at the source came to: the transpile, the check and the inlay hints of the same text. */
interface Refresh {
  readonly text: string;
  readonly transpile: TranspileResult;
  readonly transpileMs: number;
  readonly check: Checked;
  readonly hints: readonly LspInlayHint[];
  /** What running the transpiled module exported, or why it could not run. */
  readonly run: ModuleRun | null;
}

/** Someone waiting for the demo to have shown the answer for `key`: a source text, or a caret offset. */
interface Waiter<K, T> {
  readonly key: K;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

type ModuleRun = { readonly ok: true; readonly exports: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly message: string };

/** The lib files the checker reads, as `scripts/demo.mjs` wrote them. */
function readLibFiles(): ProjectFile[] {
  if (!FileAccess.fileExists(LIBS_RESOURCE)) throw new Error(`${LIBS_RESOURCE} is missing: run the demo with "pnpm demo", which writes it`);
  const parsed: unknown = JSON.parse(FileAccess.getFileAsString(LIBS_RESOURCE));
  if (!Array.isArray(parsed)) throw new Error(`${LIBS_RESOURCE} is not a list of files`);
  return parsed.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('name' in entry) || !('text' in entry)) throw new Error(`${LIBS_RESOURCE} has an entry that is not a file`);
    const { name, text } = entry;
    if (typeof name !== 'string' || typeof text !== 'string') throw new Error(`${LIBS_RESOURCE} has an entry that is not a file`);
    return { path: `${LIB_DIR}/${name}`, text };
  });
}

/** The LSP position (UTF-16) of a TextEdit position (Godot counts a line's columns in code points). */
function lspPosition(text: string, line: number, column: number): LspPosition {
  return { line, character: Array.from(text.split('\n')[line] ?? '').slice(0, column).join('').length };
}

/** The TextEdit column (code points) of an LSP position. */
function columnOf(text: string, position: LspPosition): number {
  return Array.from((text.split('\n')[position.line] ?? '').slice(0, position.character)).length;
}

/** `text` with LSP edits applied (from the last, so that the earlier ranges stay where they were). */
function applyEdits(text: string, edits: readonly LspTextEdit[]): string {
  const lines = text.split('\n');
  const offset = (position: LspPosition): number => lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
  return [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))
    .reduce((current, edit) => current.slice(0, offset(edit.range.start)) + edit.newText + current.slice(offset(edit.range.end)), text);
}

/** The UTF-16 offset of a TextEdit position (Godot counts a line's columns in code points). */
function offsetOf(text: string, line: number, column: number): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < line; index += 1) offset += (lines[index] ?? '').length + 1;
  return offset + Array.from(lines[line] ?? '').slice(0, column).join('').length;
}

function isCancellation(error: unknown): boolean {
  return error instanceof RequestCancelled;
}

function describeDiagnostic(diagnostic: LspDiagnostic): string {
  return `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}  TS${diagnostic.code}  ${diagnostic.message}`;
}

/** The kind of entry Godot's completion popup shows for an LSP completion item. */
function completionKind(kind: LspCompletionItemKind): CodeEdit.CodeCompletionKind {
  switch (kind) {
    case 2:
    case 3:
    case 4:
      return CodeEdit.CodeCompletionKind.KindFunction;
    case 7:
    case 8:
    case 9:
    case 25:
      return CodeEdit.CodeCompletionKind.KindClass;
    case 10:
      return CodeEdit.CodeCompletionKind.KindMember;
    case 13:
    case 20:
      return CodeEdit.CodeCompletionKind.KindEnum;
    case 14:
      return CodeEdit.CodeCompletionKind.KindKeyword;
    case 6:
      return CodeEdit.CodeCompletionKind.KindVariable;
  }
}

/** The text inside a hover's markdown code block (`name: type`). */
function hoverText(markdown: string): string {
  return markdown.replace(/^```typescript\n/u, '').replace(/\n```$/u, '');
}

/**
 * Runs a transpiled module in this realm: the code is a function body over `require`, `exports`, `module` and Fast Refresh's two
 * hooks (README.md). The demo's source is one file, so there is nothing for `require` to give.
 */
function runModule(code: string): ModuleRun {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  const require = (specifier: string): never => {
    throw new Error(`The demo runs one file: there is no "${specifier}" to import`);
  };
  const noRefresh = (): void => undefined;
  try {
    new Function('require', 'exports', 'module', '$RefreshReg$', '$RefreshSig$', code)(require, module.exports, module, noRefresh, () => noRefresh);
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, exports: module.exports };
}

function describeValue(value: unknown): string {
  if (typeof value === 'function') return `function ${value.name}`;
  return JSON.stringify(value) ?? String(value);
}

/**
 * The demo: a TypeScript source on the left, and what godot-tsc says about it on the right (its problems, the JavaScript it
 * transpiles to, what that exports when it runs, and the inferred types), with the type under the caret below. Every answer comes from the extension's service
 * thread a frame or more later; nothing here waits for it.
 */
export default class Main extends Control {
  private tsc: Tsc | null = null;
  private source: CodeEdit | null = null;
  private problems: ItemList | null = null;
  private javascript: CodeEdit | null = null;
  private hints: ItemList | null = null;
  private references: ItemList | null = null;
  private tabs: TabContainer | null = null;
  private newName: LineEdit | null = null;
  /** The language server of the service (`LspSession`), once `initialize` has been answered. */
  private lsp: Promise<LspSession> | null = null;
  private referencesScope: RequestScope | null = null;
  private exportsList: ItemList | null = null;
  private status: Label | null = null;
  private hover: Label | null = null;
  private signature: Label | null = null;
  private signatureScope: RequestScope | null = null;
  /** The requests of the latest look at the source; a newer edit cancels them. */
  private refreshScope: RequestScope | null = null;
  private hoverScope: RequestScope | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private markedLines: number[] = [];
  /** `--verify` and `--capture` edit the source and move the caret as a person does, and wait here for what the demo then shows. */
  private refreshWaiters: Waiter<string, Refresh>[] = [];
  private hoverWaiters: Waiter<number, string>[] = [];

  override _ready(): void {
    this.build();
    const tsc = openTsc();
    this.tsc = tsc;
    tsc.setFiles([...readLibFiles(), { path: CONFIG_PATH, text: CONFIG }]);
    const lsp = new LspSession(tsc, { config: CONFIG_PATH, libDir: LIB_DIR });
    this.lsp = lsp.initialize().then(() => lsp);
    const args = OS.getCmdlineUserArgs();
    const userArgs = Array.from({ length: args.size() }, (_, index) => args.get(index));
    if (userArgs.includes(VERIFY_ARGUMENT)) {
      this.verify().then(summary => {
        console.log(`godot-tsc demo verified: ${summary}`);
        this.getTree()?.quit(0);
      }, (error: unknown) => {
        console.error(`godot-tsc demo failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        this.getTree()?.quit(1);
      });
      return;
    }
    const capture = userArgs.find(arg => arg.startsWith(CAPTURE_PREFIX));
    if (capture !== undefined) {
      this.capture(capture.slice(CAPTURE_PREFIX.length)).then(() => this.getTree()?.quit(0), (error: unknown) => {
        console.error(`godot-tsc demo capture failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        this.getTree()?.quit(1);
      });
      return;
    }
    this.requireSource().text = SAMPLE;
  }

  /**
   * The sample as a person sees it, saved to `path`: the references of `origin` listed, the signature of the call to distance shown, and the
   * completions after `a.` in the editor's popup.
   */
  private async capture(path: string): Promise<void> {
    await this.edit(SAMPLE);
    await this.moveCaretOntoOrigin();
    await this.referencesAt(this.caretPosition(), new RequestScope());
    const tabs = this.tabs;
    if (!tabs) throw new Error('The demo was not built');
    tabs.currentTab = tabs.getTabCount() - 1;
    const lines = SAMPLE.split('\n');
    const callLine = lines.findIndex(line => line.startsWith('export const d'));
    await this.signatureAt({ line: callLine, character: (lines[callLine] ?? '').indexOf('{ x: 3') }, new RequestScope());
    const source = this.requireSource();
    const accessLine = lines.findIndex(line => line.includes('Math.hypot(a.x'));
    source.grabFocus();
    source.setCaretLine(accessLine);
    source.setCaretColumn((lines[accessLine] ?? '').indexOf('a.x') + 'a.'.length);
    await this.completeAtCaret(new RequestScope());
    const start = Engine.getProcessFrames();
    while (Engine.getProcessFrames() - start < CAPTURE_SETTLE_FRAMES) await new Promise(resolve => setTimeout(() => resolve(undefined), FRAME_POLL_MS));
    RenderingServer.forceDraw();
    const image = this.getViewport()?.getTexture()?.getImage();
    if (!image) throw new Error('A capture needs a rendered viewport (not --headless)');
    const saved = image.savePng(path);
    if (saved !== GError.Ok) throw new Error(`Saving ${path} failed with error ${saved}`);
    console.log(`godot-tsc demo captured ${path}`);
  }

  /** Replaces the source, as opening a file does, and resolves with the answer the demo then shows for it. */
  private edit(text: string): Promise<Refresh> {
    const shown = new Promise<Refresh>((resolve, reject) => this.refreshWaiters.push({ key: text, resolve, reject }));
    this.requireSource().text = text;
    return shown;
  }

  /** Types `typed` at the end of the source, as a keyboard does, and resolves with the answer the demo then shows. */
  private type(typed: string): Promise<Refresh> {
    const source = this.requireSource();
    const shown = new Promise<Refresh>((resolve, reject) => this.refreshWaiters.push({ key: `${source.text}${typed}`, resolve, reject }));
    source.setCaretLine(source.getLineCount() - 1);
    source.setCaretColumn(source.getLine(source.getLineCount() - 1).length);
    source.insertTextAtCaret(typed);
    return shown;
  }

  /** Puts the caret on `origin` in the sample's call, as a click would, and resolves with the hover the demo then shows. */
  private moveCaretOntoOrigin(): Promise<string> {
    const source = this.requireSource();
    const line = source.text.split('\n').findIndex(text => text.startsWith('export const d'));
    const column = (source.text.split('\n')[line] ?? '').indexOf('origin') + 1;
    const offset = offsetOf(source.text, line, column);
    const shown = new Promise<string>((resolve, reject) => this.hoverWaiters.push({ key: offset, resolve, reject }));
    source.setCaretLine(line);
    source.setCaretColumn(column);
    return shown;
  }

  private settle<K, T>(waiters: Waiter<K, T>[], key: K, value: T): Waiter<K, T>[] {
    for (const waiter of waiters) if (waiter.key === key) waiter.resolve(value);
    return waiters.filter(waiter => waiter.key !== key);
  }

  override _exitTree(): void {
    for (const waiter of [...this.refreshWaiters, ...this.hoverWaiters]) waiter.reject(new Error('The demo closed'));
    this.refreshWaiters = [];
    this.hoverWaiters = [];
    if (this.settleTimer !== undefined) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    this.refreshScope?.cancel();
    this.hoverScope?.cancel();
    this.referencesScope?.cancel();
    this.signatureScope?.cancel();
    this.lsp = null;
    this.tsc?.close();
    this.tsc = null;
  }

  private build(): void {
    const margin = new MarginContainer();
    margin.setAnchorsPreset(Control.LayoutPreset.PresetFullRect);
    for (const side of ['margin_left', 'margin_top', 'margin_right', 'margin_bottom']) margin.addThemeConstantOverride(side, EDGE_MARGIN);
    this.addChild(margin);

    const column = new VBoxContainer();
    margin.addChild(column);

    const split = new HSplitContainer();
    split.sizeFlagsVertical = Control.SizeFlags.SizeExpandFill;
    column.addChild(split);

    const source = new CodeEdit();
    source.sizeFlagsHorizontal = Control.SizeFlags.SizeExpandFill;
    source.guttersDrawLineNumbers = true;
    // Typing emits `text_changed`; setting the whole text (`text = ...`, as loading a file does) emits only `text_set` (TextEdit::_set_text).
    source.textChanged.connect(Callable.create(() => this.scheduleRefresh()));
    source.textSet.connect(Callable.create(() => this.scheduleRefresh()));
    source.caretChanged.connect(Callable.create(() => this.showHover()));
    // Completion: typing `.` asks for it, and so does Ctrl+Space.
    source.codeCompletionEnabled = true;
    source.codeCompletionPrefixes = ['.'];
    source.codeCompletionRequested.connect(Callable.create(() => this.report(this.completeAtCaret())));
    split.addChild(source);
    this.source = source;

    const tabs = new TabContainer();
    tabs.sizeFlagsHorizontal = Control.SizeFlags.SizeExpandFill;
    split.addChild(tabs);
    this.tabs = tabs;

    const problems = new ItemList();
    problems.setName('Problems');
    tabs.addChild(problems);
    this.problems = problems;

    const javascript = new CodeEdit();
    javascript.setName('JavaScript');
    javascript.editable = false;
    tabs.addChild(javascript);
    this.javascript = javascript;

    const exportsList = new ItemList();
    exportsList.setName('Exports');
    tabs.addChild(exportsList);
    this.exportsList = exportsList;

    const hints = new ItemList();
    hints.setName('Inlay hints');
    tabs.addChild(hints);
    this.hints = hints;

    const references = new ItemList();
    references.setName('References');
    tabs.addChild(references);
    this.references = references;

    // Go to definition and rename, at the caret (Ctrl+click on a name goes to its definition too).
    const actions = new HBoxContainer();
    column.addChild(actions);
    const definition = new Button();
    definition.text = 'Go to definition';
    definition.pressed.connect(Callable.create(() => this.report(this.goToDefinition())));
    actions.addChild(definition);
    const renameLabel = new Label();
    renameLabel.text = 'Rename the name at the caret to';
    actions.addChild(renameLabel);
    const newName = new LineEdit();
    newName.sizeFlagsHorizontal = Control.SizeFlags.SizeExpandFill;
    actions.addChild(newName);
    this.newName = newName;
    const rename = new Button();
    rename.text = 'Rename';
    rename.pressed.connect(Callable.create(() => this.report(this.renameAtCaret(newName.text))));
    actions.addChild(rename);
    source.symbolLookupOnClick = true;
    source.symbolValidate.connect(Callable.create(() => source.setSymbolLookupWordAsValid(true)));
    source.symbolLookup.connect(Callable.create(() => this.report(this.goToDefinition())));

    const hover = new Label();
    hover.text = 'Move the caret onto a name to see its type.';
    column.addChild(hover);
    this.hover = hover;

    const signature = new Label();
    column.addChild(signature);
    this.signature = signature;

    const status = new Label();
    column.addChild(status);
    this.status = status;
  }

  private scheduleRefresh(): void {
    if (this.settleTimer !== undefined) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.refresh().then(refresh => {
        // A superseded check is not an answer: the newer look at the source settles its waiters.
        if (refresh.check.kind !== 'superseded') this.refreshWaiters = this.settle(this.refreshWaiters, refresh.text, refresh);
      }, (error: unknown) => {
        if (isCancellation(error)) return;
        this.requireStatus().text = `godot-tsc failed: ${error instanceof Error ? error.message : String(error)}`;
        for (const waiter of this.refreshWaiters) waiter.reject(error);
        this.refreshWaiters = [];
      });
    }, EDIT_SETTLE_MS);
  }

  /** Transpiles, checks and asks for the inlay hints of the source as it is now, and shows what came back. */
  private async refresh(): Promise<Refresh> {
    const tsc = this.requireTsc();
    const lsp = await this.requireLsp();
    const text = this.requireSource().text;
    this.refreshScope?.cancel();
    const scope = new RequestScope();
    this.refreshScope = scope;
    tsc.setFile(SOURCE_PATH, text);
    this.requireStatus().text = 'Checking...';
    const lines = text.split('\n');
    const whole = { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: (lines.at(-1) ?? '').length } };
    const check = lsp.workspaceDiagnostics(scope).then((checked): Checked => {
      const own = checked.result.items.find(item => item.uri === fileUri(SOURCE_PATH));
      return { kind: 'checked', diagnostics: own?.items ?? [], serviceMs: checked.serviceMs };
    }, (error: unknown): Checked => {
      if (error instanceof LspError && error.code === SERVER_CANCELLED) return { kind: 'superseded' };
      if (error instanceof LspError) return { kind: 'failed', message: error.message };
      throw error;
    });
    const [{ result: transpile, serviceMs: transpileMs }, checked, hints] = await Promise.all([
      tsc.transpileTimed(SOURCE_PATH, text, {}, scope),
      check,
      lsp.inlayHints(SOURCE_PATH, whole, scope),
    ]);
    const refresh: Refresh = { text, transpile, transpileMs, check: checked, hints, run: transpile.ok ? runModule(transpile.code) : null };
    this.showRefresh(refresh);
    return refresh;
  }

  private showRefresh(refresh: Refresh): void {
    const source = this.requireSource();
    const problems = this.requireProblems();
    for (const line of this.markedLines) if (line < source.getLineCount()) source.setLineBackgroundColor(line, CLEAR_LINE_COLOUR);
    this.markedLines = [];
    problems.clear();

    if (refresh.transpile.ok) {
      this.requireJavascript().text = refresh.transpile.code;
    }
    for (const diagnostic of refresh.transpile.diagnostics) {
      problems.addItem(`${diagnostic.line + 1}:${diagnostic.character + 1}  syntax  ${diagnostic.message}`);
      this.markLine(diagnostic.line);
    }

    let checkSummary: string;
    switch (refresh.check.kind) {
      case 'checked': {
        for (const diagnostic of refresh.check.diagnostics) {
          problems.addItem(describeDiagnostic(diagnostic));
          if (diagnostic.severity === SEVERITY_ERROR) this.markLine(diagnostic.range.start.line);
        }
        checkSummary = `checked in ${refresh.check.serviceMs.toFixed(1)} ms`;
        break;
      }
      case 'failed':
        problems.addItem(`The check failed: ${refresh.check.message}`);
        checkSummary = 'check failed';
        break;
      case 'superseded':
        // A newer look at the source is on its way and will be shown instead.
        return;
    }
    if (problems.itemCount === 0) problems.addItem('No problems');

    const exportsList = this.requireExportsList();
    exportsList.clear();
    if (refresh.run?.ok === true) {
      for (const [name, value] of Object.entries(refresh.run.exports)) exportsList.addItem(`${name} = ${describeValue(value)}`);
    } else if (refresh.run?.ok === false) {
      exportsList.addItem(`It threw: ${refresh.run.message}`);
    }

    const hints = this.requireHints();
    hints.clear();
    for (const hint of refresh.hints) {
      hints.addItem(`${hint.position.line + 1}  ${hint.kind === INLAY_TYPE ? 'type' : 'parameter'}  ${hint.label}`);
    }

    const transpileSummary = refresh.transpile.ok ? `transpiled in ${refresh.transpileMs.toFixed(1)} ms` : 'syntax errors';
    this.requireStatus().text = `${transpileSummary} · ${checkSummary} · ${refresh.hints.length} inlay hints`;
  }

  private markLine(line: number): void {
    const source = this.requireSource();
    if (line >= source.getLineCount()) return;
    source.setLineBackgroundColor(line, ERROR_LINE_COLOUR);
    this.markedLines.push(line);
  }

  /** Shows what an action that a button started came to, if it failed: a button's signal does not wait for a promise. */
  private report(action: Promise<unknown>): void {
    action.catch((error: unknown) => {
      if (isCancellation(error)) return;
      this.requireStatus().text = error instanceof Error ? error.message : String(error);
    });
  }

  private caretPosition(): LspPosition {
    const source = this.requireSource();
    return lspPosition(source.text, source.getCaretLine(), source.getCaretColumn());
  }

  /** Lists the references of the name at `position` in the References tab. */
  private async referencesAt(position: LspPosition, scope: RequestScope): Promise<LspLocation[]> {
    const lsp = await this.requireLsp();
    this.requireTsc().setFile(SOURCE_PATH, this.requireSource().text);
    const found = await lsp.references(SOURCE_PATH, position, true, scope);
    const list = this.requireReferences();
    list.clear();
    const lines = this.requireSource().text.split('\n');
    for (const location of found) {
      list.addItem(`${location.range.start.line + 1}:${location.range.start.character + 1}  ${(lines[location.range.start.line] ?? '').trim()}`);
    }
    return found;
  }

  /** Moves the caret to the definition of the name at the caret. */
  private async goToDefinition(scope?: RequestScope): Promise<LspLocation | null> {
    const lsp = await this.requireLsp();
    const source = this.requireSource();
    this.requireTsc().setFile(SOURCE_PATH, source.text);
    const [found] = await lsp.definition(SOURCE_PATH, this.caretPosition(), scope);
    if (found === undefined || found.uri !== fileUri(SOURCE_PATH)) return null;
    source.setCaretLine(found.range.start.line);
    source.setCaretColumn(columnOf(source.text, found.range.start));
    return found;
  }

  /** Renames the name at the caret everywhere, and resolves with what the demo shows for the renamed source. */
  private async renameAtCaret(newName: string, scope?: RequestScope): Promise<Refresh> {
    const lsp = await this.requireLsp();
    const source = this.requireSource();
    this.requireTsc().setFile(SOURCE_PATH, source.text);
    const edit = await lsp.rename(SOURCE_PATH, this.caretPosition(), newName, scope);
    return this.edit(applyEdits(source.text, edit.changes[fileUri(SOURCE_PATH)] ?? []));
  }

  private showHover(): void {
    const source = this.requireSource();
    const text = source.text;
    const offset = offsetOf(text, source.getCaretLine(), source.getCaretColumn());
    const position = this.caretPosition();
    this.referencesScope?.cancel();
    const referencesScope = new RequestScope();
    this.referencesScope = referencesScope;
    this.report(this.referencesAt(position, referencesScope));
    this.signatureScope?.cancel();
    const signatureScope = new RequestScope();
    this.signatureScope = signatureScope;
    this.report(this.signatureAt(position, signatureScope));
    this.hoverAt(position).then(shown => {
      this.hoverWaiters = this.settle(this.hoverWaiters, offset, shown);
    }, (error: unknown) => {
      if (isCancellation(error)) return;
      this.requireHover().text = `Hover failed: ${error instanceof Error ? error.message : String(error)}`;
      for (const waiter of this.hoverWaiters) waiter.reject(error);
      this.hoverWaiters = [];
    });
  }

  private async hoverAt(position: LspPosition): Promise<string> {
    this.hoverScope?.cancel();
    const scope = new RequestScope();
    this.hoverScope = scope;
    const lsp = await this.requireLsp();
    // The hover reads the checker's copy of the file, so the edit is sent first: a hover asked for between keystrokes must not read old text.
    this.requireTsc().setFile(SOURCE_PATH, this.requireSource().text);
    const hover = await lsp.hover(SOURCE_PATH, position, scope);
    const shown = hover ? hoverText(hover.contents.value) : 'Move the caret onto a name to see its type.';
    this.requireHover().text = shown;
    return shown;
  }

  /** Shows the signature of the call the caret is in, the parameter it is at between « and ». */
  private async signatureAt(position: LspPosition, scope: RequestScope): Promise<string> {
    const lsp = await this.requireLsp();
    this.requireTsc().setFile(SOURCE_PATH, this.requireSource().text);
    const help = await lsp.signatureHelp(SOURCE_PATH, position, scope);
    const signature = help?.signatures[help.activeSignature];
    let shown = '';
    if (help && signature) {
      const active = signature.parameters[help.activeParameter]?.label;
      // The label's ranges are UTF-16 offsets, as a JavaScript string's are.
      shown = active === undefined
        ? signature.label
        : `${signature.label.slice(0, active[0])}${ACTIVE_PARAMETER_OPEN}${signature.label.slice(active[0], active[1])}${ACTIVE_PARAMETER_CLOSE}${signature.label.slice(active[1])}`;
    }
    this.requireSignature().text = shown;
    return shown;
  }

  /** Offers the completions at the caret in the editor's popup. */
  private async completeAtCaret(scope?: RequestScope): Promise<readonly LspCompletionItem[]> {
    const lsp = await this.requireLsp();
    const source = this.requireSource();
    this.requireTsc().setFile(SOURCE_PATH, source.text);
    const list = await lsp.completion(SOURCE_PATH, this.caretPosition(), scope);
    const items = [...list.items].sort((a, b) => a.sortText.localeCompare(b.sortText));
    for (const item of items) source.addCodeCompletionOption(completionKind(item.kind), item.label, item.label);
    source.updateCodeCompletionOptions(true);
    return items;
  }

  /** `--verify`: drives the demo through what it shows and checks each answer, then quits with the result. */
  private async verify(): Promise<string> {
    const deadline = setTimeout(() => {
      console.error(`godot-tsc demo failed: no result after ${VERIFY_DEADLINE_MS} ms`);
      this.getTree()?.quit(1);
    }, VERIFY_DEADLINE_MS);
    try {
      const problems = this.requireProblems();

      // The sample: it transpiles, and the checker finds the one type error.
      const first = await this.edit(SAMPLE);
      if (!first.transpile.ok) throw new Error(`The sample did not transpile: ${JSON.stringify(first.transpile.diagnostics)}`);
      if (first.transpile.exports.join() !== 'distance,d,label') throw new Error(`The sample exports ${JSON.stringify(first.transpile.exports)}`);
      if (!this.requireJavascript().text.includes('function distance(a, b)')) throw new Error(`The JavaScript tab shows:\n${this.requireJavascript().text}`);
      // Run, the module computes the distance from the origin to (3, 4).
      if (first.run?.ok !== true || first.run.exports.d !== 5 || first.run.exports.label !== 5) throw new Error(`Running the sample gave ${JSON.stringify(first.run)}`);
      if (this.requireExportsList().getItemText(1) !== 'd = 5') throw new Error(`The Exports tab shows "${this.requireExportsList().getItemText(1)}"`);
      if (first.check.kind !== 'checked') throw new Error(`The sample's check was ${first.check.kind}`);
      const errors = first.check.diagnostics;
      const labelLine = SAMPLE.split('\n').findIndex(line => line.startsWith('export const label'));
      if (errors.length !== 1 || errors[0]?.code !== TS_NOT_ASSIGNABLE || errors[0].range.start.line !== labelLine) {
        throw new Error(`Expected one TS2322 on line ${labelLine + 1}, got ${JSON.stringify(errors.map(describeDiagnostic))}`);
      }
      if (problems.itemCount !== 1 || !problems.getItemText(0).includes('TS2322')) throw new Error(`The Problems tab shows ${problems.itemCount} items`);
      // The inferred type of `d`, and the parameter name of the literal argument (`'literals'`: an identifier argument gets none).
      const shown = first.hints.map(hint => `${hint.position.line + 1}:${hint.label}`).join(' ');
      const dLine = SAMPLE.split('\n').findIndex(line => line.startsWith('export const d')) + 1;
      if (shown !== `${dLine}:: number ${dLine}:b:`) throw new Error(`The inlay hints are ${JSON.stringify(first.hints)}`);

      // Hover: the caret on `origin` in the call shows its inferred type.
      const hover = await this.moveCaretOntoOrigin();
      if (this.requireHover().text !== hover) throw new Error(`The hover line shows "${this.requireHover().text}"`);
      if (!hover.startsWith('origin:') || !hover.includes('x: number')) throw new Error(`Hover on origin showed "${hover}"`);

      // The language server, with the caret on `origin`: its references, then its definition, then a rename.
      const references = await this.referencesAt(this.caretPosition(), new RequestScope());
      const originLine = SAMPLE.split('\n').findIndex(line => line.startsWith('const origin'));
      const referenceLines = references.map(location => location.range.start.line).join();
      if (referenceLines !== `${originLine},${dLine - 1}` || this.requireReferences().itemCount !== 2) throw new Error(`The references of origin are ${JSON.stringify(references)}`);
      const definition = await this.goToDefinition(new RequestScope());
      if (definition?.range.start.line !== originLine || this.requireSource().getCaretLine() !== originLine || this.requireSource().getCaretColumn() !== 'const '.length) {
        throw new Error(`Going to origin's definition went to ${JSON.stringify(definition)}`);
      }
      const renamed = await this.renameAtCaret('start', new RequestScope());
      if (renamed.text !== SAMPLE.replace('const origin', 'const start').replace('distance(origin', 'distance(start')) throw new Error(`The rename gave:\n${renamed.text}`);
      if (renamed.check.kind !== 'checked' || renamed.check.diagnostics.length !== 1 || renamed.run?.ok !== true || renamed.run.exports.d !== 5) {
        throw new Error(`The renamed source checks or runs otherwise: ${JSON.stringify(renamed.check)}`);
      }

      // Completion, with the caret after `a.` (as typing the dot asks for it): the properties of a Point, in the editor's popup.
      const source = this.requireSource();
      const accessLine = renamed.text.split('\n').findIndex(line => line.includes('Math.hypot(a.x'));
      source.setCaretLine(accessLine);
      source.setCaretColumn((renamed.text.split('\n')[accessLine] ?? '').indexOf('a.x') + 'a.'.length);
      const completions = await this.completeAtCaret(new RequestScope());
      if (completions.map(item => item.label).join() !== 'x,y' || source.getCodeCompletionOptions().size() !== 2) {
        throw new Error(`Completion after a. offered ${JSON.stringify(completions)}`);
      }
      // Signature help, in the second argument of the call to distance.
      const callLine = renamed.text.split('\n').findIndex(line => line.startsWith('export const d'));
      const callText = renamed.text.split('\n')[callLine] ?? '';
      const signature = await this.signatureAt({ line: callLine, character: callText.indexOf('{ x: 3') }, new RequestScope());
      if (signature !== 'distance(a: Point, «b: Point»): number' || this.requireSignature().text !== signature) throw new Error(`Signature help showed "${signature}"`);

      // The fix: the error goes away.
      const fixed = SAMPLE.replace('export const label: string = d;', 'export const label: string = d.toFixed(2);');
      const second = await this.edit(fixed);
      if (second.check.kind !== 'checked' || second.check.diagnostics.length !== 0) throw new Error(`The fixed source still has problems: ${JSON.stringify(second.check)}`);
      if (problems.getItemText(0) !== 'No problems') throw new Error(`The Problems tab shows "${problems.getItemText(0)}" for the fixed source`);
      if (second.run?.ok !== true || second.run.exports.label !== '5.00') throw new Error(`Running the fixed source gave ${JSON.stringify(second.run)}`);

      // A syntax error, typed: the transpiler says where.
      const third = await this.type('const = ;\n');
      if (third.transpile.ok || third.transpile.diagnostics.length === 0) throw new Error('A syntax error transpiled');
      if (!problems.getItemText(0).includes('syntax')) throw new Error(`The Problems tab shows "${problems.getItemText(0)}" for a syntax error`);

      return `transpile ${first.transpileMs.toFixed(1)} ms, check ${first.check.serviceMs.toFixed(1)} ms, ran (d = 5), TS2322 found and cleared, hover "${hover}", ${first.hints.length} inlay hints, ${references.length} references, definition and rename, completion, signature help, syntax error reported`;
    } finally {
      clearTimeout(deadline);
    }
  }

  private requireTsc(): Tsc {
    if (!this.tsc) throw new Error('The demo has no godot-tsc service');
    return this.tsc;
  }

  private requireSource(): CodeEdit {
    if (!this.source) throw new Error('The demo was not built');
    return this.source;
  }

  private requireProblems(): ItemList {
    if (!this.problems) throw new Error('The demo was not built');
    return this.problems;
  }

  private requireJavascript(): CodeEdit {
    if (!this.javascript) throw new Error('The demo was not built');
    return this.javascript;
  }

  private requireHints(): ItemList {
    if (!this.hints) throw new Error('The demo was not built');
    return this.hints;
  }

  private requireSignature(): Label {
    if (!this.signature) throw new Error('The demo was not built');
    return this.signature;
  }

  private requireReferences(): ItemList {
    if (!this.references) throw new Error('The demo was not built');
    return this.references;
  }

  private requireLsp(): Promise<LspSession> {
    if (!this.lsp) throw new Error('The demo has no language server');
    return this.lsp;
  }

  private requireExportsList(): ItemList {
    if (!this.exportsList) throw new Error('The demo was not built');
    return this.exportsList;
  }

  private requireStatus(): Label {
    if (!this.status) throw new Error('The demo was not built');
    return this.status;
  }

  private requireHover(): Label {
    if (!this.hover) throw new Error('The demo was not built');
    return this.hover;
  }
}
