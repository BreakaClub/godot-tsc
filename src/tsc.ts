import {
  parseHover, parseInlayHints, parseLspMessages, parseReply, parseServiceState, type CheckOutcome, type TranspileResult, type Hover, type InlayHint, type LspMessage, type ParameterNames, type Pong, type ProjectFile,
  type Reply, type ServiceState,
} from './protocol';
import { RequestCancelled, type RequestScope } from './scope';

/**
 * What `Tsc` needs of the extension's `GodotTsc` object (`ext/lib.rs`). Every call returns at once: the ones that make a request return its
 * id, and the answers come through `poll` as JSON. The Godot adapter is `godot.ts`; this file has no Godot import, so the request machinery
 * below runs in Node tests against a link the test holds.
 */
export interface TscLink {
  start(): void;
  stop(): void;
  setFile(path: string, text: string): void;
  setFiles(files: readonly ProjectFile[]): void;
  removeFile(path: string): void;
  requestPing(): number;
  requestCompile(path: string, source: string, refresh: boolean): number;
  requestCheck(config: string, libDir: string): number;
  requestQuery(requestJson: string): number;
  requestStall(milliseconds: number): number;
  cancel(id: number): boolean;
  poll(): string;
  state(): string;
}

/** How soon `poll` asks again while a request is outstanding. Nothing polls while none is. */
const POLL_INTERVAL_MS = 1;
const MILLISECONDS_PER_SECOND = 1000;

/** A timer that can be put away. */
class Deadline {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(expired: () => void, ms: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      expired();
    }, ms);
  }

  cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * How long a request may wait for its answer before the host calls the service dead. A thread that trapped (in a browser, a panic ends it) answers
 * nothing, and an editor that says "Compiling" for ever is no better than one that hangs. It is a timer: nothing waits for it, and the
 * longest request of a typical project (a first check) is a fraction of a second.
 */
export const REQUEST_DEADLINE_MS = 30_000;

/** The project a check, a hover or a set of inlay hints is asked of: its configuration file and the directory of its lib files. */
export interface ProjectOptions {
  /** The absolute path of the project's tsconfig.json in the checker's files (`/project/tsconfig.json`). */
  readonly config: string;
  /** The directory of the checker's files that holds TypeScript's `lib.*.d.ts` (`/lib`). A program without them fails its check. */
  readonly libDir: string;
}

export interface TranspileOptions {
  /** Instrument the components for React Fast Refresh (`$RefreshReg$`, `$RefreshSig$`). Only JSX files have components. Default false. */
  readonly reactRefresh?: boolean;
}

/** The inclusive-exclusive UTF-16 range of a file that inlay hints are asked for. */
export interface TextRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Bun's TypeScript checker and transpiler, behind typed calls. **No call waits for the service thread.** Calls that change the files
 * (`setFile`, `setFiles`, `removeFile`) return at once; the others return a promise that is settled on a frame after the service thread has
 * answered, and the frame goes on meanwhile. A browser starts the service thread only when the page's own thread returns to its event loop,
 * so a call that waited for it could stall the page for as long as the browser takes to start a thread.
 *
 * Every request takes an optional `RequestScope`: cancelling it takes back the scope's unanswered requests, which then fail with
 * `RequestCancelled`, so an answer that was given up is never delivered. `Tsc` is the implementation; a test or another runtime can supply
 * its own.
 */
export interface TscHost {
  /** Adds the file at `path` (absolute, in the checker's format: `/project/app.tsx`) or replaces its text. */
  setFile(path: string, text: string): void;
  setFiles(files: readonly ProjectFile[]): void;
  /** Removes the file at `path`, which must be there. */
  removeFile(path: string): void;
  /** One file's JavaScript, as a function body over `require`, `exports` and `module`: Bun's parser and printer. Syntax only: it type-checks nothing. */
  transpile(path: string, source: string, options?: TranspileOptions, scope?: RequestScope): Promise<TranspileResult>;
  /** Type-checks the project. A check that has not begun when the next is asked for is answered as superseded. */
  check(project: ProjectOptions, scope?: RequestScope): Promise<CheckOutcome>;
  /** What is under `offset` (UTF-16) in the file at `path`: the name and its type. */
  hover(project: ProjectOptions, path: string, offset: number, scope?: RequestScope): Promise<Hover | null>;
  /** The inferred types of declarations and the parameter names of arguments in `range` of the file at `path`. */
  inlayHints(project: ProjectOptions, path: string, range: TextRange, parameterNames: ParameterNames, scope?: RequestScope): Promise<InlayHint[]>;
  /**
   * One Language Server Protocol message for the service's language server (a request or a notification), and the messages it sends back:
   * the response to a request among them. `LspSession` (`lsp.ts`) speaks it with ids and typed results.
   */
  lsp(message: LspMessage, scope?: RequestScope): Promise<LspMessage[]>;
  /** Ends the service. Every request still outstanding fails with `RequestCancelled`. */
  close(): void;
}

