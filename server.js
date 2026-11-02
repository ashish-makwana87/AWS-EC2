import express from "express";
import dotenv from "dotenv";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

app.disable("x-powered-by");
app.use(express.json());


function runCalculationInWorker(limit, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./workers/calculation.worker.js", import.meta.url)
    );

    let settled = false;

    const timeout = setTimeout(() => {
      worker.terminate().catch(() => {});

      finish(
        new Error(`Worker exceeded the ${timeoutMs}ms time limit`)
      );
    }, timeoutMs);

    function finish(error, result) {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }

    worker.once("message", (result) => {
      finish(null, result);
    });

    worker.once("error", (error) => {
      finish(error);
    });

    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(new Error(`Worker exited with code ${code}`));
      } else if (!settled) {
        finish(new Error("Worker exited without returning a result"));
      }
    });

    worker.postMessage({ limit });
  });
}


// Basic API endpoint
app.get("/", (req, res) => {
  res.status(200).json({
    message: "AWS-EC2 Node.js server is running",
    environment: process.env.NODE_ENV || "development",
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

//CPU-blocking endpoint
app.get("/debug/cpu-blocking", (req, res) => {
  const limit = Number(req.query.limit ?? 50_000_000);

  if (
    !Number.isSafeInteger(limit) ||
    limit < 100_000 ||
    limit > 50_000_000
  ) {
    return res.status(400).json({
      message: "limit must be an integer between 100000 and 50000000",
    });
  }

  const start = performance.now();

  let checksum = 0;

  for (let i = 0; i < limit; i++) {
    checksum += Math.sqrt(i % 1000);
  }

  const calculationTimeMs = Number(
    (performance.now() - start).toFixed(2)
  );

  return res.status(200).json({
    message: "CPU-intensive operation completed on main thread",
    limit,
    checksum: Number(checksum.toFixed(2)),
    calculationTimeMs,
  });
});

// Worker Thread endpoint
app.get("/debug/cpu-worker", async (req, res, next) => {
  const limit = Number(req.query.limit ?? 10_000_000);

  if (
    !Number.isSafeInteger(limit) ||
    limit < 100_000 ||
    limit > 50_000_000
  ) {
    return res.status(400).json({
      message: "limit must be an integer between 100000 and 50000000",
    });
  }

  try {
    const result = await runCalculationInWorker(limit);

    return res.status(200).json({
      message: "CPU calculation completed in Worker Thread",
      ...result,
    });
  } catch (error) {
    return next(error);
  }
});


// Handle unknown routes
app.use((req, res) => {
  res.status(404).json({
    message: "Route not found",
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});

// Graceful shutdown for process managers such as systemd
function shutdown(signal) {
  console.log(`${signal} received. Closing HTTP server...`);

  server.close((error) => {
    if (error) {
      console.error("Error while closing server:", error);
      process.exitCode = 1;
    }

    process.exit();
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
