// Every talk with an unknown server happens in its own thread. A timer in the same thread cannot
// fire while the event loop is blocked, but a worker can always be terminated from the outside.
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256 };

/** Never rejects: resolves with the task's result, or with { isolationFailure } and a short reason. */
export function runIsolated(task, payload, hardTimeoutMs, workerUrl = WORKER_URL) {
  return new Promise((resolve) => {
    const worker = new Worker(workerUrl, { workerData: { task, payload }, resourceLimits: RESOURCE_LIMITS, stdout: true, stderr: true });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Termination failures would only concern a thread we no longer listen to.
      worker.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => finish({ isolationFailure: 'hard_timeout' }), hardTimeoutMs);
    worker.once('message', finish);
    worker.once('error', (error) => finish({ isolationFailure: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out_of_memory' : 'worker_crash' }));
    worker.once('exit', () => finish({ isolationFailure: 'worker_crash' }));
  });
}

/** Runs tasks with a small pool, in order of arrival. onResult is called as soon as each one ends. */
export async function mapPool(items, size, task, onResult = async () => {}) {
  const results = new Array(items.length);
  let next = 0;
  async function work() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
      await onResult(results[index]);
    }
  }
  await Promise.all(Array.from({ length: size }, work));
  return results;
}
