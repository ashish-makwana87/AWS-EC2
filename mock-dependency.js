import express from "express";

const app = express();

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const HOST = process.env.MOCK_HOST ?? "127.0.0.1";

const FAIL_FIRST_N_REQUESTS = Number(
  process.env.MOCK_FAILURES ?? 2
);

let requestCount = 0;

app.get("/health", (req, res) => {
  return res.status(200).json({
    status: "healthy",
    service: "mock-dependent-service",
  });
});

app.get("/dependency", (req, res) => {
  requestCount++;

  console.log(`Dependency request received: Attempt ${requestCount}`);

  if (requestCount <= FAIL_FIRST_N_REQUESTS) {
    console.log(`Attempt ${requestCount}: Simulating HTTP 503`);

    return res.status(503).json({
      success: false,
      message: "Mock service temporarily unavailable",
      attempt: requestCount,
    });
  }

  console.log(`Attempt ${requestCount}: Returning HTTP 200`);

  return res.status(200).json({
    success: true,
    message: "Mock dependency request successful",
    attempt: requestCount,
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Mock dependent service running at http://${HOST}:${PORT}`);
  console.log(`First ${FAIL_FIRST_N_REQUESTS} requests will fail.`);
});

