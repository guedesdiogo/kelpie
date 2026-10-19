import type { Locale, Localized } from "@kelpie/channels";
import type { CommandResult, Proposal, ProposalDetail } from "@kelpie/config";
import { escapeHtml, page } from "./forms.ts";

// The proposals' pages (ADR-0036 §3, ADR-0061, #302): the owner reads a proposed change in full and
// approves or refuses it there, and only that submission decides it (ADR-0026 §1). They follow the
// design system's "Confirm an action" (docs/design-system.md 5.3) as a page with no script: who
// asks, by id; the change, field by field; the agent's words as quoted data; then the answers.

/** The path's proposal: "" for the list, an id-shaped segment for one, null for any other path. */
export function proposalPathOf(pathname: string): string | null {
  if (pathname === "/proposals") return "";
  return pathname.startsWith("/proposals/") ? pathname.slice("/proposals/".length) : null;
}

type Settled = "applied" | "refused" | "expired" | "conflict" | "void";

interface Texts {
  title: string;
  listTitle: string;
  intro: (proposer: string, target: string) => string;
  fromTask: (task: string) => string;
  expires: (hours: number) => string;
  reasonLabel: string;
  field: string;
  now: string;
  proposed: string;
  none: string;
  /** A tools setting of `null`: no list, so every tool it is given. */
  everyTool: string;
  fields: Record<string, string>;
  stale: string;
  approve: string;
  refuse: string;
  applying: string;
  /** What became of a proposal, on its page and after a decision. */
  settled: Record<Settled, { title: string; body: (target: string) => string }>;
  already: { title: string; body: string };
  /** An approval taken whose result a service didn't report: Kelpie settles it. */
  taken: { title: string; body: string };
  unknown: { title: string; body: string };
  unavailable: { title: string; body: string };
  choose: { title: string; body: string };
  empty: string;
  listItem: (proposer: string, target: string, fields: string, hours: number) => string;
}

