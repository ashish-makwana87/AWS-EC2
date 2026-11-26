import { describe, it, expect, jest } from "@jest/globals";
import { retryRequest, HttpError, isRetryableError } from "../utils/retry.js";

function createResponse(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("retryRequest", () => {
  // =================================
  // Test 1: Temporary failures followed by success
  // =================================

  it("should retry temporary failures and eventually succeed", async () => {
    let attempts = 0;

    const onRetry = jest.fn();

    const operation = jest.fn(async () => {
      attempts++;

      if (attempts <= 2) {
        return createResponse(503);
      }

      return createResponse(200, { success: true });
    });

    const response = await retryRequest(operation, {
      maxAttempts: 3,
      delays: [0, 0],
      onRetry,
    });

    const data = await response.json();

    expect(operation).toHaveBeenCalledTimes(3);
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  // =================================
  // Test 2: All attempts fail
  // =================================

  it("should stop after maximum attempts when all requests fail", async () => {
    const operation = jest.fn(async () => createResponse(503));

    const requestPromise = retryRequest(operation, {
      maxAttempts: 3,
      delays: [0, 0],
    });

    await expect(requestPromise).rejects.toBeInstanceOf(HttpError);
    await expect(requestPromise).rejects.toHaveProperty("status", 503);

    expect(operation).toHaveBeenCalledTimes(3);
  });

  // =================================
  // Test 3: Non-retryable HTTP error
  // =================================

  it("should not retry non-retryable HTTP errors", async () => {
    const operation = jest.fn(async () => createResponse(400));

    const requestPromise = retryRequest(operation, {
      maxAttempts: 3,
      delays: [0, 0],
    });

    await expect(requestPromise).rejects.toBeInstanceOf(HttpError);
    await expect(requestPromise).rejects.toHaveProperty("status", 400);

    expect(operation).toHaveBeenCalledTimes(1);
  });

  // =================================
  // Test 4: Temporary network failure followed by success
  // =================================

  it("should retry recognized network errors", async () => {
    let attempts = 0;

    const operation = jest.fn(async () => {
      attempts++;

      if (attempts === 1) {
        throw new Error("Connection reset", {
          cause: { code: "ECONNRESET" },
        });
      }

      return createResponse(200, { success: true });
    });

    const response = await retryRequest(operation, {
      maxAttempts: 3,
      delays: [0, 0],
    });

    expect(operation).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  // =================================
  // Test 5: Invalid retry configuration
  // =================================

  it("should reject invalid retry configuration", async () => {
    const operation = jest.fn(async () => createResponse(200));

    const requestPromise = retryRequest(operation, {
      maxAttempts: 0,
      delays: [],
    });

    await expect(requestPromise).rejects.toBeInstanceOf(RangeError);

    expect(operation).not.toHaveBeenCalled();
  });

  // =================================
  // Test 6: Timeout classification
  // =================================

  it("should treat native timeout errors as retryable", () => {
    const error = new DOMException("The operation timed out", "TimeoutError");

    expect(isRetryableError(error)).toBe(true);
  });
});