/** One project of a `TscHost`: its checks, hovers and inlay hints without its configuration repeated on each call. The files are the host's. */
export class TscProject {
  readonly host: TscHost;
  readonly options: ProjectOptions;

  constructor(host: TscHost, options: ProjectOptions) {
    this.host = host;
    this.options = options;
  }

  check(scope?: RequestScope): Promise<CheckOutcome> {
    return this.host.check(this.options, scope);
  }

  hover(path: string, offset: number, scope?: RequestScope): Promise<Hover | null> {
    return this.host.hover(this.options, path, offset, scope);
  }

  inlayHints(path: string, range: TextRange, parameterNames: ParameterNames = 'literals', scope?: RequestScope): Promise<InlayHint[]> {
    return this.host.inlayHints(this.options, path, range, parameterNames, scope);
  }
}

/** A request that has been made and not answered. */
interface Outstanding {
  readonly kind: Reply['kind'];
  /** Settles the request's promise with the reply, if it is the kind that was asked for. */
  readonly deliver: (reply: Reply) => void;
  readonly reject: (error: Error) => void;
  /** The request is settled one way or another: its cancellation with its scope is forgotten and its deadline is not waited for. */
  readonly finish: () => void;
}

export class Tsc implements TscHost {
  private readonly service: TscLink;
  private readonly outstanding = new Map<number, Outstanding>();
  private readonly deadlineMs: number;
  private polling = false;
  private closed = false;

  /** `link` is started already (`openTsc` starts the extension's thread when it opens it). */
  constructor(link: TscLink, deadlineMs: number = REQUEST_DEADLINE_MS) {
    this.service = link;
    this.deadlineMs = deadlineMs;
  }

  /** The project whose configuration is `options.config`, for its checks, hovers and inlay hints. */
  project(options: ProjectOptions): TscProject {
    return new TscProject(this, options);
  }

  setFile(path: string, text: string): void {
    this.service.setFile(path, text);
  }

  setFiles(files: readonly ProjectFile[]): void {
    this.service.setFiles(files);
  }

  removeFile(path: string): void {
    this.service.removeFile(path);
  }

  transpile(path: string, source: string, options: TranspileOptions = {}, scope?: RequestScope): Promise<TranspileResult> {
    return this.transpileTimed(path, source, options, scope).then(timed => timed.result);
  }

  /** `transpile`, with the time the service thread took, from its own clock (the answer reaches JavaScript a frame later at the soonest). */
  transpileTimed(path: string, source: string, options: TranspileOptions = {}, scope?: RequestScope): Promise<{ readonly result: TranspileResult; readonly serviceMs: number }> {
    const reactRefresh = options.reactRefresh ?? false;
    return this.ask('compile', () => this.service.requestCompile(path, source, reactRefresh), scope).then(reply => ({ result: reply.result, serviceMs: reply.serviceMs }));
  }

  check(project: ProjectOptions, scope?: RequestScope): Promise<CheckOutcome> {
    return this.ask('check', () => this.service.requestCheck(project.config, project.libDir), scope).then(reply => reply.outcome);
  }

  hover(project: ProjectOptions, path: string, offset: number, scope?: RequestScope): Promise<Hover | null> {
    return this.query({ op: 'hover', config: project.config, libDir: project.libDir, path, offset }, scope).then(parseHover);
  }

