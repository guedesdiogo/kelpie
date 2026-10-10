# ADR-0027: Kelpie's fixed texts follow the conversation, in English, Portuguese or Spanish

- Status: Accepted
- Date: 2026-10-10
- Issue: [#187](https://github.com/guedesdiogo/kelpie/issues/187)
- Accepted by the owner on 2026-10-10: «no minimo ingles, pt-br, espanhol para todas as telas e escolher usando o idioma que esta selecionado como padrão ou por default usar inglês se for diferente desses 3 idiomas»

## Context

[ADR-0025](0025-turn-tool-loop.md) says Kelpie's fixed texts are in English, while the model answers in the person's language. In the owner's first setup runs the conversation was in Portuguese, and these texts came in English:
- the confirmation notice;
- the bubbles with the secure form's and the pairing page's links;
- the paused message;
- Telegram's "paired" notice;
- the pages behind the links.

On 2026-10-07, on #48, the owner first chose a language they would set themselves. On 2026-10-10 they widened it:
- three languages;
- every screen behind Kelpie's links;
- the language is chosen from what the person uses, or from what their device has selected, or else English;
- for the chat, «manter o idioma da conversa».

The reference check on #187 found no prior art for choosing per conversation: hermes-agent has one global language per profile and never reads Telegram's `language_code` or `Accept-Language`.

## Decision

This amends ADR-0025's "the fixed texts are in English".

1. **Three languages.** Kelpie's own texts come in English, Brazilian Portuguese (`pt-BR`, which `pt` also maps to) and Spanish (`es`). Any other language gets English. Each text has the same placeholders in every language, and a test holds them to English's.
2. **In a chat, the conversation's language.**
   - It is the language the person's latest messages are written in, read by a small detector of words and letters that mark one of the three languages. The language stays while the messages say nothing clear ("ok", a code).
   - Until the messages say, the latest message's device language counts: Telegram's `language_code`, or the language the webchat page names. Failing that, English.
   - A text is written in the language of its moment and stored, so a later change doesn't rewrite what was sent.
3. **A page follows the conversation that sent its link.**
   - Kelpie's links name the language (`?lang=`), and the page's own form posts to the same URL, so its answer keeps the language.
   - A page opened by hand follows the browser's first choice in `Accept-Language`. A later choice doesn't stand in for an unsupported first one.
4. **Elsewhere, the device's language.**
   - The webchat page's own texts follow the browser.
   - Telegram's "paired" notice follows the account that paired, since that account has no conversation yet.
   - A stranger notice follows the language the owner's account was last seen in. The Directory keeps it with the identity.
5. **Not covered yet:** the vault's own texts (its README and pull requests) and session pages stay in English.

The language is never a security input. A wrong guess only changes the language of a text.

## Consequences

- The ingress-to-conversation contract gains an optional `language`, on a message and on the webchat's admission. An ingress deployed before the runtime sends none, and English is the fallback.
- The Directory's identities keep the app language last seen, written only when it changes.
- Tool labels may come in each language.
- **Residual:** the detector can't read a short line whose words the three languages share (such as "conecta o bot"). The conversation then keeps the language it had, or falls back to the device's.

## Alternatives considered

- **A language setting the owner chooses** (the 2026-10-07 plan). It is simpler and exact, but it doesn't follow a conversation in another language, and the owner asked for Kelpie to follow what is used. It can come back as an override.
- **The device's language only.** A phone set to English while the owner writes Portuguese would get English notices, against «manter o idioma da conversa».
- **The model translating Kelpie's texts.** The notices would be model-written again, which ADR-0013 and ADR-0026 keep them from being.

## References

- [ADR-0013](0013-self-configuration.md), [ADR-0025](0025-turn-tool-loop.md), [ADR-0026](0026-confirmation-by-owner-act.md)
- [#187](https://github.com/guedesdiogo/kelpie/issues/187), where the reference check is recorded
