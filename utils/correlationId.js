import { randomUUID } from "node:crypto";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function correlationIdMiddleware(req, res, next) {
  const incomingId = req.get("x-correlation-id");

  const isValid =
    typeof incomingId === "string" &&
    CORRELATION_ID_PATTERN.test(incomingId);

  const correlationId = isValid ? incomingId : randomUUID();

  req.correlationId = correlationId;

  res.setHeader("x-correlation-id", correlationId);

  next();
}