  inlayHints(project: ProjectOptions, path: string, range: TextRange, parameterNames: ParameterNames, scope?: RequestScope): Promise<InlayHint[]> {
    const request = { op: 'inlayHints', config: project.config, libDir: project.libDir, path, from: range.from, to: range.to, parameterNames };
    return this.query(request, scope).then(parseInlayHints);
  }

  lsp(message: LspMessage, scope?: RequestScope): Promise<LspMessage[]> {
    return this.query({ op: 'lsp', message }, scope).then(parseLspMessages);
  }

  /** Asks the library its name and the Bun revision it is made from. */
  ping(): Promise<Pong> {
    return this.ask('ping', () => this.service.requestPing(), undefined).then(reply => reply.result);
  }

  /** A test hook: the service thread is held for `milliseconds`, as a long check would hold it. Answered when the hold ends. */
  stall(milliseconds: number, scope?: RequestScope): Promise<void> {
    return this.ask('stall', () => this.service.requestStall(milliseconds), scope).then(() => undefined);
  }

  /** What the extension's queue holds right now. It asks nothing of the thread. */
  state(): ServiceState {
    return parseServiceState(this.service.state());
  }

  /** The requests made and not answered. */
  get outstandingCount(): number {
    return this.outstanding.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const cancelled = [...this.outstanding.values()];
    this.outstanding.clear();
    for (const request of cancelled) {
      request.finish();
      request.reject(new RequestCancelled());
    }
    this.service.stop();
  }

  private query(request: Record<string, unknown>, scope: RequestScope | undefined): Promise<Record<string, unknown>> {
    return this.ask('query', () => this.service.requestQuery(JSON.stringify(request)), scope).then(reply => reply.result);
  }

  /**
   * Makes a request and returns the promise of its reply. With a `scope`, cancelling the scope takes the request back from the service
   * (it never runs if it had not begun; if it had, its reply is dropped) and fails the promise with `RequestCancelled`.
   */
  private ask<K extends Reply['kind']>(kind: K, send: () => number, scope: RequestScope | undefined): Promise<Extract<Reply, { readonly kind: K }>> {
    if (this.closed || scope?.cancelled === true) return Promise.reject(new RequestCancelled());
    const id = send();
    return new Promise((resolve, reject) => {
      const isAsked = (reply: Reply): reply is Extract<Reply, { readonly kind: K }> => reply.kind === kind;
      const forgetScope = scope?.onCancel(() => {
        this.outstanding.delete(id);
        deadline.cancel();
        this.service.cancel(id);
        reject(new RequestCancelled());
      }) ?? (() => {});
      const deadline = new Deadline(() => {
        // The service has not answered in all this time. Its queue is read without asking the thread, so the message can say what it looks like.
        if (!this.outstanding.delete(id)) return;
        forgetScope();
        const state = this.service.state();
        this.service.cancel(id);
        reject(new Error(`The godot-tsc service did not answer request ${id} (${kind}) within ${this.deadlineMs / MILLISECONDS_PER_SECOND} s; its state is ${state}`));
      }, this.deadlineMs);
      this.outstanding.set(id, {
        kind,
        deliver: reply => {
          if (isAsked(reply)) resolve(reply);
          else reject(new Error(`The service answered request ${id}, a ${kind}, with a ${reply.kind}`));
        },
        reject,
        finish: () => {
          forgetScope();
          deadline.cancel();
        },
      });
      this.schedulePoll();
    });
  }

  private schedulePoll(): void {
    if (this.polling) return;
    this.polling = true;
    setTimeout(() => this.poll(), POLL_INTERVAL_MS);
  }

  private poll(): void {
    this.polling = false;
    try {
      for (let json = this.service.poll(); json !== ''; json = this.service.poll()) {
        const reply = parseReply(json);
        // The service hands over no reply for a request that was cancelled, so a reply nobody asked for is a defect, not a late answer.
        const request = this.outstanding.get(reply.id);
        if (request === undefined) throw new Error(`The service answered request ${reply.id} (${reply.kind}), which nobody is waiting for`);
        this.outstanding.delete(reply.id);
        request.finish();
        request.deliver(reply);
      }
    } finally {
      if (this.outstanding.size > 0) this.schedulePoll();
    }
  }
}

