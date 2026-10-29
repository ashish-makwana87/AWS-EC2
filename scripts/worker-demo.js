import { Worker } from "node:worker_threads";

const worker = new Worker(
  new URL("../workers/calculation.worker.js", import.meta.url)
);

console.log("Main thread: sending calculation to worker...");

worker.postMessage({
  limit: 10_000_000,
});

worker.on("message", (result) => {
  console.log("Main thread: result received from worker:");
  console.log(result);
});

worker.on("error", (error) => {
  console.error("Worker error:", error);
});

worker.on("exit", (code) => {
  console.log(`Worker exited with code ${code}`);
});
