import express from "express";
import dotenv from "dotenv";
import { performance } from "node:perf_hooks";

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

app.disable("x-powered-by");
app.use(express.json());

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

app.get("/debug/cpu-blocking", (req, res) => {
  const durationMs = Number(req.query.durationMs ?? 500);

  if (
    !Number.isInteger(durationMs) ||
    durationMs < 100 ||
    durationMs > 1000
  ) {
    return res.status(400).json({
      message: "durationMs must be an integer between 100 and 1000",
    });
  }

  const start = performance.now();
  let iterations = 0;
  let checksum = 0;

  // Deliberately perform synchronous CPU work.
  // This blocks the Node.js event loop.
  while (performance.now() - start < durationMs) {
    iterations += 1;
    checksum += Math.sqrt(iterations % 1000);
  }

  const actualDurationMs = Math.round(performance.now() - start);

  return res.status(200).json({
    message: "CPU-intensive operation completed",
    requestedDurationMs: durationMs,
    actualDurationMs,
    iterations,
    checksum: Number(checksum.toFixed(2)),
  });
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
