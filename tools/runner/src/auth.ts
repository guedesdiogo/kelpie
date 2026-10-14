import { createHash, timingSafeEqual } from "node:crypto";

// Digests have one length, so comparing them takes the same time whatever the token's length.
const digest = (text: string) => createHash("sha256").update(text).digest();

/** Whether an `Authorization` header carries one of the runner's secrets as a bearer token. */
export function isAuthorized(header: string | null, secrets: readonly string[]): boolean {
  const token = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (token === undefined) return false;
  const given = digest(token);
  // Every secret is compared, so the time taken doesn't say which one matched.
  let authorized = false;
  for (const secret of secrets) {
    if (timingSafeEqual(given, digest(secret))) authorized = true;
  }
  return authorized;
}
