// Fingerprint/biometric unlock via the WebAuthn PRF extension.
//
// A platform authenticator (fingerprint) alone only proves presence — it
// can't decrypt anything on its own. The PRF extension lets a compatible
// authenticator derive a stable secret from the credential + a salt we
// supply; we use that secret as an AES-GCM key to encrypt the mnemonic in a
// *second*, separate vault. The password vault (crypto.ts) is never touched
// or replaced — biometric unlock is strictly additive, and password unlock
// keeps working even if this is enabled.
//
// PRF support can't be feature-detected in advance; it's only known after
// attempting registration and checking getClientExtensionResults().prf.

import { fromB64, toB64 } from "./crypto";

// Android's system credential picker (choose Google Password Manager vs. a
// local/device-bound credential) has been observed to occasionally never
// return control to the page — the create()/get() promise just hangs
// forever instead of resolving or rejecting, leaving the UI stuck on
// "Nastavuji…" with no error. Race it against a timeout so there's always
// a clear outcome.
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface BioVault {
  credentialIdB64: string;
  saltB64: string;
  ivB64: string;
  cipherB64: string;
}

const BIO_VAULT_KEY = "btc-wallet-bio-vault";

// Not a real capability check for PRF (no such API exists) — just whether a
// platform authenticator is present at all, used to decide whether it's
// worth offering the "enable fingerprint unlock" button.
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function hasBiometricUnlock(): boolean {
  return localStorage.getItem(BIO_VAULT_KEY) !== null;
}

export function clearBiometricUnlock(): void {
  localStorage.removeItem(BIO_VAULT_KEY);
}

// Sentinel for "the assertion succeeded but carried no PRF secret". Enrolment
// turns it into the "unsupported" message; a normal unlock shows it as-is.
const PRF_NO_OUTPUT = "Ověření proběhlo, ale zařízení nevrátilo očekávaný klíč. Zkus to prosím znovu.";

// The browser's own WebAuthn errors are English boilerplate ("The operation
// either timed out or was not allowed. See: https://..."). A cancelled or
// timed-out dialog is what NotAllowedError means in practice.
function describeWebAuthnError(e: unknown): string {
  if (e instanceof DOMException && e.name === "NotAllowedError") {
    return "Ověření bylo zrušeno nebo vypršelo. Zkus to prosím znovu.";
  }
  return e instanceof Error ? e.message : String(e);
}

interface PrfExtensionInputs {
  prf: { eval?: { first: BufferSource }; enable?: boolean };
}

interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

async function derivePrfKey(credentialId: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const assertion = (await withTimeout(
    navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)) as BufferSource,
        allowCredentials: [{ id: credentialId.buffer as BufferSource, type: "public-key" }],
        userVerification: "required",
        extensions: { prf: { eval: { first: salt.buffer as BufferSource } } } as PrfExtensionInputs,
      },
    }),
    45_000,
    "Ověření otiskem trvalo příliš dlouho a bylo zrušeno. Zkus to prosím znovu.",
  )) as PublicKeyCredential | null;
  if (!assertion) throw new Error("Ověření otiskem selhalo nebo bylo zrušeno.");
  const results = assertion.getClientExtensionResults() as PrfExtensionResults;
  const prfOutput = results.prf?.results?.first;
  if (!prfOutput) {
    throw new Error(PRF_NO_OUTPUT);
  }
  // extractable: false, so the key bytes cannot be read back out of the
  // CryptoKey. That does not make this realm unable to use it: the key still
  // decrypts, and prfOutput itself was readable here until the fill below.
  // Main-thread code can therefore recover the seed during a biometric
  // unlock; see the threat-model note in walletSession.ts.
  const key = await crypto.subtle.importKey("raw", prfOutput, "AES-GCM", false, ["encrypt", "decrypt"]);
  // The raw PRF output has served its purpose the moment it's imported;
  // unlike the CryptoKey it produced, this buffer *is* readable, so don't
  // leave it lying in the heap waiting on GC.
  new Uint8Array(prfOutput).fill(0);
  return key;
}

