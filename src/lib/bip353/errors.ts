// Every failure of the BIP 353 resolve path is one of these codes. The send
// flow maps a code to copy; it never falls back to an unvalidated result.
//
//   malformed   the proof or a record is not well-formed (also: over a limit)
//   no_record   the name has no bitcoin: payment record (nothing to pay)
//   untrusted   the DNSSEC chain does not lead to the root trust anchor
//   expired     a signature on the chain is outside its validity window
//   unsupported only algorithms we refuse (SHA-1, unknown) or a required
//               URI parameter we do not understand
//   ambiguous   more than one candidate payment record or method parameter
//   resolver    the DoH side failed (retryable, nothing was decided)
export type Bip353ErrorCode = "malformed" | "no_record" | "untrusted" | "expired" | "unsupported" | "ambiguous" | "resolver";

export class Bip353Error extends Error {
  code: Bip353ErrorCode;
  constructor(code: Bip353ErrorCode, message: string) {
    super(message);
    this.name = "Bip353Error";
    this.code = code;
  }
}
