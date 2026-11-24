import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import {
  CircuitBreaker,
  CircuitOpenError,
} from "../utils/circuitBreaker.js";

import { isRetryableError } from "../utils/retry.js";

// Helper: create a retryable network error
function createRetryableError() {
  return new Error("Connection reset", {
    cause: {
      code: "ECONNRESET",
    },
  });
}

// Helper: create a circuit breaker with test configuration
function createBreaker(options = {}) {
  return new CircuitBreaker({
    failureThreshold: 3,
    openDuration: 1000,
    halfOpenMaxCalls: 1,
    shouldCountFailure: isRetryableError,
    ...options,
  });
}

// Helper: force the circuit into OPEN state
async function openCircuit(breaker) {
  for (let i = 0; i < 3; i++) {
    await expect(
      breaker.execute(async () => {
        throw createRetryableError();
      })
    ).rejects.toThrow("Connection reset");
  }

  expect(breaker.state).toBe("OPEN");
}

describe("CircuitBreaker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =================================
  // Test 1: Failure threshold
  // =================================

  it("should open the circuit after reaching the failure threshold", async () => {
    const breaker = createBreaker();

    const operation = jest.fn(async () => {
      throw createRetryableError();
    });

    for (let i = 0; i < 3; i++) {
      await expect(
        breaker.execute(operation)
      ).rejects.toThrow("Connection reset");
    }

    expect(operation).toHaveBeenCalledTimes(3);
    expect(breaker.state).toBe("OPEN");
  });

  // =================================
  // Test 2: Successful operation resets failure count
  // =================================

  it("should reset consecutive failure count after a successful operation", async () => {
    const breaker = createBreaker();

    // First operation fails
    await expect(
      breaker.execute(async () => {
        throw createRetryableError();
      })
    ).rejects.toThrow("Connection reset");

    expect(breaker.failureCount).toBe(1);

    // Second operation succeeds
    await breaker.execute(async () => "Success");

    expect(breaker.failureCount).toBe(0);
    expect(breaker.state).toBe("CLOSED");

    // Two more failures should not open the circuit
    for (let i = 0; i < 2; i++) {
      await expect(
        breaker.execute(async () => {
          throw createRetryableError();
        })
      ).rejects.toThrow("Connection reset");
    }

    expect(breaker.failureCount).toBe(2);
    expect(breaker.state).toBe("CLOSED");
  });

  // =================================
  // Test 3: OPEN state rejects requests
  // =================================

  it("should reject requests while OPEN without executing the operation", async () => {
    const breaker = createBreaker();

    await openCircuit(breaker);

    const operation = jest.fn(async () => "Success");

    await expect(
      breaker.execute(operation)
    ).rejects.toBeInstanceOf(CircuitOpenError);

    expect(operation).not.toHaveBeenCalled();
    expect(breaker.state).toBe("OPEN");
  });

  // =================================
  // Test 4: HALF_OPEN concurrency limit
  // =================================

  it("should allow only the configured number of concurrent HALF_OPEN probes", async () => {
    const breaker = createBreaker();

    await openCircuit(breaker);

    // Move OPEN -> HALF_OPEN
    jest.advanceTimersByTime(1000);

    let rejectOperation;

    const firstOperation = jest.fn(
      () =>
        new Promise((resolve, reject) => {
          rejectOperation = reject;
        })
    );

    // Start the first recovery probe without settling it
    const firstProbe = breaker.execute(firstOperation);

    expect(firstOperation).toHaveBeenCalledTimes(1);
    expect(breaker.state).toBe("HALF_OPEN");

    // A second probe must be rejected while the first is still running
    const secondOperation = jest.fn(async () => "Success");

    await expect(
      breaker.execute(secondOperation)
    ).rejects.toBeInstanceOf(CircuitOpenError);

    expect(secondOperation).not.toHaveBeenCalled();

    // Fail the first probe
    rejectOperation(createRetryableError());

    await expect(firstProbe).rejects.toThrow("Connection reset");

    expect(breaker.state).toBe("OPEN");
  });

  // ======================================
  // Test 5: Successful HALF_OPEN recovery
  // ======================================

  it("should close the circuit when a HALF_OPEN recovery probe succeeds", async () => {
    const breaker = createBreaker();

    await openCircuit(breaker);

    // Wait for OPEN duration
    jest.advanceTimersByTime(1000);

    const operation = jest.fn(async () => "Recovered");

    const result = await breaker.execute(operation);

    expect(result).toBe("Recovered");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(breaker.state).toBe("CLOSED");
    expect(breaker.failureCount).toBe(0);
  });

  // =================================
  // Test 6: Failed HALF_OPEN recovery
  // =================================

  it("should reopen the circuit when a HALF_OPEN recovery probe fails", async () => {
    const breaker = createBreaker();

    await openCircuit(breaker);

    // Wait for OPEN duration
    jest.advanceTimersByTime(1000);

    const operation = jest.fn(async () => {
      throw createRetryableError();
    });

    await expect(
      breaker.execute(operation)
    ).rejects.toThrow("Connection reset");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(breaker.state).toBe("OPEN");
  });

  // =================================
  // Test 7: Non-retryable errors
  // =================================

  it("should not count non-retryable errors towards the failure threshold", async () => {
    const breaker = createBreaker();

    const badRequestError = new Error("Bad request");
    badRequestError.status = 400;

    const operation = jest.fn(async () => {
      throw badRequestError;
    });

    await expect(
      breaker.execute(operation)
    ).rejects.toThrow("Bad request");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(breaker.failureCount).toBe(0);
    expect(breaker.state).toBe("CLOSED");
  });
});
