import express from "express";
import dotenv from "dotenv";
import { correlationIdMiddleware } from "./utils/correlationId.js";
import { PaymentStore } from "./utils/paymentStore.js";

dotenv.config();

const app = express();
app.use(correlationIdMiddleware);
app.use(express.json());

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const HOST = process.env.MOCK_HOST ?? "127.0.0.1";

const MOCK_MODE = process.env.MOCK_MODE ?? "temporary";

const FAIL_FIRST_N_REQUESTS = Number(process.env.MOCK_FAILURES ?? 2);

const MOCK_DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 5000);

const VALID_MODES = ["temporary", "failure", "slow", "healthy"];

if (!VALID_MODES.includes(MOCK_MODE)) {
  throw new Error(
    `Invalid MOCK_MODE: ${MOCK_MODE}. Allowed modes: ${VALID_MODES.join(", ")}`,
  );
}

let requestCount = 0;
const paymentStore = new PaymentStore();

const PAYMENT_PROCESSING_DELAY_MS = Number(
  process.env.PAYMENT_PROCESSING_DELAY_MS ?? 1000,
);

const PAYMENT_PROCESSING_MODE =
  process.env.PAYMENT_PROCESSING_MODE ?? "success";

const PAYMENT_RESPONSE_DELAY_MS = Number(
  process.env.PAYMENT_RESPONSE_DELAY_MS ?? 5000,
);

const VALID_PAYMENT_MODES = ["success", "failure", "timeout_after_success"];

if (
  !Number.isFinite(PAYMENT_PROCESSING_DELAY_MS) ||
  PAYMENT_PROCESSING_DELAY_MS <= 0
) {
  throw new Error("PAYMENT_PROCESSING_DELAY_MS must be a positive number");
}

if (
  !Number.isFinite(PAYMENT_RESPONSE_DELAY_MS) ||
  PAYMENT_RESPONSE_DELAY_MS <= 0
) {
  throw new Error("PAYMENT_RESPONSE_DELAY_MS must be a positive number");
}

if (!VALID_PAYMENT_MODES.includes(PAYMENT_PROCESSING_MODE)) {
  throw new Error(
    `Invalid PAYMENT_PROCESSING_MODE: ${PAYMENT_PROCESSING_MODE}. Allowed modes: ${VALID_PAYMENT_MODES.join(", ")}`,
  );
}

function processPayment(paymentId, correlationId) {

  return new Promise((resolve) => {
    
    setTimeout(() => {
      const status =
        PAYMENT_PROCESSING_MODE === "failure" ? "FAILED" : "SUCCESS";

      const payment = paymentStore.updatePaymentStatus(paymentId, status);

      console.log(
        `[ID:${correlationId}] Payment ${paymentId} processed with status: ${status}`,
      );

      resolve(payment);
    }, PAYMENT_PROCESSING_DELAY_MS);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Health check
app.get("/health", (req, res) => {
  return res.status(200).json({
    status: "healthy",
    service: "mock-dependent-service",
    mode: MOCK_MODE,
  });
});

// POST payment
app.post("/payments", async (req, res) => {
  const idempotencyKey = req.get("Idempotency-Key");

  const { orderId, amount, currency } = req.body ?? {};

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

  // Create a new payment or retrieve an existing one
  const result = paymentStore.createOrGetPayment({
    idempotencyKey,
    orderId: orderId.trim(),
    amount,
    currency,
  });

  // Same key used with different payment details
  if (result.conflict) {
    return res.status(409).json({
      correlationId: req.correlationId,
      message: "Idempotency key already used with different payment details",
    });
  }

  // If the payment already exists, do not process it again
  if (!result.created) {
    console.log(
      `[ID:${req.correlationId}] Existing payment returned: ${result.payment.paymentId}`,
    );

    return res.status(200).json({
      correlationId: req.correlationId,
      message: "Existing payment returned",
      payment: result.payment,
    });
  }

  // Process only newly created payments
  console.log(
    `[ID:${req.correlationId}] Payment created: ${result.payment.paymentId}`,
  );

  const processedPayment = await processPayment(
    result.payment.paymentId,
    req.correlationId,
  );

  // Simulate a successful payment whose HTTP response arrives late
  if (PAYMENT_PROCESSING_MODE === "timeout_after_success") {
    console.log(
      `[ID:${req.correlationId}] Payment succeeded. Delaying HTTP response by ${PAYMENT_RESPONSE_DELAY_MS}ms`,
    );

    await delay(PAYMENT_RESPONSE_DELAY_MS);
  }

  return res.status(201).json({
    correlationId: req.correlationId,
    message: "Payment processed",
    payment: processedPayment,
  });
});

// GET Payment
app.get("/payments/:paymentId", (req, res) => {
  const payment = paymentStore.getPaymentById(req.params.paymentId);

  if (!payment) {
    return res.status(404).json({
      correlationId: req.correlationId,
      message: "Payment not found",
    });
  }

  return res.status(200).json({
    correlationId: req.correlationId,
    payment,
  });
});

// Simulated dependency endpoint
app.get("/dependency", async (req, res) => {
  requestCount++;

  const attempt = requestCount;

  console.log(
    `[ID:${req.correlationId}] [MODE:${MOCK_MODE}] Dependency request received: Attempt ${attempt}`,
  );

  // MODE 1: Continuous failures
  if (MOCK_MODE === "failure") {
    console.log(
      `[ID:${req.correlationId}] Attempt ${attempt}: Simulating HTTP 503`,
    );

    return res.status(503).json({
      correlationId: req.correlationId,
      success: false,
      message: "Mock service continuously unavailable",
      mode: MOCK_MODE,
      attempt,
    });
  }

  // MODE 2: Temporary failures followed by recovery
  if (MOCK_MODE === "temporary" && attempt <= FAIL_FIRST_N_REQUESTS) {
    console.log(
      `[ID:${req.correlationId}] Attempt ${attempt}: Simulating HTTP 503`,
    );

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
      `[ID:${req.correlationId}] Attempt ${attempt}: Delaying response by ${MOCK_DELAY_MS}ms`,
    );

    await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS));
  }

  // MODE 4: Healthy dependency
  // Also reached after temporary and slow mode.
  console.log(
    `[ID:${req.correlationId}] Attempt ${attempt}: Returning HTTP 200`,
  );

  return res.status(200).json({
    correlationId: req.correlationId,
    success: true,
    message: "Mock dependency request successful",
    mode: MOCK_MODE,
    attempt,
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Mock dependent service running at http://${HOST}:${PORT}`);

  console.log(`Mock mode: ${MOCK_MODE}`);

  console.log(`Payment processing mode: ${PAYMENT_PROCESSING_MODE}`);
  console.log(`Payment processing delay: ${PAYMENT_PROCESSING_DELAY_MS}ms`);

  if (PAYMENT_PROCESSING_MODE === "timeout_after_success") {
    console.log(`Payment response delay: ${PAYMENT_RESPONSE_DELAY_MS}ms`);
  }

  if (MOCK_MODE === "temporary") {
    console.log(`First ${FAIL_FIRST_N_REQUESTS} requests will fail.`);
  }

  if (MOCK_MODE === "slow") {
    console.log(`Response delay: ${MOCK_DELAY_MS}ms`);
  }
});


