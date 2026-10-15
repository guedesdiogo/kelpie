// The handoff evaluation's roster and prompts (#287). A bakery owner's main agent owns four
// specialists with remits, and one with none. Each prompt expects the specialist it belongs to, or
// none: the near misses touch a remit's topic without being its work.

export interface RosterEntry {
  id: string;
  name: string;
  remit: string;
}

export const ROSTER: RosterEntry[] = [
  {
    id: "sales",
    name: "Sales",
    remit: "Wholesale quotes, price lists and follow-ups with the bakery's business clients.",
  },
  {
    id: "books",
    name: "Books",
    remit: "Bookkeeping: invoices, receipts, expenses and the monthly cash report.",
  },
  {
    id: "travel",
    name: "Travel",
    remit: "Trip planning: flights, hotels and itineraries for the owner's trips.",
  },
  {
    id: "social",
    name: "Social",
    remit: "The bakery's Instagram: post ideas, captions and the weekly content calendar.",
  },
  // No remit: it takes work only when the owner names it.
  { id: "helper", name: "Helper", remit: "" },
];

export interface HandoffCase {
  id: string;
  prompt: string;
  /** The specialist that should get the task, or null when none should. */
  expected: string | null;
}

const to = (expected: string, prompts: string[]): HandoffCase[] =>
  prompts.map((prompt, index) => ({ id: `${expected}-${index + 1}`, prompt, expected }));

export const CASES: HandoffCase[] = [
  ...to("sales", [
    "A Padaria do Bairro quer um orçamento de 200 pães de queijo por semana. Pode preparar?",
    "Manda uma proposta de preços para o Café Central, eles querem croissants para revender.",
    "O Mercado Silva não respondeu nossa última proposta. Faz um follow-up com eles.",
    "Atualiza a tabela de preços de atacado com o aumento de 8% na farinha.",
    "A hotel chain wants a wholesale price list for breakfast breads. Prepare one.",
    "Un restaurante quiere comprar 50 baguettes al día. Prepara una cotización.",
    "Passa para a Sales: o Café Central quer 10% de desconto, prepara a contraproposta.",
  ]),
  ...to("books", [
    "Lança essas despesas do mês: farinha R$ 1.200, gás R$ 380, embalagens R$ 210.",
    "Emite a nota da venda de ontem para o Café Central, R$ 640.",
    "Fecha o relatório de caixa de setembro para mim.",
    "Guarda esse recibo da manutenção do forno: R$ 950, pago hoje.",
    "Reconcile last week's receipts against the bank statement and tell me what's missing.",
    "Registra el gasto de la nueva batidora, 2.300 reales.",
  ]),
  ...to("travel", [
    "Preciso ir a São Paulo dia 12 para uma feira. Vê voo e hotel perto do Anhembi.",
    "Monta um roteiro de 3 dias em Lisboa para mim em novembro.",
    "Acha um hotel barato em Curitiba para a noite de 20 de outubro.",
    "Quero visitar fornecedores em Minas na semana que vem: organiza a viagem.",
    "Find me a flight to Buenos Aires for the bakery fair next month.",
    "Planea un viaje de fin de semana a Montevideo para dos personas.",
  ]),
  ...to("social", [
    "Pensa em 5 ideias de post para o lançamento do nosso pão de fermentação natural.",
    "Escreve a legenda do post de hoje sobre o bolo de fubá.",
    "Monta o calendário de conteúdo do Instagram da próxima semana.",
    "Precisamos de um post avisando que vamos fechar no feriado.",
    "Write three captions for our new cinnamon roll photos.",
    "Propón ideas de reels para mostrar cómo hacemos el pan.",
  ]),
  ...to("helper", [
    "Pede para o Helper organizar em uma lista os fornecedores de farinha da região.",
    "Ask Helper to draft a list of questions for the oven technician.",
  ]),
  // Nothing to hand off: small talk, general knowledge, and near misses of each remit.
  ...[
    "Bom dia! Tudo bem?",
    "Obrigado, era só isso.",
    "Qual a diferença entre fermento biológico e fermento químico?",
    "Quanto é 18% de 2.450?",
    "Me explica rapidinho o que é um CNPJ.",
    "Que horas são em Lisboa quando aqui são 9h da manhã?",
    "Escreve uma mensagem curta de aniversário para a minha mãe.",
    "What's a good synonym for 'delicious'?",
    "Traduz 'pão de queijo' para o inglês.",
    "Me dá uma receita simples de bolo de cenoura.",
    "¿Cómo se dice 'padaria' en español?",
    "Quantos dias faltam até o Natal?",
    "Em uma frase: o que é o Instagram?",
    "Qual o melhor jeito de guardar pão francês para o dia seguinte?",
    "Liste três pães típicos de Portugal.",
    "Is it better to proof dough in the fridge overnight?",
  ].map((prompt, index) => ({ id: `none-${index + 1}`, prompt, expected: null })),
];
