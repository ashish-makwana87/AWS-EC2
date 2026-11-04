import { test } from "node:test";
import assert from "node:assert/strict";

import {
  retryRequest,
  HttpError,
} from "../utils/retry.js";

function createResponse(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

// Test 1: Temporary failures followed by success
test("should retry temporary failures and eventually succeed", async () => {
  let attempts = 0;
  const retryEvents = [];

  const response = await retryRequest(
    async () => {
      attempts++;

      if (attempts <= 2) {
        return createResponse(503);
      }

      return createResponse(200, { success: true });
    },
    {
      maxAttempts: 3,
      delays: [0, 0],
      onRetry: (event) => retryEvents.push(event),
    }
  );

  const data = await response.json();

  assert.equal(attempts, 3);
  assert.equal(response.status, 200);
  assert.equal(data.success, true);
  assert.equal(retryEvents.length, 2);

  console.log("Test 1 passed: Temporary failures followed by success");
});

// Test 2: All attempts fail
test("should stop after maximum attempts when all requests fail", async () => {
  let attempts = 0;

  await assert.rejects(
    retryRequest(
      async () => {
        attempts++;
        return createResponse(503);
      },
      {
        maxAttempts: 3,
        delays: [0, 0],
      }
    ),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      return true;
    }
  );

  assert.equal(attempts, 3);

  console.log("Test 2 passed: Maximum attempts respected");
});

// Test 3: Non-retryable HTTP error
test("should not retry non-retryable HTTP errors", async () => {
  let attempts = 0;

  await assert.rejects(
    retryRequest(
      async () => {
        attempts++;
        return createResponse(400);
      },
      {
        maxAttempts: 3,
        delays: [0, 0],
      }
    ),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      return true;
    }
  );

  assert.equal(attempts, 1);

  console.log("Test 3 passed: Non-retryable error fails immediately");
});

// Test 4: Temporary network failure followed by success
test("should retry recognized network errors", async () => {
  let attempts = 0;

  const response = await retryRequest(
    async () => {
      attempts++;

      if (attempts === 1) {
        throw new Error("Connection reset", {
          cause: { code: "ECONNRESET" },
        });
      }

      return createResponse(200, { success: true });
    },
    {
      maxAttempts: 3,
      delays: [0, 0],
    }
  );

  assert.equal(attempts, 2);
  assert.equal(response.status, 200);

  console.log("Test 4 passed: Network failure followed by success");
});

// Test 5: Invalid retry configuration
test("should reject invalid retry configuration", async () => {
  await assert.rejects(
    retryRequest(
      async () => createResponse(200),
      {
        maxAttempts: 0,
        delays: [],
      }
    ),
    RangeError
  );

  console.log("Test 5 passed: Invalid configuration rejected");
});
