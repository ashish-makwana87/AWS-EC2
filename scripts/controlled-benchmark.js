import autocannon from "autocannon";
import { performance } from "node:perf_hooks";

const BASE_URL = process.argv[2];
const CPU_MODE = process.argv[3];

const CONNECTIONS = 10;
const TEST_DURATION_SECONDS = 60;
const CPU_START_DELAY_MS = 1000;
const CPU_DURATION_MS = 57_000;
const CPU_LIMIT = 50_000_000;

if (!BASE_URL || !["blocking", "worker"].includes(CPU_MODE)) {
  console.error(
    "Usage: node scripts/controlled-benchmark.js <BASE_URL> <blocking|worker>"
  );
  process.exit(1);
}

const HEALTH_URL = `${BASE_URL}/health`;

const CPU_PATH =
  CPU_MODE === "blocking"
    ? "/debug/cpu-blocking"
    : "/debug/cpu-worker";

const CPU_URL = `${BASE_URL}${CPU_PATH}?limit=${CPU_LIMIT}`;

const delay = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function runCpuWorkload() {
  const deadline = performance.now() + CPU_DURATION_MS;

  let completed = 0;
  let failed = 0;

  console.log("\nCPU workload started.");

  while (performance.now() < deadline) {
    try {
      const response = await fetch(CPU_URL);
      await response.text();

      if (response.ok) {
        completed++;
      } else {
        failed++;
        console.error(`CPU request failed: HTTP ${response.status}`);
      }
    } catch (error) {
      failed++;
      console.error("CPU request error:", error.message);
    }
  }

  console.log("\nCPU workload finished.");
  console.log(`CPU requests completed: ${completed}`);
  console.log(`CPU requests failed: ${failed}`);
}

async function main() {
  console.log("\n========== BENCHMARK CONFIGURATION ==========");
  console.log(`Mode: ${CPU_MODE}`);
  console.log(`Health URL: ${HEALTH_URL}`);
  console.log(`CPU URL: ${CPU_URL}`);
  console.log(`Connections: ${CONNECTIONS}`);
  console.log(`Test duration: ${TEST_DURATION_SECONDS} seconds`);
  console.log("=============================================\n");

  const benchmarkPromise = new Promise((resolve, reject) => {
    autocannon(
      {
        url: HEALTH_URL,
        connections: CONNECTIONS,
        duration: TEST_DURATION_SECONDS,
        pipelining: 1,
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
    );
  });

  console.log("Autocannon started.");

  await delay(CPU_START_DELAY_MS);

  await runCpuWorkload();

  const result = await benchmarkPromise;

  console.log("\n========== AUTO CANNON RESULTS ==========\n");
  console.log(autocannon.printResult(result));
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exitCode = 1;
});
