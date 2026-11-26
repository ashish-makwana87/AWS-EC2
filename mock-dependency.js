import express from "express";
import dotenv from "dotenv";
import { correlationIdMiddleware } from "./utils/correlationId.js";

dotenv.config();

const app = express();
app.use(correlationIdMiddleware);

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const HOST = process.env.MOCK_HOST ?? "127.0.0.1";

const MOCK_MODE = process.env.MOCK_MODE ?? "temporary";

const FAIL_FIRST_N_REQUESTS = Number(
  process.env.MOCK_FAILURES ?? 2
);

const MOCK_DELAY_MS = Number(
  process.env.MOCK_DELAY_MS ?? 5000
);

const VALID_MODES = [
  "temporary",
  "failure",
  "slow",
  "healthy",
];

if (!VALID_MODES.includes(MOCK_MODE)) {
  throw new Error(
    `Invalid MOCK_MODE: ${MOCK_MODE}. Allowed modes: ${VALID_MODES.join(", ")}`
  );
}

let requestCount = 0;

// Health check
app.get("/health", (req, res) => {
  return res.status(200).json({
    status: "healthy",
    service: "mock-dependent-service",
    mode: MOCK_MODE
  });
});

// Simulated dependency endpoint 
app.get("/dependency", async (req, res) => {
  requestCount++;

  const attempt = requestCount;

  console.log(
    `[ID:${req.correlationId}] [MODE:${MOCK_MODE}] Dependency request received: Attempt ${attempt}`
  );

  // MODE 1: Continuous failures
  if (MOCK_MODE === "failure") {
    console.log(`[ID:${req.correlationId}] Attempt ${attempt}: Simulating HTTP 503`);

    return res.status(503).json({
      correlationId: req.correlationId,
      success: false,
      message: "Mock service continuously unavailable",
      mode: MOCK_MODE,
      attempt,
    });
  }

  // MODE 2: Temporary failures followed by recovery
  if (
    MOCK_MODE === "temporary" &&
    attempt <= FAIL_FIRST_N_REQUESTS
  ) {
    console.log(`[ID:${req.correlationId}] Attempt ${attempt}: Simulating HTTP 503`);

    return res.status(503).json({
      correlationId: req.correlationId,
      success: false,
      message: "Mock service temporarily unavailable",
      mode: MOCK_MODE,
      attempt,
    });
  }

  // MODE 3: Slow dependency
  if (MOCK_MODE === "slow") {
    console.log(
      `[ID:${req.correlationId}] Attempt ${attempt}: Delaying response by ${MOCK_DELAY_MS}ms`
    );

    await new Promise((resolve) =>
      setTimeout(resolve, MOCK_DELAY_MS)
    );
  }

  // MODE 4: Healthy dependency
  // Also reached after temporary and slow mode.
  console.log(`[ID:${req.correlationId}] Attempt ${attempt}: Returning HTTP 200`);

  return res.status(200).json({
    correlationId: req.correlationId,
    success: true,
    message: "Mock dependency request successful",
    mode: MOCK_MODE,
    attempt,
  });
});

app.listen(PORT, HOST, () => {
  console.log(
    `Mock dependent service running at http://${HOST}:${PORT}`
  );

  console.log(`Mock mode: ${MOCK_MODE}`);

  if (MOCK_MODE === "temporary") {
    console.log(
      `First ${FAIL_FIRST_N_REQUESTS} requests will fail.`
    );
  }

  if (MOCK_MODE === "slow") {
    console.log(`Response delay: ${MOCK_DELAY_MS}ms`);
  }
});