// The session recall slice (#297): conversations in Portuguese whose answer sits where the
// session page before #326 didn't keep it, each with a question that needs that detail and two conversations
// on the same topic that don't hold it. ai-memory found its session pages, which kept little of
// what was said, cost most of its LongMemEval-S score (0.662 against 0.968 hit@5 with the captured
// text); this measures whether Kelpie's pages lose answers the same way.
import type { SessionInput, SessionLine } from "../src/index.ts";

/**
 * Where the answer sits:
 * - `reply-tail`: in one of Kelpie's replies, past its 280th character;
 * - `owner-tail`: in one of the owner's messages, past its 280th character;
 * - `middle`: in a short message in the middle of an 80-message session, which the page before #326 omitted;
 * - `head`: in a short message near the start, which every page keeps: the control.
 */
export const PLACES = ["reply-tail", "owner-tail", "middle", "head"] as const;
export type Place = (typeof PLACES)[number];

export interface RecallCase {
  id: string;
  place: Place;
  /** What the conversation is about, as its first message names it; its distractors share it. */
  topic: string;
  /** `YYYY-MM-DD` */
  day: string;
  /** Who says the answer. */
  speaker: "owner" | "kelpie";
  /** The sentence that answers the question. */
  fact: string;
  /** What the owner would ask later, in PT-BR. */
  question: string;
}

