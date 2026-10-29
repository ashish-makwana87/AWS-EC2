
import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";

if (!parentPort) {
  throw new Error("This file must run inside a Worker Thread.");
}

parentPort.once("message", ({ limit }) => {
  const start = performance.now();

  let checksum = 0;

  for (let i = 0; i < limit; i++) {
    checksum += Math.sqrt(i % 1000);
  }

  const calculationTimeMs = Number(
    (performance.now() - start).toFixed(2)
  );

  parentPort.postMessage({
    limit,
    checksum: Number(checksum.toFixed(2)),
    calculationTimeMs,
    message: "Calculation completed inside Worker Thread",
  });

  parentPort.close();
});
