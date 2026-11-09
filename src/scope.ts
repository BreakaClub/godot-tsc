/**
 * The requests of one piece of work (an edit, an open) and the one thing that can be done to them together: take them back.
 *
 * Every request to the live-compile service is answered later, on a frame after the service thread has it. The work that asked for
 * it can be overtaken in the meantime (a newer edit of the same file, the lab being left, the host going away). A scope is how that
 * work says "I no longer want any answer": cancelling it takes back the requests made under it that have not been answered, and every
 * one of those requests then fails with `RequestCancelled`, so no answer is ever applied after it was given up.
 *
 * A scope is not an `AbortController`: GodotJS's native realm has none, and a request needs only this.
 */

/** What a request fails with when its scope was cancelled (or its host closed) before it was answered. */
export class RequestCancelled extends Error {
  constructor() {
    super('The request was cancelled before it was answered');
    this.name = 'RequestCancelled';
  }
}

export class RequestScope {
  private done = false;
  private readonly cancellers = new Set<() => void>();

  get cancelled(): boolean {
    return this.done;
  }

  /** Runs `canceller` when the scope is cancelled. Returns the function that forgets it, for a request that was answered first. */
  onCancel(canceller: () => void): () => void {
    if (this.done) throw new RequestCancelled();
    this.cancellers.add(canceller);
    return () => { this.cancellers.delete(canceller); };
  }

  /** Takes back every request of this scope that has not been answered. Cancelling twice is cancelling once. */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    const cancellers = [...this.cancellers];
    this.cancellers.clear();
    for (const canceller of cancellers) canceller();
  }

  /** For the point after an `await`: an answer that arrived for work that was given up is not applied. */
  throwIfCancelled(): void {
    if (this.done) throw new RequestCancelled();
  }
}
