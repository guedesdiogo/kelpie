-- The main agent (ADR-0036 §1, #288): a new instance, with no agent but the setup agent, starts
-- with it, named Kelpie. An instance that already has agents gets none: its owner picks which one
-- becomes the main agent. It comes with the deploy, not from a person's request, so it has no
-- audit row.
INSERT INTO `agents` (`id`, `name`, `created_at`, `updated_at`, `role`, `chat`)
SELECT 'kelpie', 'Kelpie', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'main', 1
WHERE NOT EXISTS (SELECT 1 FROM `agents` WHERE `id` <> 'setup');
