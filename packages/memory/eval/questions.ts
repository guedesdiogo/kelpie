// The labelled questions, frozen before any retrieval run: `test/eval-labels.test.ts` fails when
// this file changes without its hash being updated, and the result records the hash it ran with.

export const CATEGORIES = [
  "entity",
  "preference",
  "commitment",
  "update",
  "as-of",
  "multi-hop",
  "procedure",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Question {
  id: string;
  /** What the owner would type, in PT-BR. */
  text: string;
  category: Category;
  /**
   * Memories that answer it: `key` is the current version, `key@n` the n-th. Any one answers,
   * except in multi-hop questions, which need them all.
   */
  gold: string[];
  /** Memories that would give an outdated answer. */
  stale?: string[];
  /** Ingestion time to search at, `YYYY-MM-DD` (end of day, UTC): resolved by arithmetic. */
  asOf?: string;
  /** World time the answer must be valid at, `YYYY-MM-DD` (noon, UTC). */
  validAt?: string;
}

const q = (
  id: number,
  category: Category,
  text: string,
  gold: string[],
  extra: Omit<Question, "id" | "text" | "category" | "gold"> = {},
): Question => ({ id: `q${String(id).padStart(3, "0")}`, text, category, gold, ...extra });

export const QUESTIONS: Question[] = [
  // Entities: who someone is, where something is
  q(1, "entity", "Quando é o aniversário da minha irmã?", ["ana"]),
  q(2, "entity", "O que a Ana faz da vida?", ["ana"]),
  q(3, "entity", "Que remédio minha mãe toma pra pressão?", ["helena", "mae-remedio"]),
  q(4, "entity", "Em que bairro de BH minha mãe mora?", ["helena"]),
  q(5, "entity", "Quando é o aniversário da minha mãe?", ["helena"]),
  q(6, "entity", "Como se chama o filho do Bruno?", ["bruno", "theo"]),
  q(7, "entity", "Pra que time o Bruno torce?", ["bruno"]),
  q(8, "entity", "Qual a especialidade da Patrícia?", ["patricia"]),
  q(9, "entity", "A Patrícia tem alguma alergia?", ["patricia"]),
  q(10, "entity", "Onde a Fernanda Couto mora?", ["fernanda"]),
  q(11, "entity", "Quem projetou a reforma do escritório?", ["fernanda"]),
  q(12, "entity", "Qual o endereço do meu dentista?", ["paulo"]),
  q(13, "entity", "Em que dias o Dr. Paulo atende?", ["paulo"]),
  q(14, "entity", "Onde a Júlia trabalha?", ["julia"]),
  q(15, "entity", "A Júlia tem alguma restrição alimentar?", ["julia"]),
  q(16, "entity", "Quando é o aniversário da Júlia?", ["julia"]),
  q(17, "entity", "Onde fica o sítio do tio Marcos?", ["sitio", "marcos"]),
  q(18, "entity", "Quem fica com a chave reserva do meu apartamento?", ["lucia", "viagem-casa"]),
  q(19, "entity", "Como se chama o gato da vizinha?", ["lucia"]),
  q(20, "entity", "Quando é o aniversário do Theo?", ["theo"]),
  q(21, "entity", "Do que o Theo gosta? Quero comprar um presente pra ele.", ["theo"]),
  q(22, "entity", "Quem é o nosso contador?", ["renato"]),
  q(23, "entity", "Em que formato o Renato prefere receber documentos?", ["renato"]),
  q(24, "entity", "Qual o endereço do escritório?", ["escritorio"]),
  q(25, "entity", "Qual a rede Wi-Fi da sala de reunião do escritório?", ["escritorio"]),
  q(26, "entity", "Até que horas a padaria Estrela fica aberta?", ["padaria"]),
  q(27, "entity", "Tem sinal de celular no sítio em Itaipava?", ["sitio"]),
  q(28, "entity", "De que tipo de reunião a Carla gosta?", ["carla"]),
  q(29, "entity", "Qual o valor mensal do contrato com a Construtora Horizonte?", [
    "contrato-horizonte",
  ]),
  q(30, "entity", "Quantas obras a gente gerencia pra Horizonte?", ["contrato-horizonte"]),
  q(31, "entity", "Em que hospital minha mãe operou a catarata?", ["cirurgia-helena"]),
  q(32, "entity", "Onde foi o pedido de casamento?", ["noivado", "julia"]),
  q(33, "entity", "Em que pousada foi o jantar do noivado?", ["noivado"]),
  q(34, "entity", "Quem é a irmã da Patrícia?", ["patricia", "fernanda"]),
  q(35, "entity", "O tio Marcos trabalhava com quê?", ["marcos"]),

  // Preferences
  q(36, "preference", "Como eu gosto do meu café?", ["cafe"]),
  q(37, "preference", "Posso tomar um café normal às 17h?", ["cafe"]),
  q(38, "preference", "Quantas xícaras de café eu tomo por dia, no máximo?", ["cafe"]),
  q(39, "preference", "Qual é o meu prato favorito?", ["alimentacao"]),
  q(40, "preference", "Eu como fritura durante a semana?", ["alimentacao"]),
  q(41, "preference", "Que horário eu prefiro pra reuniões?", ["reunioes"]),
  q(42, "preference", "Posso marcar uma reunião na sexta às 15h?", ["reunioes"]),
  q(43, "preference", "Como você deve formatar as respostas pra mim?", ["tom"]),
  q(44, "preference", "Posso usar emojis nas respostas?", ["tom"]),
  q(45, "preference", "Prefiro corredor ou janela no avião?", ["viagens-pref"]),
  q(46, "preference", "Qual é o meu programa de milhas?", ["viagens-pref"]),
  q(47, "preference", "Eu despacho mala em viagem curta?", ["viagens-pref"]),
  q(48, "preference", "Que música eu ouço pra trabalhar?", ["musica"]),
  q(49, "preference", "Eu gosto de sertanejo?", ["musica"]),
  q(50, "preference", "Quais são os meus artistas favoritos?", ["musica"]),
  q(51, "preference", "Em que dias da semana eu corro?", ["exercicio"]),
  q(52, "preference", "Quantos quilômetros eu costumo correr?", ["exercicio"]),
  q(53, "preference", "A que horas eu saio pra correr?", ["exercicio"]),
  q(54, "preference", "Onde eu tomo café da manhã aos sábados?", ["padaria"]),
  q(55, "preference", "Onde tem o melhor pão de queijo do bairro?", ["padaria"]),
  q(56, "preference", "O que a Ana gosta de fazer no tempo livre?", ["ana"]),
  q(57, "preference", "A Carla prefere reunião longa ou por escrito?", ["carla"]),
  q(58, "preference", "Que livros estão na minha lista de leitura?", ["livros"]),
  q(59, "preference", "Quem me emprestou Torto Arado?", ["livros"]),
  q(60, "preference", "O que a Patrícia não pode comer?", ["patricia"]),

  // Commitments and deadlines
  q(61, "commitment", "Quando é minha consulta no dentista?", ["dentista"]),
  q(62, "commitment", "O que preciso levar na consulta do dentista?", ["dentista"]),
  q(63, "commitment", "Até quando preciso agendar a renovação do passaporte?", ["passaporte"]),
  q(64, "commitment", "Quando vence o meu passaporte?", ["passaporte"]),
  q(65, "commitment", "Onde eu renovo o passaporte?", ["passaporte"]),
  q(66, "commitment", "Quando é o casamento?", ["casamento"]),
  q(67, "commitment", "Onde vai ser o casamento?", ["casamento"]),
  q(68, "commitment", "O que o bufê do casamento precisa ter?", ["casamento"]),
  q(69, "commitment", "Até quando tenho que fechar a lista de convidados?", ["casamento"]),
  q(70, "commitment", "Quando tenho que comprar o remédio da minha mãe?", ["mae-remedio"]),
  q(71, "commitment", "Como eu mando o remédio pra minha mãe?", ["mae-remedio"]),
  q(72, "commitment", "Em que dia vence a parcela do apartamento?", ["apartamento"]),
  q(73, "commitment", "Que compromissos eu tenho de pé em novembro?", ["dentista", "passaporte"], {
    validAt: "2026-11-05",
  }),
  q(74, "commitment", "O que eu tinha que mandar pro Renato em abril?", ["ir"], {
    validAt: "2026-04-01",
  }),
  q(75, "commitment", "Que prazos ainda estão valendo em dezembro?", ["passaporte", "casamento"], {
    validAt: "2026-12-01",
  }),
  q(76, "commitment", "Tenho alguma consulta marcada?", ["dentista"], { validAt: "2026-10-01" }),
  q(77, "commitment", "Com quem é a revisão dos dentes e quando?", ["dentista"]),
  q(78, "commitment", "Quais são as datas das férias de dezembro?", ["ferias"]),
  q(79, "procedure", "Quanto custa a contabilidade por mês?", ["contabilidade"]),
  q(80, "commitment", "Que remédio eu compro pra minha mãe todo mês?", ["mae-remedio", "helena"]),

  // Facts that changed: the current answer, with the outdated ones as traps
  q(81, "update", "Onde a Ana mora?", ["ana"], {
    stale: ["sessao-ana-aniversario", "cirurgia-helena"],
  }),
  q(82, "update", "Em que cidade fica o estúdio da Ana?", ["ana"]),
  q(83, "update", "Em que bairro eu moro?", ["apartamento"], { stale: ["sessao-sindico"] }),
  q(84, "update", "Qual o meu endereço?", ["apartamento"], { stale: ["sessao-sindico"] }),
  q(85, "update", "Eu ainda pago aluguel?", ["apartamento"]),
  q(86, "update", "Qual banco financiou meu apartamento?", ["apartamento"]),
  q(87, "update", "Qual é o nome da rede Wi-Fi de casa?", ["wifi-casa"]),
  q(88, "update", "Onde fica o roteador de casa?", ["wifi-casa"]),
  q(89, "update", "Onde a Carla trabalha hoje?", ["carla"], {
    stale: ["sessao-carla-alinhamento"],
  }),
  q(90, "update", "Qual é o cargo da Carla agora?", ["carla"], {
    stale: ["sessao-carla-alinhamento"],
  }),
  q(91, "update", "Quando vence o relatório mensal da Horizonte?", ["relatorio"]),
  q(92, "update", "Quem pediu pra mudar o prazo do relatório da Horizonte?", ["relatorio"]),
  q(93, "update", "Eu como carne vermelha?", ["alimentacao"], { stale: ["sessao-churrasco"] }),
  q(94, "update", "Desde quando eu parei de comer carne vermelha?", ["alimentacao"]),
  q(95, "update", "Em que parque eu corro agora?", ["exercicio"], { stale: ["sessao-corrida"] }),
  q(96, "update", "A Júlia e eu já somos noivos?", ["julia", "noivado"]),
  q(97, "update", "Pra onde vão ser as férias de dezembro?", ["ferias"], {
    stale: ["sessao-planejamento-ferias"],
  }),
  q(98, "update", "Vou ficar em Lisboa nas férias de dezembro?", ["ferias"], {
    stale: ["sessao-planejamento-ferias"],
  }),
  q(99, "update", "Eu tenho carro?", ["carro"]),
  q(100, "update", "Como eu me desloco pela cidade?", ["carro"]),
  q(101, "update", "Quem é a diretora de operações da Construtora Horizonte?", ["carla"]),
  q(102, "update", "A Ana ainda trabalha na agência de Lisboa?", ["ana"], {
    stale: ["sessao-ana-aniversario"],
  }),
  q(103, "update", "O que mudou no prazo do relatório da Horizonte?", ["relatorio"]),
  q(104, "update", "Quem é a vizinha que tem o gato Biscoito?", ["lucia"]),
  q(105, "update", "Em que cidade a Ana abriu o estúdio dela?", ["ana"], {
    stale: ["sessao-ana-aniversario"],
  }),

  // As of an earlier date: what memory held then
  q(106, "as-of", "Onde a Ana morava em maio?", ["ana@1"], { asOf: "2026-05-01" }),
  q(107, "as-of", "Em abril, qual era o prazo do relatório da Horizonte?", ["relatorio@1"], {
    asOf: "2026-04-15",
  }),
  q(108, "as-of", "Onde eu morava em março?", ["apartamento@1"], { asOf: "2026-03-15" }),
  q(109, "as-of", "Quem era o síndico do prédio onde eu morava em março?", ["apartamento@1"], {
    asOf: "2026-03-15",
  }),
  q(110, "as-of", "Em junho, em que dia vencia o meu aluguel?", ["apartamento@1"], {
    asOf: "2026-06-15",
  }),
  q(111, "as-of", "Em fevereiro, quem era a gerente de projetos da Lima & Souza?", ["carla@1"], {
    asOf: "2026-02-20",
  }),
  q(112, "as-of", "Onde eu corria no começo do ano?", ["exercicio@1"], { asOf: "2026-03-01" }),
  q(113, "as-of", "Em março, eu comia carne vermelha?", ["alimentacao@1"], { asOf: "2026-03-01" }),
  q(
    114,
    "as-of",
    "Segundo o plano de junho, pra onde iam ser as férias de dezembro?",
    ["ferias@1"],
    {
      asOf: "2026-06-20",
    },
  ),
  q(115, "as-of", "Qual era a rede Wi-Fi de casa em julho?", ["wifi-casa@1"], {
    asOf: "2026-07-01",
  }),
  q(116, "as-of", "Em agosto, a Júlia era minha namorada ou noiva?", ["julia@1"], {
    asOf: "2026-08-15",
  }),
  q(117, "as-of", "Quem coordenava o projeto da Horizonte em janeiro?", ["carla@1"], {
    asOf: "2026-01-31",
  }),
  q(118, "as-of", "Em fevereiro, em que cidade a Ana trabalhava?", ["ana@1"], {
    asOf: "2026-02-15",
  }),
  q(119, "as-of", "No começo de julho, a Ana já tinha se mudado pro Porto?", ["ana@1"], {
    asOf: "2026-07-05",
  }),
  q(120, "as-of", "Em julho, em que parque eu corria?", ["exercicio@1"], { asOf: "2026-07-15" }),

  // Multi-hop: the answer needs more than one memory
  q(121, "multi-hop", "Em que cidade mora a irmã da esposa do Bruno?", ["patricia", "fernanda"]),
  q(122, "multi-hop", "Qual a especialidade da mãe do meu afilhado?", ["theo", "patricia"]),
  q(123, "multi-hop", "A cunhada do Bruno é arquiteta ou médica?", ["patricia", "fernanda"]),
  q(
    124,
    "multi-hop",
    "Quem eu aviso antes de viajar, além da portaria, e como se chama o gato dela?",
    ["viagem-casa", "lucia"],
  ),
  q(125, "multi-hop", "Meu passaporte ainda vale na viagem de dezembro?", ["passaporte", "ferias"]),
  q(126, "multi-hop", "Nas férias, em que cidade minha irmã vai estar e o que ela faz lá?", [
    "ferias",
    "ana",
  ]),
  q(127, "multi-hop", "O casamento vai ser num lugar com sinal de celular?", [
    "casamento",
    "sitio",
  ]),
  q(128, "multi-hop", "Quando é minha consulta e em que rua fica o consultório?", [
    "dentista",
    "paulo",
  ]),
  q(129, "multi-hop", "O contador que escolhemos cobra quanto e como prefere receber documentos?", [
    "contabilidade",
    "renato",
  ]),
  q(130, "multi-hop", "Quem acompanhou minha mãe na cirurgia, e onde essa pessoa mora agora?", [
    "cirurgia-helena",
    "ana",
  ]),
  q(131, "multi-hop", "O bufê do casamento tem que atender à restrição de quem, e qual é?", [
    "casamento",
    "julia",
  ]),
  q(132, "multi-hop", "Quando é o aniversário do filho do meu sócio?", ["bruno", "theo"]),
  q(133, "multi-hop", "Em que hospital trabalha a esposa do meu sócio?", ["bruno", "patricia"]),
  q(
    134,
    "multi-hop",
    "A ex-gerente da consultoria foi pra qual cliente, e quanto ele nos paga por mês?",
    ["carla", "contrato-horizonte"],
  ),
  q(135, "multi-hop", "Que remédio minha mãe toma e quando eu compro?", ["helena", "mae-remedio"]),
  q(136, "multi-hop", "O casamento vai ser no mesmo lugar do Réveillon da família?", [
    "casamento",
    "marcos",
  ]),
  q(137, "multi-hop", "Quem me emprestou o livro, e qual é a profissão dela?", ["livros", "julia"]),
  q(
    138,
    "multi-hop",
    "Qual o código de serviço da nota fiscal e quem cuida do nosso imposto de renda?",
    ["nota-fiscal", "renato"],
  ),
  q(139, "multi-hop", "Minha noiva pode comer o meu prato favorito?", ["julia", "alimentacao"]),
  q(140, "multi-hop", "Quem eu vou visitar no Porto, e o que essa pessoa faz?", ["ferias", "ana"]),

  // Procedures and decisions
  q(141, "procedure", "Como eu emito nota fiscal?", ["nota-fiscal"]),
  q(142, "procedure", "Qual é a alíquota de ISS da nossa nota fiscal?", ["nota-fiscal"]),
  q(143, "procedure", "O que eu tenho que fazer antes de viajar?", ["viagem-casa"]),
  q(144, "procedure", "Por que escolhemos a Alves Contabilidade?", ["contabilidade"]),
  q(145, "procedure", "Em que banco fica a conta da empresa?", ["banco"]),
  q(146, "procedure", "Por que a conta PJ está no Inter?", ["banco"]),
  q(147, "procedure", "Por que eu vendi o carro?", ["carro"]),
  q(148, "procedure", "Que outro escritório de contabilidade a gente considerou?", [
    "contabilidade",
  ]),
  q(149, "procedure", "Preciso desligar o aquecedor antes de viajar?", ["viagem-casa"]),
  q(150, "procedure", "Como faço pra me locomover nas viagens, já que não tenho carro?", ["carro"]),
];
