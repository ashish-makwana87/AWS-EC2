
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

export class HttpError extends Error {
  constructor(message, status, responseBody) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function isRetryableError(error) {
  // Retry selected HTTP responses.
  if (error instanceof HttpError) {
    return (
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    );
  }

  // Retry recognized temporary network failures.
  const errorCode = error?.cause?.code ?? error?.code;

  return RETRYABLE_NETWORK_ERROR_CODES.has(errorCode);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryRequest(
  operation,
  {
    maxAttempts = 3,
    delays = [100, 500],
    onRetry,
  } = {}
) {
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function");
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  if (
    !Array.isArray(delays) ||
    delays.length < maxAttempts - 1 ||
    delays.slice(0, maxAttempts - 1).some(
      (delay) => !Number.isFinite(delay) || delay < 0
    )
  ) {
    throw new RangeError(
      "Provide a valid delay for each retry attempt"
    );
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await operation({ attempt });

      if (!response || typeof response.ok !== "boolean") {
        throw new TypeError(
          "operation must return a Fetch Response"
        );
      }

      if (!response.ok) {
        const responseBody = await response.clone().text();

        throw new HttpError(
          `Dependency request failed with HTTP ${response.status}`,
          response.status,
          responseBody
        );
      }

      return response;
    } catch (error) {
      const shouldRetry = isRetryableError(error);
      const attemptsRemaining = attempt < maxAttempts;

      if (!shouldRetry || !attemptsRemaining) {
        throw error;
      }

      const delayMs = delays[attempt - 1];

      onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        error,
      });

      await sleep(delayMs);
    }
  }
}
