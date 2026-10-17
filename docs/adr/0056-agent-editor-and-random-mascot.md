# ADR-0056: A new agent starts with a random mascot, and the owner edits an agent from the webchat

- Status: Accepted
- Date: 2026-10-17
- Issue: [#379](https://github.com/guedesdiogo/kelpie/issues/379)
- Amended by: [ADR-0058](0058-owner-edits-agent-files-from-the-webchat.md), ingress also binds context-store's `AgentFiles`, its only path into the vault (§3)
- The owner approved #379's plan, which proposed this amendment, on 2026-10-16: «Aprovo os planos da #378, #379 e #381, incluindo a ADR proposta na #381 e os três preenchimentos da #377.»
- Amends:
  - [ADR-0045](0045-agent-mascot.md) §2: a new agent starts with a random mascot, saved as its setting, instead of one derived from its id; the owner changes it in the webchat's editor too;
  - [ADR-0052](0052-webchat-presence-sockets.md) §7: `AgentLooks` also names each agent's specialty and remit, and ingress binds one more entrypoint, `AgentEditor`, its only write path into agents.

## Context

The owner, on 2026-10-16, asked to edit a mascot from the chat:

> «quero que tenhamos como editar o mascote direto no chat, então precisamos ter alguma forma de acionar a tela de edição do mascote»

On the editor itself:

> «na edição do mascote, não faz sentido ter "voltar ao padrão", sempre que criar um agente novo ja sorteia uma configuração dele e deixe o usuário editar.»

And on what it edits besides the look:

> «Permita editar nome, descrição resumida e o nome da especialidade do agente, principal e setup não podem ser alterados»

**Before this ADR:**
- A mascot was set only through the configuration commands (ADR-0013), by asking Master, whose `configure_agent` waits for the owner's confirmation (ADR-0048).
- Until the owner picked one, an agent showed its default: Kelpie for the main agent, and a mascot derived from its id for any other (ADR-0045 §2). `null` went back to that default.
- Ingress could read each agent's mascot through `AgentLooks` (ADR-0052 §7), and could change nothing. Its `wrangler.jsonc` says why: binding the `AgentHost` would let the internet-facing Worker configure any agent.
- ADR-0048 retired the setup agent, so of «principal e setup» only the main agent's specialty stays fixed.

## Decision

### 1. A new agent starts with a random mascot

- **`createAgent` draws one,** from every option that exists when the agent is created, and saves it as the agent's `mascot` setting. A later option never changes it, since it is saved.
- **An agent created again** (`created: false`) keeps the look it has.
- **If the save fails,** the agent is still created, and it shows the mascot derived from its id until the owner picks one.
- **Agents that already exist keep the mascot they show:** the main agent its Kelpie, the others the one derived from their id. Their first edit saves it.
- **The editor has no "Back to default".** The configuration commands still take `null`, which keeps the derived default for Master's `configure_agent`.

### 2. A specialty, for the owner's eyes

- **`specialty` is a new agent setting:** one line of up to 40 characters, such as "Agenda e e-mail", empty by default.
- **It never reaches the agent's prompt.** It shows beside the name in the editor, and after the name in the agent switcher.
- **The main agent's is always "principal"** (in the page's language), by its role:
  - `configureAgent` refuses any change to the main agent's specialty with `not_allowed`;
  - the page writes the word itself, so it follows the role when `set_main_agent` moves it.

### 3. The editor's one write path

- **conversation-runtime gains an `AgentEditor` entrypoint with four methods,** and nothing else:
  - `setMascot`, the whole mascot, through `configureAgent`;
  - `rename`, through `renameAgent`;
  - `setRemit`, the agent's short description, through `configureAgent`;
  - `setSpecialty`, through `configureAgent`.
- **Each method builds its setting itself, from its one value.** Nothing else of the input reaches the agent's settings.
- **Ingress binds it, and still no `AgentHost`.** It passes the actor the Directory resolved, as `via: "webchat"`.
  - The binding's shape is the control: these four settings are all ingress can change.
  - The command checks that the actor is the owner. The actor is ingress's word, so that check catches a mistake in ingress, not a compromised ingress, which could already open the owner's conversation.
