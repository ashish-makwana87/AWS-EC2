import express from "express";
import dotenv from "dotenv";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { retryRequest, isRetryableError } from "./utils/retry.js";
import { CircuitBreaker, CircuitOpenError } from "./utils/circuitBreaker.js";
import { correlationIdMiddleware } from "./utils/correlationId.js";

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const MOCK_DEPENDENCY_URL = process.env.MOCK_DEPENDENCY_URL;
const MOCK_PAYMENT_URL = process.env.MOCK_PAYMENT_URL?.replace(/\/+$/, "");

const DEPENDENCY_TIMEOUT_MS = Number(process.env.DEPENDENCY_TIMEOUT_MS ?? 2000);

if (!Number.isInteger(DEPENDENCY_TIMEOUT_MS) || DEPENDENCY_TIMEOUT_MS <= 0) {
  throw new Error("DEPENDENCY_TIMEOUT_MS must be a positive integer");
}

function fetchDependency(correlationId) {
  return fetch(MOCK_DEPENDENCY_URL, {
    signal: AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS),
    headers: {
      "x-correlation-id": correlationId,
    },
  });
}


async function readPaymentResponse(response) {
  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data.message ?? `Payment service returned HTTP ${response.status}`
    );

    error.status = response.status;
    throw error;
  }

  return data;
}

async function createPaymentAtMockService({
  orderId,
  amount,
  currency,
  idempotencyKey,
  correlationId,
}) {
  const response = await fetch(MOCK_PAYMENT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "x-correlation-id": correlationId,
    },
    body: JSON.stringify({
      orderId,
      amount,
      currency,
    }),
    signal: AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS),
  });

  return readPaymentResponse(response);
}

async function getPaymentStatusFromMockService(
  paymentId,
  correlationId
) {
  const response = await fetch(
    `${MOCK_PAYMENT_URL}/${encodeURIComponent(paymentId)}`,
    {
      method: "GET",
      headers: {
        "x-correlation-id": correlationId,
      },
      signal: AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS),
    }
  );

  return readPaymentResponse(response);
}

app.disable("x-powered-by");
app.use(correlationIdMiddleware);
app.use(express.json());

function runCalculationInWorker(limit, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./workers/calculation.worker.js", import.meta.url),
    );

    let settled = false;

    const timeout = setTimeout(() => {
      worker.terminate().catch(() => {});

      finish(new Error(`Worker exceeded the ${timeoutMs}ms time limit`));
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

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});



// Create payment for an order
app.post("/orders/:orderId/payment", async (req, res) => {
  if (!MOCK_PAYMENT_URL) {
    return res.status(500).json({
      correlationId: req.correlationId,
      message: "MOCK_PAYMENT_URL is not configured",
    });
  }

  const { orderId } = req.params;
  const { amount, currency } = req.body ?? {};
  const idempotencyKey = req.get("Idempotency-Key");

  // Validate idempotency key
  if (
    typeof idempotencyKey !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)
  ) {
    return res.status(400).json({
      correlationId: req.correlationId,
      message: "Missing or invalid Idempotency-Key header",
    });
  }

  // Validate payment details
  if (
    typeof orderId !== "string" ||
    orderId.trim().length === 0 ||
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    return res.status(400).json({
      correlationId: req.correlationId,
      message: "Invalid payment details",
    });
  }

  const paymentRequest = {
    orderId,
    amount,
    currency,
    idempotencyKey,
    correlationId: req.correlationId,
  };

  try {
    // STEP 1: Send the original payment request
    const result = await createPaymentAtMockService(paymentRequest);

    console.log(
      `[${req.correlationId}] Payment request completed: ${result.payment.paymentId}`
    );

    return res.status(200).json({
      correlationId: req.correlationId,
      message: "Payment request completed",
      reconciled: false,
      payment: result.payment,
    });
  } catch (error) {
    // Handle errors other than a timeout
    if (error.name !== "TimeoutError") {
      console.error(
        `[${req.correlationId}] Payment request failed: ${error.message}`
      );

      return res.status(error.status || 502).json({
        correlationId: req.correlationId,
        message: "Payment service request failed",
        error: error.message,
      });
    }

    // STEP 2: The original payment request timed out
    console.warn(
      `[${req.correlationId}] Payment request timed out. Starting reconciliation.`
    );
  }

  // STEP 3: Repeat the same request using the SAME idempotency key
  try {
    const recoveredResult = await createPaymentAtMockService(
      paymentRequest
    );

    const paymentId = recoveredResult.payment?.paymentId;

    if (!paymentId) {
      throw new Error(
        "Payment service did not return a payment ID during recovery"
      );
    }

    console.log(
      `[${req.correlationId}] Recovered payment ID: ${paymentId}`
    );

    // STEP 4: Retrieve the actual payment status using the payment ID
    const statusResult = await getPaymentStatusFromMockService(
      paymentId,
      req.correlationId
    );

    const payment = statusResult.payment;

    if (!payment) {
      throw new Error("Payment service returned an invalid status response");
    }

    console.log(
      `[${req.correlationId}] Reconciled payment status: ${payment.status}`
    );

    // STEP 5: Return the confirmed payment status
    return res.status(payment.status === "PENDING" ? 202 : 200).json({
      correlationId: req.correlationId,
      message: "Payment status reconciled after request timeout",
      reconciled: true,
      payment,
    });
  } catch (reconciliationError) {
    console.error(
      `[${req.correlationId}] Payment reconciliation failed: ${reconciliationError.message}`
    );

    return res.status(504).json({
      correlationId: req.correlationId,
      message:
        "Payment request timed out and payment status could not be confirmed",
      paymentStatus: "UNKNOWN",
      error: reconciliationError.message,
      instruction:
        "Do not retry using a new idempotency key. Reconcile using the original key.",
    });
  }
});