const TEXTS: Localized<Texts> = {
  en: {
    title: "A proposed change",
    listTitle: "Proposals",
    intro: (proposer, target) => `${proposer} proposes a change to ${target}, an agent it owns.`,
    fromTask: (task) => `It came from the run of its task ${task}.`,
    expires: (hours) =>
      `It waits for your decision ${hours} more ${hours === 1 ? "hour" : "hours"}; then it expires, and nothing changes.`,
    reasonLabel: "In the agent's own words",
    field: "Setting",
    now: "Now",
    proposed: "Proposed",
    none: "(none)",
    everyTool: "Every tool it is given: no list limits it.",
    fields: {
      model: "Model",
      tools: "Tools",
      remit: "Remit",
      spawn: "Subagents",
      chat: "Chat",
      systemPrompt: "Soul",
      skills: "Skills",
    },
    stale:
      "The agent changed since this proposal, so approving it would apply nothing. Refuse it; the agent can propose again if it still needs the change.",
    approve: "Approve",
    refuse: "Refuse",
    applying: "This proposal is being applied. Open this page again in a few minutes.",
    settled: {
      applied: {
        title: "Approved",
        body: (target) => `This proposal was approved: the change to ${target} is applied.`,
      },
      refused: {
        title: "Refused",
        body: () => "This proposal was refused. Nothing changed, and Kelpie tells the agent.",
      },
      expired: {
        title: "Expired",
        body: () => "This proposal expired before a decision. Nothing changed.",
      },
      conflict: {
        title: "Not applied",
        body: (target) =>
          `${target} changed since this proposal, so nothing was applied. Kelpie tells the agent.`,
      },
      void: {
        title: "No longer applies",
        body: () => "An agent this proposal named was deleted. Nothing changed.",
      },
    },
    already: {
      title: "Already decided",
      body: "This proposal was already decided. Open its page again to see how.",
    },
    taken: {
      title: "Approval taken",
      body: "Your approval was taken, but a Kelpie service didn't answer while it was applied. Kelpie settles it within a few minutes: open the proposal's page again to see how it ended.",
    },
    unknown: { title: "No such proposal", body: "Check the link Kelpie sent you." },
    unavailable: {
      title: "Try again in a moment",
      body: "A Kelpie service didn't answer. Nothing changed.",
    },
    choose: { title: "Choose an answer", body: "Press Approve or Refuse on the proposal's page." },
    empty:
      "No proposal waits for you. When an agent proposes a change, Kelpie sends you its page in your conversation with Master.",
    listItem: (proposer, target, fields, hours) =>
      `${proposer} proposes a change to ${target}: ${fields}. It expires in ${hours} ${hours === 1 ? "hour" : "hours"}.`,
  },
  "pt-BR": {
    title: "Uma mudança proposta",
    listTitle: "Propostas",
    intro: (proposer, target) =>
      `${proposer} propõe uma mudança em ${target}, um agente que pertence a ele.`,
    fromTask: (task) => `Ela veio da execução da tarefa ${task} dele.`,
    expires: (hours) =>
      `Ela espera sua decisão por mais ${hours} ${hours === 1 ? "hora" : "horas"}; depois expira, e nada muda.`,
    reasonLabel: "Nas palavras do próprio agente",
    field: "Configuração",
    now: "Agora",
    proposed: "Proposto",
    none: "(nada)",
    everyTool: "Todas as tools que receber: nenhuma lista o limita.",
    fields: {
      model: "Modelo",
      tools: "Tools",
      remit: "Função",
      spawn: "Subagentes",
      chat: "Chat",
      systemPrompt: "Alma",
      skills: "Skills",
    },
    stale:
      "O agente mudou desde esta proposta, então aprová-la não aplicaria nada. Recuse; o agente pode propor de novo se ainda precisar da mudança.",
    approve: "Aprovar",
    refuse: "Recusar",
    applying: "Esta proposta está sendo aplicada. Abra esta página de novo daqui a alguns minutos.",
    settled: {
      applied: {
        title: "Aprovada",
        body: (target) => `Esta proposta foi aprovada: a mudança em ${target} está aplicada.`,
      },
      refused: {
        title: "Recusada",
        body: () => "Esta proposta foi recusada. Nada mudou, e o Kelpie avisa o agente.",
      },
      expired: {
        title: "Expirada",
        body: () => "Esta proposta expirou antes de uma decisão. Nada mudou.",
      },
      conflict: {
        title: "Não aplicada",
        body: (target) =>
          `${target} mudou desde esta proposta, então nada foi aplicado. O Kelpie avisa o agente.`,
      },
      void: {
        title: "Não se aplica mais",
        body: () => "Um agente citado nesta proposta foi excluído. Nada mudou.",
      },
    },
    already: {
      title: "Já decidida",
      body: "Esta proposta já foi decidida. Abra a página dela de novo para ver como.",
    },
    taken: {
      title: "Aprovação recebida",
      body: "Sua aprovação foi recebida, mas um serviço do Kelpie não respondeu enquanto ela era aplicada. O Kelpie resolve isso em alguns minutos: abra a página da proposta de novo para ver como terminou.",
    },
    unknown: { title: "Essa proposta não existe", body: "Confira o link que o Kelpie enviou." },
    unavailable: {
      title: "Tente de novo daqui a pouco",
      body: "Um serviço do Kelpie não respondeu. Nada mudou.",
    },
    choose: {
      title: "Escolha uma resposta",
      body: "Toque em Aprovar ou Recusar na página da proposta.",
    },
    empty:
      "Nenhuma proposta espera por você. Quando um agente propõe uma mudança, o Kelpie envia a página dela na sua conversa com o Master.",
    listItem: (proposer, target, fields, hours) =>
      `${proposer} propõe uma mudança em ${target}: ${fields}. Expira em ${hours} ${hours === 1 ? "hora" : "horas"}.`,
  },
  es: {
    title: "Un cambio propuesto",
    listTitle: "Propuestas",
    intro: (proposer, target) =>
      `${proposer} propone un cambio en ${target}, un agente que le pertenece.`,
    fromTask: (task) => `Viene de la ejecución de su tarea ${task}.`,
    expires: (hours) =>
      `Espera tu decisión ${hours} ${hours === 1 ? "hora" : "horas"} más; luego vence, y nada cambia.`,
    reasonLabel: "En las palabras del propio agente",
    field: "Ajuste",
    now: "Ahora",
    proposed: "Propuesto",
    none: "(nada)",
    everyTool: "Todas las tools que reciba: ninguna lista lo limita.",
    fields: {
      model: "Modelo",
      tools: "Tools",
      remit: "Función",
      spawn: "Subagentes",
      chat: "Chat",
      systemPrompt: "Alma",
      skills: "Skills",
    },
    stale:
      "El agente cambió desde esta propuesta, así que aprobarla no aplicaría nada. Recházala; el agente puede proponerla de nuevo si aún necesita el cambio.",
    approve: "Aprobar",
    refuse: "Rechazar",
    applying: "Esta propuesta se está aplicando. Abre esta página de nuevo en unos minutos.",
    settled: {
      applied: {
        title: "Aprobada",
        body: (target) => `Esta propuesta fue aprobada: el cambio en ${target} está aplicado.`,
      },
      refused: {
        title: "Rechazada",
        body: () => "Esta propuesta fue rechazada. Nada cambió, y Kelpie avisa al agente.",
      },
      expired: {
        title: "Vencida",
        body: () => "Esta propuesta venció antes de una decisión. Nada cambió.",
      },
      conflict: {
        title: "No aplicada",
        body: (target) =>
          `${target} cambió desde esta propuesta, así que no se aplicó nada. Kelpie avisa al agente.`,
      },
      void: {
        title: "Ya no aplica",
        body: () => "Un agente que nombra esta propuesta fue eliminado. Nada cambió.",
      },
    },
    already: {
      title: "Ya decidida",
      body: "Esta propuesta ya se decidió. Abre su página de nuevo para ver cómo.",
    },
    taken: {
      title: "Aprobación recibida",
      body: "Tu aprobación se recibió, pero un servicio de Kelpie no respondió mientras se aplicaba. Kelpie lo resuelve en unos minutos: abre la página de la propuesta de nuevo para ver cómo terminó.",
    },
    unknown: { title: "Esa propuesta no existe", body: "Revisa el enlace que Kelpie te envió." },
    unavailable: {
      title: "Inténtalo de nuevo en un momento",
      body: "Un servicio de Kelpie no respondió. Nada cambió.",
    },
    choose: {
      title: "Elige una respuesta",
      body: "Presiona Aprobar o Rechazar en la página de la propuesta.",
    },
    empty:
      "Ninguna propuesta te espera. Cuando un agente propone un cambio, Kelpie te envía su página en tu conversación con el Master.",
    listItem: (proposer, target, fields, hours) =>
      `${proposer} propone un cambio en ${target}: ${fields}. Vence en ${hours} ${hours === 1 ? "hora" : "horas"}.`,
  },
};

