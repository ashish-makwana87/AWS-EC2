const CIRCUIT_STATES = {
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
};

export class CircuitOpenError extends Error {
  constructor(message, retryAfterMs = 0) {
    super(message);

    this.name = "CircuitOpenError";
    this.code = "CIRCUIT_OPEN";
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  constructor({
    failureThreshold = 3,
    openDuration = 10_000,
    halfOpenMaxCalls = 1,
    shouldCountFailure = () => true,
  } = {}) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new RangeError("failureThreshold must be a positive integer");
    }

    if (!Number.isFinite(openDuration) || openDuration < 0) {
      throw new RangeError("openDuration must be a non-negative number");
    }

    if (!Number.isInteger(halfOpenMaxCalls) || halfOpenMaxCalls < 1) {
      throw new RangeError("halfOpenMaxCalls must be a positive integer");
    }

    if (typeof shouldCountFailure !== "function") {
      throw new TypeError("shouldCountFailure must be a function");
    }
    this.failureThreshold = failureThreshold;
    this.openDuration = openDuration;
    this.halfOpenMaxCalls = halfOpenMaxCalls;

    this.state = CIRCUIT_STATES.CLOSED;
    this.failureCount = 0;

    this.openedAt = null;
    this.halfOpenCalls = 0;
    this.shouldCountFailure = shouldCountFailure;
  }

  transitionTo(newState) {
    const previousState = this.state;

    if (previousState === newState) {
      return;
    }

    this.state = newState;

    console.log(`Circuit breaker state transitioned: ${previousState} → ${newState}`);
  }

  openCircuit() {
    this.openedAt = Date.now();
    this.halfOpenCalls = 0;

    this.transitionTo(CIRCUIT_STATES.OPEN);
  }

  closeCircuit() {
    this.failureCount = 0;
    this.openedAt = null;
    this.halfOpenCalls = 0;

    this.transitionTo(CIRCUIT_STATES.CLOSED);
  }

  checkState() {
    if (this.state !== CIRCUIT_STATES.OPEN) {
      return;
    }

    const elapsedTime = Date.now() - this.openedAt;

    if (elapsedTime >= this.openDuration) {
      this.halfOpenCalls = 0;

      this.transitionTo(CIRCUIT_STATES.HALF_OPEN);
    }
  }

  async execute(operation) {

    if (typeof operation !== "function") {
      throw new TypeError("operation must be a function");
    }

    // Check whether OPEN duration has expired.
    this.checkState();

    // Reject requests while circuit is OPEN.
    if (this.state === CIRCUIT_STATES.OPEN) {
      const elapsedTime = Date.now() - this.openedAt;

      const retryAfterMs = Math.max(0, this.openDuration - elapsedTime);

      throw new CircuitOpenError(
        "Circuit breaker is OPEN. Dependency call rejected.",
        retryAfterMs,
      );
    }

    // Allow only a limited number of recovery probes.
    if (this.state === CIRCUIT_STATES.HALF_OPEN) {
      if (this.halfOpenCalls >= this.halfOpenMaxCalls) {
        throw new CircuitOpenError(
          "Circuit breaker is HALF_OPEN. Recovery probe already in progress.",
        );
      }

      // Reserve the probe before awaiting the operation.
      this.halfOpenCalls++;
    }

    try {
      const result = await operation();

      // Successful recovery probe.
      if (this.state === CIRCUIT_STATES.HALF_OPEN) {
        this.closeCircuit();
      } else if (this.state === CIRCUIT_STATES.CLOSED) {
        // Reset consecutive failures after success.
        this.failureCount = 0;
      }

      return result;
    } catch (error) {

      if (!this.shouldCountFailure(error)) {
        
        if (this.state === CIRCUIT_STATES.HALF_OPEN) {
          this.halfOpenCalls = Math.max(0, this.halfOpenCalls - 1);
        }

        throw error;
      }

      if (this.state === CIRCUIT_STATES.HALF_OPEN) {
        // Recovery probe failed. Reopen the circuit.
        this.openCircuit();
      } else if (this.state === CIRCUIT_STATES.CLOSED) {
        this.failureCount++;

        console.warn(
          `Circuit breaker failure count: ${this.failureCount}/${this.failureThreshold}`,
        );

        if (this.failureCount >= this.failureThreshold) {
          this.openCircuit();
        }
      }

      throw error;
    }
  }
}
