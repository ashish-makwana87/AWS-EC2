import { performance } from "node:perf_hooks";

const BASE_URL = process.env.BASE_URL;

if (!BASE_URL) {
  console.error("Set BASE_URL to your deployed EC2 API URL.");
  process.exit(1);
}

const HEALTH_URL = `${BASE_URL}/health`;
const CPU_URL = `${BASE_URL}/debug/cpu-blocking?durationMs=500`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measureRequest(url) {
  const start = performance.now();

  try {
    const response = await fetch(url);
    await response.text();

    return {
      status: response.status,
      latencyMs: Number((performance.now() - start).toFixed(2)),
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

    console.log(
      `Health ${i}: ${result.latencyMs} ms (HTTP ${result.status})`
    );

    if (result.status !== 200) {
      throw new Error("Health endpoint did not return HTTP 200.");
    }
  }

  const averageBaseline =
    baseline.reduce((sum, value) => sum + value, 0) / baseline.length;

  console.log(`Average baseline: ${averageBaseline.toFixed(2)} ms`);

  console.log("\n--- Experiment: CPU request + health request ---");

  const cpuPromise = measureRequest(CPU_URL);

  // Give the CPU request a head start.
  await delay(50);

  const healthPromise = measureRequest(HEALTH_URL);

  const [cpu, health] = await Promise.all([cpuPromise, healthPromise]);

  console.log(`CPU request:    ${cpu.latencyMs} ms (HTTP ${cpu.status})`);
  console.log(`Health request: ${health.latencyMs} ms (HTTP ${health.status})`);
  console.log(
    `Health slowdown: ${(health.latencyMs - averageBaseline).toFixed(2)} ms`
  );

  if (cpu.status !== 200 || health.status !== 200) {
    throw new Error("A request failed; check the endpoint and deployment.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