// Takes the seed as raw bytes rather than a string: the caller (Settings)
// gets them straight out of decryptVaultBytes and zeroes them afterwards,
// so enrolling a fingerprint never creates an unzeroable plaintext mnemonic
// string in the main-thread heap. Same reason the unlock path below hands
// back an unwrapping key instead of a mnemonic — see ARCHITECTURE.md.
export async function enrollBiometricUnlock(mnemonicBytes: Uint8Array): Promise<void> {
  const credential = (await withTimeout(
    navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)) as BufferSource,
        rp: { name: "Bitcoin peněženka" },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)) as BufferSource,
          name: "btc-wallet",
          displayName: "Bitcoin peněženka",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
        extensions: { prf: { enable: true } } as PrfExtensionInputs,
        timeout: 60_000,
      },
    }),
    45_000,
    "Nastavení otisku trvalo příliš dlouho a bylo zrušeno. Zkus to prosím znovu.",
  ).catch((e: unknown) => {
    throw new Error(describeWebAuthnError(e));
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Vytvoření otisku se nezdařilo nebo bylo zrušeno.");

  // `prf.enabled` is only a hint: some browser/authenticator combinations
  // leave it unset at registration although a later get() with `eval` does
  // return a secret. So it does not decide anything by itself; the real test
  // is whether derivePrfKey() below actually gets a key back. Nothing is
  // persisted until it does, so a device without PRF still ends in the same
  // "unsupported" error, just after the attempt instead of before it.
  const prfResults = credential.getClientExtensionResults() as PrfExtensionResults;
  const credentialId = new Uint8Array(credential.rawId);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  let key: CryptoKey;
  try {
    key = await derivePrfKey(credentialId, salt);
  } catch (e) {
    // Keep the real cause: a cancelled dialog, a timeout and a genuine lack of
    // PRF used to all read as "unsupported". The bracket is a short technical
    // hint (error name + what registration reported) for a bug report.
    const name = e instanceof Error ? e.name : "?";
    const hint = `[${name}, enabled=${String(prfResults.prf?.enabled)}]`;
    if (e instanceof Error && e.message === PRF_NO_OUTPUT) {
      throw new Error(
        `Tenhle prohlížeč na tomhle zařízení odemykání otiskem nepodporuje (chybí podpora PRF). Zkus jiný prohlížeč, třeba Safari, nebo zůstaň u hesla. ${hint}`,
      );
    }
    throw new Error(`${describeWebAuthnError(e)} ${hint}`);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    mnemonicBytes as BufferSource,
  );
  const vault: BioVault = {
    credentialIdB64: toB64(credentialId.buffer as ArrayBuffer),
    saltB64: toB64(salt.buffer as ArrayBuffer),
    ivB64: toB64(iv.buffer as ArrayBuffer),
    cipherB64: toB64(cipher),
  };
  localStorage.setItem(BIO_VAULT_KEY, JSON.stringify(vault));
}

// Everything a biometric unlock needs to be *completed inside the wallet
// worker*: the AES-GCM key the authenticator's PRF produced, plus the
// ciphertext it opens.
export interface BiometricUnwrap {
  // Non-extractable (see derivePrfKey) and structured-cloneable, so it can
  // be posted into the worker. The main thread cannot read its bytes but CAN
  // use it to decrypt; honest code here just never does.
  unwrapKey: CryptoKey;
  ivB64: string;
  cipherB64: string;
}

// Note this deliberately does NOT decrypt: it stops one step short and
// hands the material to the caller, which forwards it to the worker (see
// walletSession.ts's "bioVault" source). navigator.credentials only exists
// on the main thread, so the WebAuthn half has to happen here. The decryption
// doesn't, so the plaintext seed stays out of this realm's heap; that guards
// against passive leaks, not against hostile code here, which could do the
// decrypt itself with the same key.
export async function unlockWithBiometric(): Promise<BiometricUnwrap> {
  const raw = localStorage.getItem(BIO_VAULT_KEY);
  if (!raw) throw new Error("Odemykání otiskem není na tomto zařízení nastavené.");
  const vault = JSON.parse(raw) as BioVault;
  const credentialId = fromB64(vault.credentialIdB64);
  const salt = fromB64(vault.saltB64);
  const unwrapKey = await derivePrfKey(credentialId, salt);
  return { unwrapKey, ivB64: vault.ivB64, cipherB64: vault.cipherB64 };
}
