/** Written to the vault when it has no README.md, so people and other agents know its layout. */
export const VAULT_README = `# Vault

This repository is a second brain: Markdown that people and agents read and edit, in Obsidian, on
GitHub or in any editor. Kelpie is one of its clients. Removing Kelpie loses nothing: every index it
builds is derived from these files.

## Layout

\`\`\`
README.md           this file
AGENTS.md           operational rules for every agent
knowledge/          free-form notes; [[wikilinks]] are followed
memory/             memory everyone shares, by kind: people/, places/, preferences/, ...
areas/<name>/       memory and notes of one area of life or work
skills/             <category>/<name>/SKILL.md, shared skills
agents/<agent-id>/
  SOUL.md           the agent's persona
  AGENTS.md         rules that add to the shared ones
  memory/           the agent's own memory
  skills/           the agent's own skills
\`\`\`

Kelpie's memory files are described in its docs (\`docs/memory-format.md\` in the Kelpie repository).

## How Kelpie writes

- Memory and knowledge are committed directly, in small batches. Each commit names the agent that
  made it with a trailer: \`Kelpie-Agent: <agent-id>\`.
- Changes to a persona, rules or skills arrive as pull requests for the owner to approve.
- Edits made here by anyone else count as the owner's. If the owner and Kelpie change the same file
  at the same time, the owner's version wins.
- Erasing something means rewriting this repository's history; Kelpie then rebuilds its index.
`;
