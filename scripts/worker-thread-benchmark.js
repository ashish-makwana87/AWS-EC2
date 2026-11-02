import { performance } from "node:perf_hooks";

const WORKER_LIMIT = 50_000_000;
const BASE_URL = process.env.BASE_URL;

if (!BASE_URL) {
  console.error("Set BASE_URL to your deployed EC2 API URL.");
  process.exit(1);
}

const HEALTH_URL = `${BASE_URL}/health`;
const WORKER_URL = `${BASE_URL}/debug/cpu-worker?limit=${WORKER_LIMIT}`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measureRequest(url) {
  const start = performance.now();

  try {
    const response = await fetch(url);
    const body = await response.text();

    let data;

    try {
      data = JSON.parse(body);
    } catch {
      data = {};
    }

    return {
      status: response.status,
      latencyMs: Number((performance.now() - start).toFixed(2)),
      calculationTimeMs: data.calculationTimeMs,
    };
  } catch (error) {
    throw new Error(`Request failed for ${url}: ${error.message}`);
  }
}

async function main() {
  console.log("\n--- Baseline: health requests only ---");

  const baseline = [];

  for (let i = 1; i <= 5; i++) {
    const result = await measureRequest(HEALTH_URL);
    baseline.push(result.latencyMs);

    console.log(`Health ${i}: ${result.latencyMs} ms (HTTP ${result.status})`);

    if (result.status !== 200) {
      throw new Error("Health endpoint did not return HTTP 200.");
    }
  }

  const averageBaseline =
    baseline.reduce((sum, value) => sum + value, 0) / baseline.length;

  console.log(`Average baseline: ${averageBaseline.toFixed(2)} ms`);

  for (let round = 1; round <= 5; round++) {
  console.log(`\n--- Worker experiment: round ${round} ---`);

  const workerPromise = measureRequest(WORKER_URL);

  await delay(50);

  const healthPromise = measureRequest(HEALTH_URL);

  const [worker, health] = await Promise.all([
    workerPromise,
    healthPromise,
  ]);

  console.log(
    `Worker: ${worker.latencyMs} ms, ` +
    `calculation: ${worker.calculationTimeMs ?? "N/A"} ms`
  );

  console.log(`Health: ${health.latencyMs} ms`);
}

  if (worker.status !== 200 || health.status !== 200) {
    throw new Error("A request failed; check the endpoint and deployment.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