//CPU-blocking endpoint
app.get("/debug/cpu-blocking", (req, res) => {
  const limit = Number(req.query.limit ?? 50_000_000);

  if (!Number.isSafeInteger(limit) || limit < 100_000 || limit > 50_000_000) {
    return res.status(400).json({
      message: "limit must be an integer between 100000 and 50000000",
    });
  }

  const start = performance.now();

  let checksum = 0;

  for (let i = 0; i < limit; i++) {
    checksum += Math.sqrt(i % 1000);
  }

  const calculationTimeMs = Number((performance.now() - start).toFixed(2));

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

  if (!Number.isSafeInteger(limit) || limit < 100_000 || limit > 50_000_000) {
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

// Circuit Breaker instance
const dependencyCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  openDuration: 10_000,
  halfOpenMaxCalls: 1,
  shouldCountFailure: isRetryableError,
});

// Retry endpoint
app.get("/debug/retry", async (req, res) => {
  if (!MOCK_DEPENDENCY_URL) {
    return res.status(500).json({
      message: "MOCK_DEPENDENCY_URL is not configured",
    });
  }

  let attempts = 0;

  try {
    const response = await retryRequest(
      async ({ attempt }) => {
        attempts = attempt;

        console.log(
          `[${req.correlationId}] Calling dependency: Attempt ${attempt}`,
        );

        return fetchDependency(req.correlationId);
      },
      {
        maxAttempts: 3,
        delays: [100, 500],

        onRetry: ({ attempt, nextAttempt, delayMs, error }) => {
          console.log(
            `[${req.correlationId}] Attempt ${attempt} failed. Retrying attempt ${nextAttempt} in ${delayMs}ms. Error: ${error.message}`,
          );
        },
      },
    );

    const data = await response.json();

    return res.status(200).json({
      correlationId: req.correlationId,
      message: "Dependency request successful",
      totalAttempts: attempts,
      dependency: data,
    });
  } catch (error) {
    console.error(`[${req.correlationId}] Dependency request failed`);

    return res.status(error.status || 502).json({
      correlationId: req.correlationId,
      message: "Dependency request failed after retry attempts",
      totalAttempts: attempts,
      error: error.message,
    });
  }
});

// Circuit breaker endpoint
app.get("/debug/resilience", async (req, res) => {
  if (!MOCK_DEPENDENCY_URL) {
    return res.status(500).json({
      message: "MOCK_DEPENDENCY_URL is not configured",
    });
  }

  let attempts = 0;

  try {
    const response = await dependencyCircuitBreaker.execute(async () => {
      return retryRequest(
        async ({ attempt }) => {
          attempts = attempt;

          console.log(
            `[${req.correlationId}] Calling dependency: Attempt ${attempt}`,
          );

          return fetchDependency(req.correlationId);
        },
        {
          maxAttempts: dependencyCircuitBreaker.state === "HALF_OPEN" ? 1 : 3,
          delays:
            dependencyCircuitBreaker.state === "HALF_OPEN" ? [] : [100, 500],

          onRetry: ({ attempt, nextAttempt, delayMs, error }) => {
            console.log(
              `[${req.correlationId}] Attempt ${attempt} failed. Retrying attempt ${nextAttempt} in ${delayMs}ms. Error: ${error.message}`,
            );
          },
        },
      );
    });

    const data = await response.json();

    return res.status(200).json({
      correlationId: req.correlationId,
      message: "Dependency request successful",
      totalAttempts: attempts,
      circuitState: dependencyCircuitBreaker.state,
      dependency: data,
    });
  } catch (error) {
    console.error(`[${req.correlationId}] Dependency resilience request failed:`, error.message);

    if (error instanceof CircuitOpenError) {
      return res.status(503).json({
        correlationId: req.correlationId,
        message: "Dependency circuit is unavailable",
        circuitState: dependencyCircuitBreaker.state,
        retryAfterMs: error.retryAfterMs,
      });
    }

    return res.status(error.status || 502).json({
      correlationId: req.correlationId,
      message: "Dependency request failed after retry attempts",
      totalAttempts: attempts,
      circuitState: dependencyCircuitBreaker.state,
      error: error.message,
    });
  }
});

// Basic API endpoint
app.get("/", (req, res) => {
  res.status(200).json({
    message: "AWS-EC2 Node.js server is running",
    environment: process.env.NODE_ENV || "development",
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
