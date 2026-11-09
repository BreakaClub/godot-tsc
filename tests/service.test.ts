import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReply, type ProjectFile } from '../src/protocol';
import { RequestCancelled, RequestScope } from '../src/scope';
import { ExtensionHost, type ServiceLink } from '../src/service';

// The request machinery of the live-compile host (src/service.ts) against a service that the test holds: what a request
// is until it is answered, what taking it back does, and that nothing here ever waits for the service. The service is a fake with the
// extension's contract (live-compile/ext/lib.rs, queue.rs): every call returns at once, `cancel` removes a request so that no reply for it is
// handed over, and `poll` hands over the replies that are ready.

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type Kind = 'compile' | 'check' | 'query' | 'ping' | 'stall';

class FakeService implements ServiceLink {
  readonly requests: { readonly id: number; readonly kind: Kind; readonly detail: string }[] = [];
  readonly cancelled: number[] = [];
  readonly replies: string[] = [];
  polls = 0;
  stopped = false;
  private nextId = 0;

  start(): void {}

  stop(): void {
    this.stopped = true;
  }

  setFile(): void {}

  setFiles(_files: readonly ProjectFile[]): void {}

  removeFile(): void {}

  requestPing(): number {
    return this.make('ping', '');
  }

  requestCompile(path: string, source: string, refresh: boolean): number {
    return this.make('compile', `${path}|${source}|${refresh}`);
  }

  requestCheck(config: string): number {
    return this.make('check', config);
  }

  requestQuery(requestJson: string): number {
    return this.make('query', requestJson);
  }

  requestStall(milliseconds: number): number {
    return this.make('stall', String(milliseconds));
  }

  cancel(id: number): boolean {
    this.cancelled.push(id);
    const index = this.requests.findIndex(request => request.id === id);
    if (index >= 0) this.requests.splice(index, 1);
    return index >= 0;
  }

  poll(): string {
    this.polls += 1;
    return this.replies.shift() ?? '';
  }

  state(): string {
    return JSON.stringify({ started: true, threadRunning: true, queued: this.requests.length, running: null, replies: this.replies.length, threadsAlive: 1 });
  }

  /** The service answers request `id`: its reply is ready for the next `poll`. */
  answer(id: number, reply: string): void {
    this.replies.push(reply);
    const index = this.requests.findIndex(request => request.id === id);
    if (index >= 0) this.requests.splice(index, 1);
  }

  private make(kind: Kind, detail: string): number {
    this.nextId += 1;
    this.requests.push({ id: this.nextId, kind, detail });
    return this.nextId;
  }
}

const compiled = (id: number, code: string): string => `{"id":${id},"kind":"compile","ms":1.5,"result":{"ok":true,"code":${JSON.stringify(code)},"imports":[],"exports":[],"diagnostics":[]}}`;

test('a scope runs what was registered with it once when it is cancelled, and a request made under a cancelled scope is refused', () => {
  const scope = new RequestScope();
  const calls: string[] = [];
  const forgotten = scope.onCancel(() => calls.push('forgotten'));
  scope.onCancel(() => calls.push('kept'));
  forgotten();
  assert.equal(scope.cancelled, false);
  scope.cancel();
  scope.cancel();
  assert.deepEqual(calls, ['kept']);
  assert.equal(scope.cancelled, true);
  assert.throws(() => scope.throwIfCancelled(), RequestCancelled);
  assert.throws(() => scope.onCancel(() => {}), RequestCancelled);
});

test('a compile is asked for at once and answered when the service has it: the frame goes on in between', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service);
  const answered: string[] = [];
  const request = host.compile('/p/a.tsx', 'export const a = 1;', true, new RequestScope()).then(result => { answered.push(result.ok ? result.code : 'failed'); });
  assert.equal(service.requests.length, 1, 'the request was made before the call returned');
  assert.equal(service.requests[0]?.kind, 'compile');
  assert.equal(service.requests[0]?.detail, '/p/a.tsx|export const a = 1;|true');
  assert.equal(host.outstandingCount, 1);
  await pause(10);
  assert.deepEqual(answered, [], 'nothing is answered that the service has not answered');
  service.answer(1, compiled(1, 'CODE'));
  await request;
  assert.deepEqual(answered, ['CODE']);
  assert.equal(host.outstandingCount, 0);
});

test('requests are answered by their ids, whatever the order the service answers in', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service);
  const scope = new RequestScope();
  const first = host.compile('/p/a.tsx', 'A', true, scope);
  const second = host.compile('/p/b.tsx', 'B', true, scope);
  service.answer(2, compiled(2, 'CODE B'));
  service.answer(1, compiled(1, 'CODE A'));
  const [a, b] = await Promise.all([first, second]);
  assert.ok(a.ok && b.ok);
  assert.equal(a.code, 'CODE A');
  assert.equal(b.code, 'CODE B');
});

test('polling stops when nothing is outstanding: an idle host asks the service for nothing', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service);
  const request = host.compile('/p/a.tsx', 'A', true, new RequestScope());
  await pause(10);
  const whileWaiting = service.polls;
  assert.ok(whileWaiting >= 1, 'it polls while a request is outstanding');
  service.answer(1, compiled(1, 'X'));
  await request;
  await pause(10);
  const afterAnswer = service.polls;
  await pause(20);
  assert.equal(service.polls, afterAnswer, 'and stops when the last is answered');
});

