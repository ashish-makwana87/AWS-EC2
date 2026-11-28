
import { randomUUID } from "node:crypto";

export class PaymentStore {
  constructor() {
    this.paymentsById = new Map();
    this.paymentsByIdempotencyKey = new Map();
  }

  createOrGetPayment({ idempotencyKey, orderId, amount, currency }) {
    const existingPaymentId =
      this.paymentsByIdempotencyKey.get(idempotencyKey);

    if (existingPaymentId) {
      const existingPayment = this.paymentsById.get(existingPaymentId);

      const samePayload =
        existingPayment.orderId === orderId &&
        existingPayment.amount === amount &&
        existingPayment.currency === currency;

      if (!samePayload) {
        return { created: false, conflict: true, payment: null };
      }

      return {
        created: false,
        conflict: false,
        payment: existingPayment,
      };
    }

    const payment = {
      paymentId: `pay_${randomUUID()}`,
      orderId,
      amount,
      currency,
      status: "PENDING",
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };

    this.paymentsById.set(payment.paymentId, payment);
    this.paymentsByIdempotencyKey.set(idempotencyKey, payment.paymentId);

    return { created: true, conflict: false, payment };
  }

  getPaymentById(paymentId) {
    return this.paymentsById.get(paymentId) ?? null;
  }

  updatePaymentStatus(paymentId, status) {
    const payment = this.paymentsById.get(paymentId);

    if (!payment) {
      return null;
    }

    payment.status = status;
    payment.updatedAt = new Date().toISOString();

    return payment;
  }
}
