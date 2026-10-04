// Application-level encryption for the secret store (ADR-0013): AES-GCM under a key kept as a
// Worker secret. Each value gets a fresh random IV, and its slot name is the additional data, so a
// ciphertext copied into another slot doesn't decrypt.

export interface Sealed {
  keyVersion: number;
  iv: string;
  ciphertext: string;
}

/** Bumped when the key is rotated; values record the version that sealed them. */
export const KEY_VERSION = 1;

/** Imports the store's key: 32 bytes, base64. Anything else is refused, so the store fails closed. */
export async function importSecretsKey(base64: string | undefined): Promise<CryptoKey> {
  const bytes = base64 ? fromBase64(base64) : null;
  if (bytes?.byteLength !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, slot: string, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(slot) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    keyVersion: KEY_VERSION,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

/** The plaintext, or null when the value was tampered with, moved to another slot or sealed with another key. */
export async function open(key: CryptoKey, slot: string, sealed: Sealed): Promise<string | null> {
  const iv = fromBase64(sealed.iv);
  const ciphertext = fromBase64(sealed.ciphertext);
  if (!iv || !ciphertext || sealed.keyVersion !== KEY_VERSION) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(slot) },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/** A random token for links and webhook secrets: `bytes` random bytes, base64url without padding. */
export function randomToken(bytes = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
