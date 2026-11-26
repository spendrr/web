// The Lightning invoice the till is showing right now (PosPanel's checkout or
// paid screen). Dashboard reads it so a payment for that invoice is not
// announced twice: the till's own paid screen already says it.
let activeHash: string | null = null;

export function setTillSale(paymentHash: string | null): void {
  activeHash = paymentHash;
}

export function isTillSale(paymentHash: string): boolean {
  return activeHash !== null && activeHash === paymentHash;
}