export const CASES: readonly RecallCase[] = [
  {
    id: "s01",
    place: "reply-tail",
    topic: "o aniversário da Ana",
    day: "2026-02-10",
    speaker: "kelpie",
    fact: "Para o jantar, a Taberna do Largo tem uma sala reservada para doze pessoas e aceita bolo de fora sem cobrar nada.",
    question: "Qual lugar tinha sala reservada para doze pessoas no aniversário da Ana?",
  },
  {
    id: "s02",
    place: "reply-tail",
    topic: "a viagem a Lisboa",
    day: "2026-03-04",
    speaker: "kelpie",
    fact: "O passe Navegante de 24 horas custa 7,20 euros e vale também no elétrico 28 e no comboio para Cascais.",
    question: "Quanto custa o passe de 24 horas que vale no elétrico em Lisboa?",
  },
  {
    id: "s03",
    place: "reply-tail",
    topic: "a reforma da cozinha",
    day: "2026-03-22",
    speaker: "kelpie",
    fact: "A bancada de quartzo branco do fornecedor Pedra Viva sai por 4.800 reais instalada, com entrega em três semanas.",
    question: "Quanto saía a bancada de quartzo instalada da reforma da cozinha?",
  },
  {
    id: "s04",
    place: "reply-tail",
    topic: "o curso de cerâmica",
    day: "2026-04-15",
    speaker: "kelpie",
    fact: "O ateliê Barro Cru tem turma às quintas, das 19h às 21h30, e o forno é a gás, por isso as peças levam dez dias para queimar.",
    question: "Em que dia é a turma do ateliê de cerâmica, e por que as peças levam dez dias?",
  },
  {
    id: "s05",
    place: "reply-tail",
    topic: "o orçamento do cliente Atlas",
    day: "2026-05-06",
    speaker: "kelpie",
    fact: "Somando licenças e horas, o valor fecha em 38.400 reais, com margem de 15% e pagamento em três parcelas.",
    question: "Em quanto fechou o valor do cliente Atlas com a margem e as parcelas?",
  },
  {
    id: "s06",
    place: "reply-tail",
    topic: "a mudança da Bia para Curitiba",
    day: "2026-06-18",
    speaker: "kelpie",
    fact: "A transportadora Leva Tudo cobra 3.900 reais com seguro, e o caminhão sai numa terça às sete da manhã.",
    question: "Quanto a transportadora cobrava com seguro na mudança da Bia?",
  },
  {
    id: "s07",
    place: "owner-tail",
    topic: "o carro",
    day: "2026-02-20",
    speaker: "owner",
    fact: "Anota aí: o seguro do carro vence em 14 de novembro, apólice 77-4410, na corretora do Joel.",
    question: "Quando vence o seguro do carro, e qual é a apólice?",
  },
  {
    id: "s08",
    place: "owner-tail",
    topic: "o apartamento novo",
    day: "2026-03-12",
    speaker: "owner",
    fact: "O código do portão da garagem é 4471 e a nossa vaga é a 23, no segundo subsolo.",
    question: "Qual é o código do portão da garagem do apartamento novo?",
  },
  {
    id: "s09",
    place: "owner-tail",
    topic: "a saúde do meu pai",
    day: "2026-04-02",
    speaker: "owner",
    fact: "O cardiologista dele é o Dr. Paulo Viana, e a próxima consulta é no dia 3, às 10h, no Hospital Santa Clara.",
    question: "Quem é o cardiologista do meu pai, e quando é a próxima consulta?",
  },
  {
    id: "s10",
    place: "owner-tail",
    topic: "as férias de dezembro",
    day: "2026-05-19",
    speaker: "owner",
    fact: "A pousada em Ilhabela confirmou de 20 a 27 de dezembro, quarto com varanda, e pediu um sinal de 30%.",
    question: "Que datas a pousada em Ilhabela confirmou nas férias?",
  },
  {
    id: "s11",
    place: "owner-tail",
    topic: "a escola do Theo",
    day: "2026-07-07",
    speaker: "owner",
    fact: "A professora nova do Theo se chama Marina, e a reunião de pais é na sexta, às 18h, na sala 12.",
    question: "Como se chama a professora nova do Theo, e quando é a reunião de pais?",
  },
  {
    id: "s12",
    place: "owner-tail",
    topic: "o imposto de renda",
    day: "2026-03-01",
    speaker: "owner",
    fact: "O contador pediu os informes de rendimentos do banco e o recibo do aluguel até o dia 20 de março.",
    question: "Que documentos o contador pediu para o imposto de renda?",
  },
  {
    id: "s13",
    place: "middle",
    topic: "o churrasco de sábado",
    day: "2026-02-27",
    speaker: "owner",
    fact: "Ah, o Caio é vegetariano: compra hambúrguer de grão-de-bico para ele.",
    question: "O que é para comprar para o Caio, que é vegetariano, no churrasco?",
  },
  {
    id: "s14",
    place: "middle",
    topic: "a obra do banheiro",
    day: "2026-04-09",
    speaker: "kelpie",
    fact: "O rejunte epóxi cinza-platina é o que a loja Casa Forte tinha em estoque.",
    question: "Qual rejunte a loja tinha em estoque para a obra do banheiro?",
  },
  {
    id: "s15",
    place: "middle",
    topic: "o casamento do Rafael",
    day: "2026-05-28",
    speaker: "owner",
    fact: "A lista de presentes está na Camicado, no nome de Rafael e Luiza.",
    question: "Em que loja está a lista de presentes do casamento do Rafael?",
  },
  {
    id: "s16",
    place: "middle",
    topic: "a viagem a Recife",
    day: "2026-06-30",
    speaker: "kelpie",
    fact: "O voo de volta é o G3 1742, que sai às 22h05 do aeroporto dos Guararapes.",
    question: "Qual é o voo de volta da viagem a Recife, e a que horas sai?",
  },
  {
    id: "s17",
    place: "middle",
    topic: "o cronograma do cliente Norte",
    day: "2026-07-21",
    speaker: "owner",
    fact: "A entrega da fase dois passou para 14 de agosto; avisa a Helena.",
    question: "Para quando passou a entrega da fase dois do cliente Norte?",
  },
  {
    id: "s18",
    place: "middle",
    topic: "a festa junina da escola",
    day: "2026-06-05",
    speaker: "kelpie",
    fact: "A barraca de vocês ficou com a pescaria, das 15h às 17h.",
    question: "Que barraca ficou com a gente na festa junina da escola?",
  },
  {
    id: "s19",
    place: "head",
    topic: "a academia",
    day: "2026-02-03",
    speaker: "owner",
    fact: "Mudei o plano da academia para o trimestral, de 390 reais, que vence no dia 5.",
    question: "Quanto custa o plano trimestral da academia?",
  },
  {
    id: "s20",
    place: "head",
    topic: "o dentista",
    day: "2026-03-17",
    speaker: "owner",
    fact: "A limpeza com a Dra. Sônia ficou para 12 de setembro, às 8h.",
    question: "Quando é a limpeza com a Dra. Sônia?",
  },
  {
    id: "s21",
    place: "head",
    topic: "o restaurante japonês",
    day: "2026-04-24",
    speaker: "kelpie",
    fact: "Reservei o Kinoshita para quinta às 20h30, mesa para quatro.",
    question: "Para quando ficou a reserva no Kinoshita?",
  },
  {
    id: "s22",
    place: "head",
    topic: "a manutenção do ar-condicionado",
    day: "2026-05-12",
    speaker: "owner",
    fact: "O técnico que limpou o ar-condicionado se chama Wesley e cobrou 280 reais pelas duas salas.",
    question: "Quanto o técnico Wesley cobrou pela limpeza do ar-condicionado?",
  },
  {
    id: "s23",
    place: "head",
    topic: "o presente da Luiza",
    day: "2026-08-04",
    speaker: "kelpie",
    fact: "O livro que a Luiza queria é Torto Arado, na edição de capa dura.",
    question: "Qual livro a Luiza queria de presente?",
  },
  {
    id: "s24",
    place: "head",
    topic: "a revisão do carro",
    day: "2026-08-25",
    speaker: "owner",
    fact: "A revisão dos 40 mil quilômetros ficou em 1.250 reais na concessionária.",
    question: "Quanto ficou a revisão dos 40 mil quilômetros do carro?",
  },
];

