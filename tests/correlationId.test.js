
import { describe, it, expect, jest } from "@jest/globals";
import { correlationIdMiddleware } from "../utils/correlationId.js";

describe("correlationIdMiddleware", () => {
  it("should accept a valid correlation ID", () => {
    const req = {
      get: jest.fn(() => "order-request-123"),
    };

    const res = {
      setHeader: jest.fn(),
    };

    const next = jest.fn();

    correlationIdMiddleware(req, res, next);

    expect(req.correlationId).toBe("order-request-123");

    expect(res.setHeader).toHaveBeenCalledWith(
      "x-correlation-id",
      "order-request-123",
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("should generate an ID when the header is missing", () => {
    const req = {
      get: jest.fn(() => undefined),
    };

    const res = {
      setHeader: jest.fn(),
    };

    const next = jest.fn();

    correlationIdMiddleware(req, res, next);

    expect(req.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    expect(res.setHeader).toHaveBeenCalledWith(
      "x-correlation-id",
      req.correlationId,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("should generate a new ID when the supplied ID is invalid", () => {
    const req = {
      get: jest.fn(() => "invalid correlation id!"),
    };

    const res = {
      setHeader: jest.fn(),
    };

    const next = jest.fn();

    correlationIdMiddleware(req, res, next);

    expect(req.correlationId).not.toBe("invalid correlation id!");

    expect(res.setHeader).toHaveBeenCalledWith(
      "x-correlation-id",
      req.correlationId,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });
});