/**
 * The design system's tokens these pages use (docs/design-system.md 1 and 3), in both themes and in
 * higher contrast, over the admin API's base page.
 */
const STYLE = `
  :root { --bg: #E7EEEC; --surface: #F7FAF9; --sunken: #DAE5E2; --fg: #0C2523; --muted: #4C6663; --line: #C2D2CE; --accent: #0A7469; --on-accent: #F0FAF8; --warm: #915708; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #091514; --surface: #0F1F1E; --sunken: #0B1918; --fg: #DBEAE6; --muted: #88A39E; --line: #21403B; --accent: #3BC3AE; --on-accent: #03201B; --warm: #EEAE4A; }
  }
  @media (prefers-contrast: more) { :root { --line: #6B8480; --muted: #344B48; } }
  @media (prefers-contrast: more) and (prefers-color-scheme: dark) { :root { --line: #557570; --muted: #A5BEB9; } }
  body { background: var(--bg); color: var(--fg); font-size: 15px; line-height: 1.55; }
  main { max-width: 44rem; background: var(--surface); border-color: var(--line); border-radius: 16px; padding: 24px; }
  .meta { color: var(--muted); font-size: 13.5px; margin: 0; }
  .card { display: grid; gap: 16px; }
  .label { color: var(--muted); font-size: 12.5px; margin: 0 0 4px; }
  blockquote { margin: 0; padding: 8px 12px; border-left: 3px solid var(--line); background: var(--sunken); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; overflow: hidden; contain: paint; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; vertical-align: top; padding: 8px; border-top: 1px solid var(--line); }
  thead th { color: var(--muted); font-weight: 500; border-top: 0; }
  pre { margin: 0; padding: 8px; background: var(--sunken); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; overflow: hidden; contain: paint; font: 12.5px/1.4 ui-monospace, monospace; }
  .stale { color: var(--warm); margin: 0; }
  .answers { display: flex; gap: 8px; flex-wrap: wrap; }
  .answers button { width: auto; flex: 1 1 10rem; border-radius: 10px; font-size: 13.5px; font-weight: 500; }
  .answers .approve { background: var(--accent); color: var(--on-accent); }
  .answers .refuse { background: transparent; color: var(--fg); border: 1px solid var(--muted); }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  a { color: var(--accent); }
  ul { padding-left: 20px; display: grid; gap: 8px; }
`;