test('cancelling the scope takes the request back from the service and fails it as cancelled', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service);
  const scope = new RequestScope();
  const request = host.compile('/p/a.tsx', 'A', true, scope);
  const outcome = request.then(() => 'answered', (error: unknown) => (error instanceof RequestCancelled ? 'cancelled' : String(error)));
  scope.cancel();
  assert.equal(await outcome, 'cancelled');
  assert.deepEqual(service.cancelled, [1], 'the service was told to forget it');
  assert.equal(service.requests.length, 0, 'so it never runs');
  assert.equal(host.outstandingCount, 0);
  await pause(10);
  const afterTimer = service.polls;
  await pause(20);
  assert.ok(afterTimer <= 1 && service.polls === afterTimer, `and nothing polls for it once the timer that was set for it has run: ${service.polls} polls`);
});

test('a request made under a scope that is already cancelled is never sent', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service);
  const scope = new RequestScope();
  scope.cancel();
  await assert.rejects(host.compile('/p/a.tsx', 'A', true, scope), RequestCancelled);
  assert.equal(service.requests.length, 0);
});

test('an answer that comes with the scope cancelled after it was delivered is not taken back twice', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service);
  const scope = new RequestScope();
  const request = host.compile('/p/a.tsx', 'A', true, scope);
  service.answer(1, compiled(1, 'X'));
  await request;
  scope.cancel();
  assert.deepEqual(service.cancelled, [], 'a request that was answered has nothing to take back');
});

test('closing the host fails every outstanding request as cancelled, stops the service and refuses new ones', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service);
  const compile = host.compile('/p/a.tsx', 'A', true, new RequestScope());
  const check = host.requestCheck('/p/tsconfig.json', '/libs');
  const results = Promise.allSettled([compile, check]);
  host.close();
  const settled = await results;
  assert.ok(settled.every(result => result.status === 'rejected' && result.reason instanceof RequestCancelled));
  assert.equal(service.stopped, true);
  assert.equal(host.outstandingCount, 0);
  await assert.rejects(host.compile('/p/b.tsx', 'B', true, new RequestScope()), RequestCancelled);
  host.close();
});

test('a check that a newer one took the place of is answered as superseded', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service);
  const older = host.requestCheck('/p/tsconfig.json', '/libs');
  service.answer(1, '{"id":1,"kind":"check","superseded":true,"by":2}');
  assert.deepEqual(await older, { kind: 'superseded', by: 2 });
});

test('the service answering a request with the wrong kind of reply fails that request and no other', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service);
  const compile = host.compile('/p/a.tsx', 'A', true, new RequestScope());
  const ping = host.ping();
  service.answer(1, '{"id":1,"kind":"ping","ms":0,"result":{"name":"live-compile","bunRevision":"x"}}');
  service.answer(2, '{"id":2,"kind":"ping","ms":0,"result":{"name":"live-compile","bunRevision":"abc"}}');
  await assert.rejects(compile, /a compile, with a ping/u);
  assert.deepEqual(await ping, { name: 'live-compile', bunRevision: 'abc' });
});

test('a stall is a request like any other and can be taken back', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service);
  const scope = new RequestScope();
  const stall = host.stall(500, scope);
  assert.equal(service.requests[0]?.kind, 'stall');
  assert.equal(service.requests[0]?.detail, '500');
  scope.cancel();
  await assert.rejects(stall, RequestCancelled);
});

test('a service that never answers is called dead after the deadline, and says what its queue looked like; no call waited for it', async () => {
  const service = new FakeService();
  const host = new ExtensionHost(service, 30);
  const started = Date.now();
  const request = host.compile('/p/a.tsx', 'A', true, new RequestScope());
  assert.ok(Date.now() - started < 30, 'the call returned at once');
  await assert.rejects(request, /did not answer request 1 \(compile\) within 0\.03 s; its state is \{"started":true,"threadRunning":true,"queued":1/u);
  assert.deepEqual(service.cancelled, [1], 'the request was taken back');
  assert.equal(host.outstandingCount, 0);
  // A request that is answered in time leaves no deadline behind.
  const fine = host.compile('/p/b.tsx', 'B', true, new RequestScope());
  service.answer(2, compiled(2, 'X'));
  await fine;
  await pause(60);
  assert.equal(host.outstandingCount, 0);
});

test('the replies of the service parse: compile, ping and stall', () => {
  const compile = parseReply(compiled(3, 'CODE'));
  assert.ok(compile.kind === 'compile' && compile.id === 3 && compile.result.ok && compile.result.code === 'CODE' && compile.serviceMs === 1.5);
  const failed = parseReply('{"id":4,"kind":"compile","ms":0.2,"result":{"ok":false,"diagnostics":[{"start":1,"end":2,"line":0,"character":1,"severity":"error","message":"nope"}]}}');
  assert.ok(failed.kind === 'compile' && !failed.result.ok && failed.result.diagnostics[0]?.message === 'nope');
  const stall = parseReply('{"id":5,"kind":"stall","ms":250.000,"result":{"ok":true}}');
  assert.deepEqual(stall, { id: 5, kind: 'stall', serviceMs: 250 });
  assert.throws(() => parseReply('{"id":6,"kind":"nothing"}'), /not one/u);
});