- **The routes:** `PUT /webchat/agents/<id>/mascot` and `PUT /webchat/agents/<id>/profile`. Each:
  - verifies the Access token, as the page and its socket do;
  - takes only a request whose `Origin` is the page's and whose `Sec-Fetch-Site` is `same-origin`, since browsers send the Access cookie with any site's request;
  - needs an agent the Registry lists and the Directory admits this login to, and the owner as the actor, before it reads the body;
  - takes only JSON, and reads at most 4 KB of it, counted in bytes, whatever length the request names;
  - validates the body before changing anything: the mascot with `parseMascot`, and the profile's name, remit and specialty as the settings take them;
  - answers with what the agent now shows.
- **The profile sets the fields it names,** the specialty first, so the field the main agent refuses changes nothing after it. When a later field fails, the answer names the fields already set.
- **A line the agent keeps** (a name, a remit, a specialty) takes no run of variation selectors, which show nothing and can carry hidden text into a prompt, and a remit or a specialty that isn't empty must show something, as a name must.
- **ADR-0055 §5's model chip** adds one method to this entrypoint, in its own story.

### 4. The owner's Save is the yes

- **ADR-0013 runs smaller changes, such as names, directly and audits them.** A mascot, a name, a remit and a specialty are such changes, so the editor's Save applies them without a confirmation. Each is audited as the owner's, through the webchat.
- **Master's `configure_agent` keeps its confirmation,** as ADR-0048 sets it.

### 5. What the webchat's list carries

- **`AgentLooks.looks` names each agent's mascot, specialty and remit,** read from its settings, and does nothing else. The list passes them on only as one line each.
- **`AgentLooks.mascots` stays** for the ingress of the release before, which calls it while a deploy reaches ingress after conversation-runtime (docs/deploy.md).

## Consequences

- The owner changes an agent's look, name, specialty and short description from its pencil in the webchat (`docs/design-system.md` 5.25), and the change reaches the header, the sidebar and the bot's photo (ADR-0046).
- Ingress has a write path into agents, limited to these four settings by the entrypoint's shape. A stolen Access session that is the owner's could change them, as it could talk to Master. A remit reaches the agent's prompt with no confirmation, behind Access, the origin checks and the page's content policy.
- Each mascot save asks Browser Run for a new bot photo, which ADR-0046 already limits to one every 5 minutes.
- A new agent's look is no longer reproducible from its id. Nothing depends on that: the derived mascot stays only for agents that never saved one.
- `AgentLooks.mascots` can go in a later change to this entrypoint.

## Alternatives considered

- **Bind the `AgentHost` in ingress.** It would let the internet-facing Worker configure any agent, any way.
- **Route the editor through Master's `configure_agent`.** Each save would wait for a confirmation the owner just gave with Save, and it would cost a model turn.
- **Keep deriving a new agent's mascot from its id, with "Back to default".** The owner asked for a random look to start from, and a saved one leaves the editor nothing to go back to.
- **Store "principal" as the main agent's specialty.** It wouldn't follow the role when Master moves, and the word belongs to the page's language.

## References

- [#379](https://github.com/guedesdiogo/kelpie/issues/379): the plan, the research (§8) and the reference projects' findings.
- [ADR-0013](0013-self-configuration.md), [ADR-0026](0026-confirmation-by-owner-act.md), [ADR-0036](0036-agent-roles-models-and-subagents.md), [ADR-0045](0045-agent-mascot.md), [ADR-0046](0046-telegram-bot-photo.md), [ADR-0048](0048-master-configures-kelpie.md), [ADR-0052](0052-webchat-presence-sockets.md), [ADR-0055](0055-composer-files-dictation-and-model.md).
- [`docs/design-system.md`](../design-system.md) 5.25, the editor.
