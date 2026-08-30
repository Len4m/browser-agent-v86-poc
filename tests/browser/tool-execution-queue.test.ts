import assert from "node:assert/strict";
import test from "node:test";

import { createSerialToolQueue } from "../../src/browser/chat/tools/ai-tools";

test("tool execution queue keeps v86 operations strictly serial", async () => {
  const queue = createSerialToolQueue();
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;

  const run = (name: string) => queue.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`${name}:start`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    order.push(`${name}:end`);
    active -= 1;
    return name;
  });

  assert.deepEqual(await Promise.all([run("a"), run("b"), run("c")]), ["a", "b", "c"]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("an aborted tool waiting in the queue never starts", async () => {
  const queue = createSerialToolQueue();
  const abortController = new AbortController();
  let releaseFirst!: () => void;
  let queuedStarted = false;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = queue.run(() => firstGate);
  const queued = queue.run(async () => {
    queuedStarted = true;
  }, abortController.signal);

  abortController.abort("stopped");
  releaseFirst();
  await first;
  await assert.rejects(queued, { name: "AbortError" });
  assert.equal(queuedStarted, false);
});
