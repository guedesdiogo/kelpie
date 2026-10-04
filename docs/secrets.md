# Secrets

Kelpie keeps two kinds of secret (ADR-0013).

- **Deploy secrets.** The owner sets these with `wrangler secret put`:
  - the first model key, on `llm-gateway`;
  - the bootstrap token, on `admin-api` (`docs/admin-api.md`);
  - the store's encryption key, `SECRETS_KEY` on `channel-egress`.
- **Everything else** (a bot token, an API key) goes into Kelpie's secret store through a one-time secure form, never through chat.

## The secret store

- **Where it lives.** The `SecretStore` Durable Object, in the `channel-egress` Worker.
- **Encryption.** Each value is encrypted with AES-GCM under `SECRETS_KEY`.
  - Every write gets a fresh 12-byte IV.
  - The slot's name (for example `telegram:sales`) is the additional authenticated data, so a value copied into another slot doesn't decrypt.
  - Each value records the version of the key that sealed it.
- **Who reads it.** Only `channel-egress` binds the store, because reading returns plaintext. Other Workers reach it through `channel-egress`'s entrypoints, which return no secret:
  - `ChannelForms`, for the admin API, creates, describes and redeems forms;
  - `ChannelEgress`, for the conversation runtime, sends and shows typing.
- **Forms.**
  - A link carries a random 256-bit token. The store keeps only its SHA-256.
  - It expires after 15 minutes and works once.
  - A Telegram bot token is checked with `getMe` before it is stored, so a refused token leaves the form open for another try.
- **Failing closed.** A missing or malformed `SECRETS_KEY` keeps the store closed: nothing is read or written.

## Making the key

`SECRETS_KEY` is 32 random bytes, base64. This command makes one and stores it without printing it:

```bash
openssl rand -base64 32 | tr -d '\n' | bunx wrangler secret put SECRETS_KEY -c apps/channel-egress/wrangler.jsonc
```

Losing or replacing the key makes every stored secret unreadable. The owner then enters them again through new forms. Rotating the key without that step isn't built yet; the recorded key version leaves room for it.
