
import { describe, it, expect, beforeEach } from "@jest/globals";
import { PaymentStore } from "../utils/paymentStore.js";

describe("PaymentStore", () => {
  let paymentStore;

  beforeEach(() => {
    paymentStore = new PaymentStore();
  });

  const paymentDetails = {
    idempotencyKey: "order-123",
    orderId: "order-123",
    amount: 1500,
    currency: "INR",
  };

  it("creates a new payment with PENDING status", () => {
    const result = paymentStore.createOrGetPayment(paymentDetails);

    expect(result.created).toBe(true);
    expect(result.conflict).toBe(false);
    expect(result.payment.paymentId).toMatch(/^pay_/);
    expect(result.payment.status).toBe("PENDING");
    expect(result.payment.updatedAt).toBeNull();
  });

  it("returns the existing payment for the same key and payload", () => {
    const first = paymentStore.createOrGetPayment(paymentDetails);
    const second = paymentStore.createOrGetPayment(paymentDetails);

    expect(second.created).toBe(false);
    expect(second.conflict).toBe(false);
    expect(second.payment.paymentId).toBe(first.payment.paymentId);
  });

  it("does not create duplicate payments for the same key", () => {
    paymentStore.createOrGetPayment(paymentDetails);
    paymentStore.createOrGetPayment(paymentDetails);

    expect(paymentStore.paymentsById.size).toBe(1);
  });

  it("returns a conflict for the same key with different payment details", () => {
    paymentStore.createOrGetPayment(paymentDetails);

    const result = paymentStore.createOrGetPayment({
      ...paymentDetails,
      amount: 2500,
    });

    expect(result.created).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.payment).toBeNull();
  });

  it("creates separate payments for different idempotency keys", () => {
    paymentStore.createOrGetPayment(paymentDetails);

    paymentStore.createOrGetPayment({
      ...paymentDetails,
      idempotencyKey: "order-456",
      orderId: "order-456",
    });

    expect(paymentStore.paymentsById.size).toBe(2);
  });

  it("retrieves a payment using its payment ID", () => {
    const result = paymentStore.createOrGetPayment(paymentDetails);

    const payment = paymentStore.getPaymentById(
      result.payment.paymentId
    );

    expect(payment).toEqual(result.payment);
  });

  it("returns null for an unknown payment ID", () => {
    const payment = paymentStore.getPaymentById("unknown-payment");

    expect(payment).toBeNull();
  });

  it("handles concurrent calls with the same idempotency key", async () => {
    const [first, second] = await Promise.all([
      Promise.resolve().then(() =>
        paymentStore.createOrGetPayment(paymentDetails)
      ),
      Promise.resolve().then(() =>
        paymentStore.createOrGetPayment(paymentDetails)
      ),
    ]);

    expect(first.payment.paymentId).toBe(second.payment.paymentId);
    expect(paymentStore.paymentsById.size).toBe(1);
  });

  it("updates a payment status to SUCCESS", () => {
    const result = paymentStore.createOrGetPayment(paymentDetails);

    const updatedPayment = paymentStore.updatePaymentStatus(
      result.payment.paymentId,
      "SUCCESS"
    );

    expect(updatedPayment.status).toBe("SUCCESS");
    expect(updatedPayment.updatedAt).not.toBeNull();
  });

  it("updates a payment status to FAILED", () => {
    const result = paymentStore.createOrGetPayment(paymentDetails);

    const updatedPayment = paymentStore.updatePaymentStatus(
      result.payment.paymentId,
      "FAILED"
    );

    expect(updatedPayment.status).toBe("FAILED");
    expect(updatedPayment.updatedAt).not.toBeNull();
  });

  it("returns null when updating an unknown payment ID", () => {
    const result = paymentStore.updatePaymentStatus(
      "unknown-payment",
      "SUCCESS"
    );

    expect(result).toBeNull();
  });

  it("updates the updatedAt timestamp when payment status changes", () => {
    const result = paymentStore.createOrGetPayment(paymentDetails);

    const updatedPayment = paymentStore.updatePaymentStatus(
      result.payment.paymentId,
      "SUCCESS"
    );

    expect(updatedPayment.updatedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(updatedPayment.updatedAt))).toBe(false);
  });
});
