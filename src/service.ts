import {
  parseHover, parseInlayHints, parseReply, parseServiceState, type CheckOutcome, type CompileResult, type Hover, type InlayHint, type ParameterNames, type Pong, type ProjectFile,
  type Reply, type ServiceState,
} from './protocol';
import type { LiveCompileHost } from './host';
import { RequestCancelled, type RequestScope } from './scope';

/**
 * What the host needs of the extension's `LiveCompile` object (`live-compile/ext/lib.rs`). Every call returns at once: the ones that make a
 * request return its id, and the answers come through `poll` as JSON. The Godot-facing adapter is in `live-compile-host.ts`; this file has no
 * Godot import, so the request machinery below runs in Node tests.
 */
export interface ServiceLink {
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

/** A request that has been made and not answered. */
interface Outstanding {
  readonly kind: Reply['kind'];
  /** Settles the request's promise with the reply, if it is the kind that was asked for. */
  readonly deliver: (reply: Reply) => void;
  readonly reject: (error: Error) => void;
  /** The request is settled one way or another: its cancellation with its scope is forgotten and its deadline is not waited for. */
  readonly finish: () => void;
}

export class ExtensionHost implements LiveCompileHost {
  private readonly service: ServiceLink;
  private readonly outstanding = new Map<number, Outstanding>();
  private readonly deadlineMs: number;
  private polling = false;
  private closed = false;

  constructor(service: ServiceLink, deadlineMs: number = REQUEST_DEADLINE_MS) {
    this.service = service;
    this.deadlineMs = deadlineMs;
  }

  compile(path: string, source: string, refresh: boolean, scope: RequestScope): Promise<CompileResult> {
    return this.compileTimed(path, source, refresh, scope).then(timed => timed.result);
  }

  /** `compile`, with the time the service thread took, from its own clock (the answer reaches JavaScript a frame later at the soonest). */
  compileTimed(path: string, source: string, refresh: boolean, scope: RequestScope): Promise<{ readonly result: CompileResult; readonly serviceMs: number }> {
    return this.ask('compile', () => this.service.requestCompile(path, source, refresh), scope).then(reply => ({ result: reply.result, serviceMs: reply.serviceMs }));
  }

  setFile(path: string, text: string): void {
    this.service.setFile(path, text);
  }

  setFiles(files: readonly ProjectFile[]): void {
    this.service.setFiles(files);
  }

  requestCheck(config: string, libDir: string, scope?: RequestScope): Promise<CheckOutcome> {
    return this.ask('check', () => this.service.requestCheck(config, libDir), scope).then(reply => reply.outcome);
  }

  hover(config: string, libDir: string, path: string, offset: number, scope?: RequestScope): Promise<Hover | null> {
    return this.query({ op: 'hover', config, libDir, path, offset }, scope).then(parseHover);
  }

  inlayHints(config: string, libDir: string, path: string, from: number, to: number, parameterNames: ParameterNames, scope?: RequestScope): Promise<InlayHint[]> {
    return this.query({ op: 'inlayHints', config, libDir, path, from, to, parameterNames }, scope).then(parseInlayHints);
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
        reject(new Error(`The live-compile service did not answer request ${id} (${kind}) within ${this.deadlineMs / MILLISECONDS_PER_SECOND} s; its state is ${state}`));
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