/** Short messages that carry the conversation along without saying anything a question asks. */
const OWNER_SHORT = [
  "Me lembra onde a gente parou?",
  "Faz sentido.",
  "Pode ser, vamos nessa.",
  "E o que mais falta?",
  "Beleza, vou pensar um pouco.",
  "Deixa eu ver com calma e te falo.",
  "Certo, pode seguir.",
  "Ok, anotado aqui também.",
];
const KELPIE_SHORT = [
  "Até agora está tudo encaminhado.",
  "Posso montar uma lista com o que falta.",
  "Combinado, eu te lembro mais perto da data.",
  "Faz sentido, vamos por partes.",
  "Anotado.",
  "Se quiser, eu procuro mais opções.",
  "Fico no aguardo, então.",
  "Claro, sem pressa.",
];
/** Sentences that make a message long, in Kelpie's voice and in the owner's. */
const KELPIE_LONG = [
  "Antes de decidir, vale comparar pelo menos três opções e olhar com calma o que está incluído em cada uma.",
  "Também é bom deixar uma folga, porque quase sempre aparece algum imprevisto no meio do caminho.",
  "Se fizer sentido, a gente pode dividir em etapas e resolver primeiro o que depende de outras pessoas.",
  "Outra coisa que ajuda é anotar tudo num lugar só, para não perder nenhum detalhe do que foi combinado.",
];
const OWNER_LONG = [
  "Pensei bastante nisso durante a semana e acho que dá para resolver sem muita correria, se a gente se organizar direito.",
  "Falei com o pessoal de casa e todo mundo concordou que é melhor fechar logo do que ficar adiando de novo.",
  "Só não quero esquecer nada importante, porque da última vez acabou ficando coisa para trás.",
];
const CLOSING = "Qualquer coisa, me avisa.";

/** The fact's character offset in its message must be past this, for the tail places. */
const EXCERPT_CHARS = 280;
const SHORT_LINES = 12;
const LONG_LINES = 80;

/** The fact at a place, inside the message that holds it. */
function factMessage(fact: string, place: Place, speaker: "owner" | "kelpie"): string {
  if (place !== "reply-tail" && place !== "owner-tail") return fact;
  const lead = (speaker === "kelpie" ? KELPIE_LONG : OWNER_LONG).join(" ");
  const text = `${lead} ${fact} ${CLOSING}`;
  if (text.indexOf(fact) <= EXCERPT_CHARS) throw new Error(`the fact starts too early: ${fact}`);
  return text;
}

/**
 * A conversation's messages, the owner first, alternating; `fact` replaces one of them, at the
 * place its case names.
 */
function linesOf(
  topic: string,
  day: string,
  count: number,
  fact?: { text: string; at: number },
): SessionLine[] {
  const start = Date.parse(`${day}T20:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const speaker = i % 2 === 0 ? "owner" : "kelpie";
    let text: string;
    if (fact !== undefined && i === fact.at) text = fact.text;
    else if (i === 0) text = `Bom dia! Queria retomar ${topic}.`;
    else if (i === 1) text = `Claro! Sobre ${topic}, ficou de você confirmar os próximos passos.`;
    else {
      const pool = speaker === "owner" ? OWNER_SHORT : KELPIE_SHORT;
      text = pool[(i >> 1) % pool.length] ?? "";
    }
    const role = speaker === "owner" ? "user" : "assistant";
    return {
      role,
      speaker: speaker === "owner" ? "u-owner" : "kelpie",
      text,
      at: start + i * 60_000,
    } satisfies SessionLine;
  });
}

/** Where each place puts the fact: a message of the speaker's own, so the turns still alternate. */
function factIndex(place: Place, speaker: "owner" | "kelpie"): number {
  const own = speaker === "owner" ? 0 : 1;
  if (place === "middle") return LONG_LINES / 2 + own;
  return 2 + own;
}

const input = (key: string, lines: SessionLine[]): SessionInput => ({
  key,
  channel: "telegram",
  threadId: "chat-1",
  timeZone: null,
  lines,
});

/** A case's conversation, with the fact at its place. */
export function conversationOf(c: RecallCase): SessionInput {
  const count = c.place === "middle" ? LONG_LINES : SHORT_LINES;
  const at = factIndex(c.place, c.speaker);
  return input(
    c.id,
    linesOf(c.topic, c.day, count, { text: factMessage(c.fact, c.place, c.speaker), at }),
  );
}

/** Two conversations on a case's topic, a week before and after, without its fact. */
export function distractorsOf(c: RecallCase): SessionInput[] {
  const count = c.place === "middle" ? LONG_LINES : SHORT_LINES;
  return [-7, 7].map((days, n) => {
    const day = new Date(Date.parse(`${c.day}T00:00:00Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return input(`${c.id}-d${n + 1}`, linesOf(c.topic, day, count));
  });
}