const code = (text: string) => `<code>${escapeHtml(written(text))}</code>`;
const hoursLeft = (expiresAt: number, now: number) =>
  Math.max(Math.ceil((expiresAt - now) / 3_600_000), 1);

/**
 * Every invisible, control or reordering character written out as `\u{…}`, lines and tabs aside, so
 * nothing an agent wrote hides on the page.
 */
function written(text: string): string {
  return text.replace(/[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, (character) =>
    character === "\n" || character === "\t"
      ? character
      : `\\u{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}

/**
 * A setting's value: text as it is, anything else as JSON; escaped either way. A tools setting of
 * `null` says what it means, every tool, since it widens most.
 */
function shown(field: string, value: unknown, texts: Texts): string {
  if (field === "tools" && value === null) return `<pre>${escapeHtml(texts.everyTool)}</pre>`;
  if (value === undefined || value === "" || value === null) {
    return `<pre>${escapeHtml(value === null ? "null" : texts.none)}</pre>`;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `<pre>${escapeHtml(written(text))}</pre>`;
}

/** A proposal's page: pending ones with their answers, settled ones as their receipt. */
export function proposalPage(detail: ProposalDetail, locale: Locale, now: number): Response {
  const texts = TEXTS[locale];
  const rows = Object.entries(detail.changes)
    .map(
      ([field, value]) =>
        `<tr><th scope="row">${escapeHtml(texts.fields[field] ?? field)}</th><td>${detail.current === null ? shown(field, undefined, texts) : shown(field, (detail.current as Record<string, unknown>)[field], texts)}</td><td>${shown(field, value, texts)}</td></tr>`,
    )
    .join("\n");
  const parts = [
    `<p>${texts.intro(code(detail.proposer), code(detail.target))}</p>`,
    ...(detail.taskId === null
      ? []
      : [`<p class="meta">${texts.fromTask(code(detail.taskId))}</p>`]),
    `<div><p class="label">${escapeHtml(texts.reasonLabel)}</p><blockquote>${escapeHtml(written(detail.reason))}</blockquote></div>`,
    `<table><thead><tr><th scope="col">${texts.field}</th><th scope="col">${texts.now}</th><th scope="col">${texts.proposed}</th></tr></thead><tbody>\n${rows}\n</tbody></table>`,
  ];
  if (detail.status === "pending") {
    parts.push(`<p class="meta">${texts.expires(hoursLeft(detail.expiresAt, now))}</p>`);
    if (detail.stale) parts.push(`<p class="stale">${texts.stale}</p>`);
    // One form, which posts to its own URL, so the answer keeps the link's `?lang=`.
    parts.push(`<form method="post" class="answers">
${detail.stale ? "" : `  <button type="submit" name="decision" value="approve" class="approve">${texts.approve}</button>\n`}  <button type="submit" name="decision" value="refuse" class="refuse">${texts.refuse}</button>
</form>`);
  } else if (detail.status === "applying") {
    parts.push(`<p class="meta">${texts.applying}</p>`);
  } else {
    parts.push(`<p>${texts.settled[detail.status].body(code(detail.target))}</p>`);
  }
  return page(200, texts.title, `<div class="card">${parts.join("\n")}</div>`, locale, STYLE);
}

/** The pending proposals, each linking to its page in the same language. */
export function proposalListPage(proposals: Proposal[], locale: Locale, now: number): Response {
  const texts = TEXTS[locale];
  if (proposals.length === 0) {
    return page(200, texts.listTitle, `<p>${texts.empty}</p>`, locale, STYLE);
  }
  const items = proposals.map((proposal) => {
    const fields = Object.keys(proposal.changes)
      .map((field) => texts.fields[field] ?? field)
      .join(", ");
    const line = texts.listItem(
      code(proposal.proposer),
      code(proposal.target),
      escapeHtml(fields),
      hoursLeft(proposal.expiresAt, now),
    );
    return `<li><a href="/proposals/${proposal.id}?lang=${locale}">${line}</a></li>`;
  });
  return page(200, texts.listTitle, `<ul>\n${items.join("\n")}\n</ul>`, locale, STYLE);
}

/**
 * What the owner's decision came to (#302): 200 when it applied or refused it, 202 when the approval
 * was taken but its result didn't come back, 409 for a conflict, a void proposal or one already
 * decided, 410 for an expired one, 404 for an unknown one and 503 when a service didn't answer. A
 * repeat is never a 500.
 */
export function decidedPage(result: CommandResult<Proposal>, locale: Locale): Response {
  const texts = TEXTS[locale];
  const answer = (status: number, { title, body }: { title: string; body: string }) =>
    page(status, title, `<p>${body}</p>`, locale, STYLE);
  if (!result.ok) {
    if (result.reason === "not_pending") return answer(409, texts.already);
    if (result.reason === "unknown_proposal") return answer(404, texts.unknown);
    if (result.reason === "invalid_input") return answer(400, texts.choose);
    return answer(503, texts.unavailable);
  }
  const { status, target } = result.value;
  // Taken, but not finished: the Registry's alarm reads the target and settles it.
  if (status === "applying") return answer(202, texts.taken);
  if (status === "pending") return answer(503, texts.unavailable);
  const settled = texts.settled[status];
  const code409 = status === "conflict" || status === "void" ? 409 : 200;
  return answer(status === "expired" ? 410 : code409, {
    title: settled.title,
    body: settled.body(code(target)),
  });
}

export function noProposalPage(locale: Locale): Response {
  const { title, body } = TEXTS[locale].unknown;
  return page(404, title, `<p>${body}</p>`, locale, STYLE);
}

export function proposalsUnavailablePage(locale: Locale): Response {
  const { title, body } = TEXTS[locale].unavailable;
  return page(503, title, `<p>${body}</p>`, locale, STYLE);
}

export function chooseAnswerPage(locale: Locale): Response {
  const { title, body } = TEXTS[locale].choose;
  return page(400, title, `<p>${body}</p>`, locale, STYLE);
}
