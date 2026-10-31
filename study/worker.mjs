// One task, one thread. See isolated.mjs.
import { parentPort, workerData } from 'node:worker_threads';
import { observe } from './observe.mjs';
import { scanCandidate } from './scan.mjs';

const TASKS = {
  observe: ({ entry, now, digestKey }) => observe(entry, { now: new Date(now), digestKey }),
  scan: ({ candidate }) => scanCandidate(candidate),
};

const result = await TASKS[workerData.task](workerData.payload);
parentPort.postMessage(result);
// Open SSE streams and sockets must not keep the thread alive after the answer.
process.exit(0);
