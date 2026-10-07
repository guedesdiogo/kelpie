-- The built-in setup agent (Story 3.11) exists on every instance, the ones bootstrapped before it
-- too. It comes with the deploy, not from a person's request, so it has no audit row.
INSERT OR IGNORE INTO `agents` (`id`, `name`, `created_at`, `updated_at`)
VALUES ('setup', 'Setup', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
