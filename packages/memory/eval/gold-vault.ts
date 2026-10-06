// The labelled core of the synthetic vault: a fictional owner, Rafael, and the people, places,
// preferences, commitments and decisions of his year. No real person or data. Every question in
// questions.ts is answered by memories here; the generator surrounds them with distractors.
import type { Kind, Scope } from "../src/index.ts";

/** One version of a gold memory. Later versions supersede earlier ones at the same path. */
export interface GoldVersion {
  /** When it was written: the commit date, `YYYY-MM-DD`. */
  at: string;
  body: string;
  entities?: string[];
  validFrom?: string;
  invalidAt?: string;
  abstract?: string;
}

export interface GoldMemory {
  /** The label questions use: `ana` is the current version, `ana@1` the first. */
  key: string;
  scope?: Scope;
  kind: Kind;
  title: string;
  /** For dated kinds (sessions, events): the date in the file name. */
  date?: string;
  versions: [GoldVersion, ...GoldVersion[]];
}

export const GOLD_MEMORIES: GoldMemory[] = [
  // People
  {
    key: "ana",
    kind: "person",
    title: "Ana Souza",
    versions: [
      {
        at: "2026-01-12",
        body: "Irmã mais nova do Rafael. Designer gráfica, mora em Lisboa desde 2023 e trabalha numa agência de branding. Aniversário em 14 de março. Gosta de cerâmica e de trilhas.",
        entities: ["Ana Souza", "Lisboa"],
      },
      {
        at: "2026-07-20",
        body: "Irmã mais nova do Rafael. Designer gráfica; em julho de 2026 mudou-se de Lisboa para o Porto, onde abriu um estúdio próprio de branding. Aniversário em 14 de março. Gosta de cerâmica e de trilhas.",
        entities: ["Ana Souza", "Porto"],
      },
    ],
  },
  {
    key: "helena",
    kind: "person",
    title: "Helena Souza",
    versions: [
      {
        at: "2026-01-12",
        body: "Mãe do Rafael. Professora de matemática aposentada, mora em Belo Horizonte, no bairro Santa Tereza. Tem pressão alta e toma losartana. Aniversário em 2 de agosto. Liga todo domingo à noite.",
        entities: ["Helena Souza", "Belo Horizonte"],
      },
    ],
  },
  {
    key: "bruno",
    kind: "person",
    title: "Bruno Lima",
    versions: [
      {
        at: "2026-01-15",
        body: "Sócio do Rafael na consultoria Lima & Souza. Cuida da parte comercial. Casado com a Patrícia, tem um filho, o Theo, de 6 anos. Torce pelo Atlético Mineiro.",
        entities: ["Bruno Lima", "Lima & Souza", "Patrícia Lima", "Theo Lima"],
      },
    ],
  },
  {
    key: "patricia",
    kind: "person",
    title: "Patrícia Lima",
    versions: [
      {
        at: "2026-02-03",
        body: "Esposa do Bruno Lima. Médica pediatra no Hospital das Clínicas. Irmã da Fernanda Couto. Alérgica a camarão.",
        entities: ["Patrícia Lima", "Bruno Lima", "Fernanda Couto"],
      },
    ],
  },
  {
    key: "fernanda",
    kind: "person",
    title: "Fernanda Couto",
    versions: [
      {
        at: "2026-02-03",
        body: "Irmã da Patrícia Lima. Arquiteta, mora em Curitiba. Projetou a reforma do escritório da Lima & Souza.",
        entities: ["Fernanda Couto", "Curitiba", "Patrícia Lima"],
      },
    ],
  },
  {
    key: "carla",
    kind: "person",
    title: "Carla Mendes",
    versions: [
      {
        at: "2026-01-20",
        body: "Gerente de projetos da Lima & Souza. Coordena o projeto da Construtora Horizonte. Prefere reuniões curtas e por escrito.",
        entities: ["Carla Mendes", "Construtora Horizonte"],
      },
      {
        at: "2026-06-02",
        body: "Foi gerente de projetos da Lima & Souza até maio de 2026; agora é diretora de operações da Construtora Horizonte, cliente da consultoria. Prefere reuniões curtas e por escrito.",
        entities: ["Carla Mendes", "Construtora Horizonte"],
      },
    ],
  },
  {
    key: "paulo",
    kind: "person",
    title: "Dr. Paulo Teixeira",
    versions: [
      {
        at: "2026-02-10",
        body: "Dentista do Rafael, consultório na Rua Pamplona, 1200, em São Paulo. Atende às terças e quintas. Telefone do consultório no cartão da carteira.",
        entities: ["Paulo Teixeira", "Rua Pamplona"],
      },
    ],
  },
  {
    key: "julia",
    kind: "person",
    title: "Júlia Prado",
    versions: [
      {
        at: "2026-03-01",
        body: "Namorada do Rafael desde 2024. Veterinária, trabalha numa clínica em Pinheiros. É vegetariana e não come nada com glúten. Aniversário em 30 de setembro.",
        entities: ["Júlia Prado", "Pinheiros"],
      },
      {
        at: "2026-09-12",
        body: "Noiva do Rafael: ficaram noivos em 6 de setembro de 2026, em Paraty. Veterinária, trabalha numa clínica em Pinheiros. É vegetariana e não come nada com glúten. Aniversário em 30 de setembro.",
        entities: ["Júlia Prado", "Pinheiros", "Paraty"],
      },
    ],
  },
  {
    key: "marcos",
    kind: "person",
    title: "Tio Marcos",
    versions: [
      {
        at: "2026-04-18",
        body: "Irmão da Helena, tio do Rafael. Tem um sítio em Itaipava onde a família passa o Réveillon. Mecânico aposentado, entende de carros antigos.",
        entities: ["Marcos Souza", "Itaipava", "Helena Souza"],
      },
    ],
  },
  {
    key: "lucia",
    kind: "person",
    title: "Lúcia Ferraz",
    versions: [
      {
        at: "2026-09-01",
        body: "Vizinha do apartamento 52, no prédio de Pinheiros. Fica com a chave reserva do Rafael e rega as plantas quando ele viaja. Tem um gato chamado Biscoito.",
        entities: ["Lúcia Ferraz", "Biscoito"],
      },
    ],
  },
  {
    key: "theo",
    kind: "person",
    title: "Theo Lima",
    versions: [
      {
        at: "2026-03-15",
        body: "Filho do Bruno e da Patrícia, afilhado do Rafael. Faz aniversário em 22 de abril. Adora dinossauros e Lego.",
        entities: ["Theo Lima", "Bruno Lima"],
      },
    ],
  },
  {
    key: "renato",
    kind: "person",
    title: "Renato Alves",
    versions: [
      {
        at: "2026-03-20",
        body: "Contador da Lima & Souza, do escritório Alves Contabilidade. Cuida do imposto de renda do Rafael também. Prefere receber documentos por e-mail em PDF.",
        entities: ["Renato Alves", "Alves Contabilidade", "Lima & Souza"],
      },
    ],
  },

  // Places
  {
    key: "apartamento",
    kind: "place",
    title: "Apartamento",
    versions: [
      {
        at: "2026-01-08",
        body: "Rafael mora num apartamento alugado na Vila Mariana, São Paulo, Rua Domingos de Morais. O aluguel vence no dia 10. O síndico é o seu Arnaldo.",
        entities: ["Vila Mariana", "São Paulo"],
      },
      {
        at: "2026-08-25",
        body: "Desde agosto de 2026, Rafael mora num apartamento próprio em Pinheiros, Rua dos Pinheiros, comprado com financiamento da Caixa. A parcela vence no dia 15. Não paga mais aluguel.",
        entities: ["Pinheiros", "São Paulo", "Caixa"],
      },
    ],
  },
  {
    key: "escritorio",
    kind: "place",
    title: "Escritório da Lima & Souza",
    versions: [
      {
        at: "2026-01-15",
        body: "O escritório da consultoria fica na Avenida Paulista, 1500, conjunto 82. Estacionamento conveniado no prédio ao lado. Wi-Fi da sala de reunião: rede LS-Visitantes.",
        entities: ["Lima & Souza", "Avenida Paulista"],
      },
    ],
  },
  {
    key: "padaria",
    kind: "place",
    title: "Padaria Estrela",
    versions: [
      {
        at: "2026-02-14",
        body: "Padaria na esquina de casa, onde Rafael toma café da manhã aos sábados. O pão de queijo é o melhor do bairro; fecha às 20h.",
        entities: ["Padaria Estrela"],
      },
    ],
  },
  {
    key: "sitio",
    kind: "place",
    title: "Sítio do Tio Marcos",
    versions: [
      {
        at: "2026-04-18",
        body: "Sítio em Itaipava, na serra de Petrópolis. Tem piscina e uma oficina com carros antigos. Sem sinal de celular perto da casa; o Wi-Fi só funciona na varanda.",
        entities: ["Itaipava", "Marcos Souza", "Petrópolis"],
      },
    ],
  },

  // Preferences
  {
    key: "cafe",
    kind: "preference",
    title: "Café",
    versions: [
      {
        at: "2026-01-09",
        body: "Rafael toma café coado, sem açúcar, e no máximo três xícaras por dia; depois das 16h só descafeinado.",
        entities: ["café"],
      },
    ],
  },
  {
    key: "alimentacao",
    kind: "preference",
    title: "Alimentação",
    versions: [
      {
        at: "2026-01-09",
        body: "Rafael come de tudo, mas evita fritura durante a semana. Prato favorito: moqueca capixaba.",
      },
      {
        at: "2026-05-11",
        body: "Desde maio de 2026, Rafael não come carne vermelha; come peixe e frango. Evita fritura durante a semana. Prato favorito: moqueca capixaba.",
      },
    ],
  },
  {
    key: "reunioes",
    kind: "preference",
    title: "Reuniões",
    versions: [
      {
        at: "2026-01-22",
        body: "Rafael prefere reuniões pela manhã, nunca antes das 9h, e não aceita reuniões na sexta à tarde, que reserva para trabalho focado.",
      },
    ],
  },
  {
    key: "tom",
    scope: "agent/kelpie",
    kind: "preference",
    title: "Tom das respostas",
    versions: [
      {
        at: "2026-01-05",
        body: "Rafael quer respostas curtas, em português, sem emojis, com a conclusão primeiro. Para listas longas, prefere receber um resumo e o detalhe só se pedir.",
      },
    ],
  },
  {
    key: "viagens-pref",
    kind: "preference",
    title: "Viagens",
    versions: [
      {
        at: "2026-02-20",
        body: "Em viagens, Rafael prefere voos diretos e assento no corredor; não despacha bagagem em viagens de até cinco dias. Programa de milhas: Smiles.",
        entities: ["Smiles"],
      },
    ],
  },
  {
    key: "musica",
    kind: "preference",
    title: "Música",
    versions: [
      {
        at: "2026-03-08",
        body: "Rafael ouve MPB e jazz para trabalhar; Milton Nascimento e Chet Baker são os favoritos. Não gosta de sertanejo.",
        entities: ["Milton Nascimento", "Chet Baker"],
      },
    ],
  },
  {
    key: "exercicio",
    kind: "preference",
    title: "Exercícios",
    versions: [
      {
        at: "2026-01-30",
        body: "Rafael corre no Parque Ibirapuera às terças e quintas, às 6h30, cerca de 8 km.",
        entities: ["Parque Ibirapuera"],
      },
      {
        at: "2026-08-28",
        body: "Depois da mudança para Pinheiros, Rafael passou a correr no Parque Villa-Lobos às terças e quintas, às 6h30, cerca de 8 km.",
        entities: ["Parque Villa-Lobos"],
      },
    ],
  },

  // Commitments
  {
    key: "dentista",
    kind: "commitment",
    title: "Consulta no dentista",
    versions: [
      {
        at: "2026-09-02",
        body: "Consulta de revisão com o Dr. Paulo Teixeira em 12 de novembro de 2026, às 14h. Levar o raio-X panorâmico.",
        entities: ["Paulo Teixeira"],
        validFrom: "2026-09-02",
        invalidAt: "2026-11-13",
      },
    ],
  },
  {
    key: "passaporte",
    kind: "commitment",
    title: "Renovar o passaporte",
    versions: [
      {
        at: "2026-06-15",
        body: "O passaporte do Rafael vence em 3 de fevereiro de 2027. Agendar a renovação na Polícia Federal até dezembro de 2026, antes da viagem a Lisboa.",
        entities: ["passaporte", "Polícia Federal"],
        validFrom: "2026-06-15",
        invalidAt: "2027-02-03",
      },
    ],
  },
  {
    key: "relatorio",
    scope: "area/work",
    kind: "commitment",
    title: "Relatório mensal da Construtora Horizonte",
    versions: [
      {
        at: "2026-02-01",
        body: "Entregar à Construtora Horizonte o relatório mensal de acompanhamento até o dia 30 de cada mês.",
        entities: ["Construtora Horizonte"],
      },
      {
        at: "2026-06-05",
        body: "A partir de junho de 2026, o relatório mensal da Construtora Horizonte vence no dia 5 de cada mês, a pedido da Carla Mendes, que agora está do lado do cliente.",
        entities: ["Construtora Horizonte", "Carla Mendes"],
      },
    ],
  },
  {
    key: "ir",
    kind: "commitment",
    title: "Imposto de renda",
    versions: [
      {
        at: "2026-03-20",
        body: "Mandar ao Renato Alves os informes de rendimento e os recibos médicos até 15 de abril para a declaração do imposto de renda.",
        entities: ["Renato Alves", "imposto de renda"],
        validFrom: "2026-03-20",
        invalidAt: "2026-04-16",
      },
    ],
  },
  {
    key: "casamento",
    kind: "commitment",
    title: "Casamento",
    versions: [
      {
        at: "2026-09-12",
        body: "Rafael e Júlia vão se casar em 15 de maio de 2027, no sítio do Tio Marcos em Itaipava. Lista de convidados até janeiro; o bufê precisa ter opções vegetarianas e sem glúten.",
        entities: ["Júlia Prado", "Itaipava"],
        validFrom: "2026-09-12",
      },
    ],
  },
  {
    key: "mae-remedio",
    kind: "commitment",
    title: "Remédio da mãe",
    versions: [
      {
        at: "2026-04-02",
        body: "Comprar losartana para a Helena todo começo de mês e mandar pelos Correios para Belo Horizonte.",
        entities: ["Helena Souza", "losartana"],
      },
    ],
  },

  // Decisions
  {
    key: "contabilidade",
    scope: "area/work",
    kind: "decision",
    title: "Escritório de contabilidade",
    versions: [
      {
        at: "2026-03-18",
        body: "Rafael e Bruno decidiram contratar a Alves Contabilidade em vez da Contabiliza, por causa do atendimento por e-mail e do preço fixo de R$ 900 por mês.",
        entities: ["Alves Contabilidade", "Contabiliza"],
      },
    ],
  },
  {
    key: "carro",
    kind: "decision",
    title: "Carro",
    versions: [
      {
        at: "2026-04-25",
        body: "Rafael decidiu vender o Gol 2014 e não comprar outro carro; vai usar metrô e aplicativo, e alugar carro nas viagens.",
        entities: ["Gol"],
      },
    ],
  },
  {
    key: "ferias",
    kind: "decision",
    title: "Férias de dezembro",
    versions: [
      {
        at: "2026-06-10",
        body: "As férias de dezembro serão em Lisboa, de 10 a 24 de dezembro de 2026, para visitar a Ana.",
        entities: ["Lisboa", "Ana Souza"],
      },
      {
        at: "2026-07-25",
        body: "Com a mudança da Ana, as férias de dezembro passaram a ser no Porto, de 10 a 24 de dezembro de 2026, com dois dias em Lisboa no fim.",
        entities: ["Porto", "Lisboa", "Ana Souza"],
      },
    ],
  },
  {
    key: "banco",
    scope: "area/work",
    kind: "decision",
    title: "Banco da empresa",
    versions: [
      {
        at: "2026-02-25",
        body: "A conta PJ da Lima & Souza fica no Banco Inter, pela tarifa zero e pela API de boletos.",
        entities: ["Banco Inter", "Lima & Souza"],
      },
    ],
  },

  // Procedures
  {
    key: "nota-fiscal",
    scope: "area/work",
    kind: "procedure",
    title: "Emitir nota fiscal",
    versions: [
      {
        at: "2026-02-28",
        body: "Para emitir nota fiscal de serviço: entrar no portal da Prefeitura de São Paulo com o certificado A1 da Lima & Souza, código de serviço 01.07, alíquota de ISS de 2%, e mandar o PDF ao Renato Alves.",
        entities: ["nota fiscal", "Renato Alves"],
      },
    ],
  },
  {
    key: "viagem-casa",
    kind: "procedure",
    title: "Antes de viajar",
    versions: [
      {
        at: "2026-09-01",
        body: "Antes de viajar: deixar a chave reserva com a Lúcia Ferraz, desligar o aquecedor, avisar a portaria e programar a rega automática das plantas da varanda.",
        entities: ["Lúcia Ferraz"],
      },
    ],
  },

  // Events
  {
    key: "noivado",
    kind: "event",
    title: "Noivado em Paraty",
    date: "2026-09-06",
    versions: [
      {
        at: "2026-09-07",
        body: "Rafael pediu a Júlia em casamento em 6 de setembro de 2026, num jantar na pousada Casa Azul, em Paraty. O anel foi feito pela joalheria da Rua Oscar Freire.",
        entities: ["Júlia Prado", "Paraty", "Casa Azul"],
      },
    ],
  },
  {
    key: "cirurgia-helena",
    kind: "event",
    title: "Cirurgia de catarata da Helena",
    date: "2026-05-19",
    versions: [
      {
        at: "2026-05-20",
        body: "A Helena operou a catarata do olho direito em 19 de maio de 2026, no Hospital São Geraldo, em Belo Horizonte. A Ana veio de Lisboa para acompanhar. Recuperação sem problemas.",
        entities: ["Helena Souza", "Hospital São Geraldo", "Ana Souza"],
      },
    ],
  },
  {
    key: "contrato-horizonte",
    scope: "area/work",
    kind: "event",
    title: "Contrato com a Construtora Horizonte",
    date: "2026-01-28",
    versions: [
      {
        at: "2026-01-28",
        body: "A Lima & Souza assinou em 28 de janeiro de 2026 um contrato de 12 meses com a Construtora Horizonte, de R$ 18 mil por mês, para a gestão de três obras.",
        entities: ["Construtora Horizonte", "Lima & Souza"],
      },
    ],
  },

  // Notes
  {
    key: "wifi-casa",
    kind: "note",
    title: "Wi-Fi de casa",
    versions: [
      {
        at: "2026-01-08",
        body: "Rede de casa: VilaMariana-5G. O roteador fica atrás da televisão; reiniciar resolve quase tudo.",
      },
      {
        at: "2026-08-26",
        body: "Rede do apartamento novo: Pinheiros-Casa. O roteador da Vivo fica no armário do corredor.",
      },
    ],
  },
  {
    key: "livros",
    kind: "note",
    title: "Livros para ler",
    versions: [
      {
        at: "2026-03-12",
        body: 'Lista de leitura: "Torto Arado", de Itamar Vieira Junior; "O Avesso da Pele", de Jeferson Tenório; "Sapiens". A Júlia emprestou "Torto Arado".',
        entities: ["Torto Arado", "Júlia Prado"],
      },
    ],
  },
  // Sessions: what was said in a conversation, true then, outdated by later facts
  {
    key: "sessao-ana-aniversario",
    kind: "session",
    title: "Ligação de aniversário da Ana",
    date: "2026-03-14",
    versions: [
      {
        at: "2026-03-14",
        body: "Rafael ligou para a Ana, em Lisboa, no aniversário dela. Ela contou que a agência de branding está crescendo e que pretende continuar em Lisboa por mais uns anos.",
        entities: ["Ana Souza", "Lisboa"],
      },
    ],
  },
  {
    key: "sessao-sindico",
    kind: "session",
    title: "Vazamento no apartamento",
    date: "2026-03-03",
    versions: [
      {
        at: "2026-03-03",
        body: "Conversa sobre o vazamento no banheiro do apartamento da Vila Mariana. O síndico, seu Arnaldo, vai chamar o encanador na quinta; Rafael deixa a chave na portaria.",
        entities: ["Vila Mariana", "Arnaldo"],
      },
    ],
  },
  {
    key: "sessao-carla-alinhamento",
    scope: "area/work",
    kind: "session",
    title: "Alinhamento com a Carla",
    date: "2026-04-10",
    versions: [
      {
        at: "2026-04-10",
        body: "Reunião com a Carla Mendes, gerente de projetos da Lima & Souza, sobre o cronograma das obras da Construtora Horizonte. Ela vai mandar o resumo por escrito.",
        entities: ["Carla Mendes", "Construtora Horizonte"],
      },
    ],
  },
  {
    key: "sessao-corrida",
    kind: "session",
    title: "Dor no joelho depois da corrida",
    date: "2026-04-07",
    versions: [
      {
        at: "2026-04-07",
        body: "Rafael correu 10 km no Parque Ibirapuera e sentiu o joelho esquerdo. Combinou de voltar aos 8 km e procurar um fisioterapeuta se a dor continuar.",
        entities: ["Parque Ibirapuera"],
      },
    ],
  },
  {
    key: "sessao-planejamento-ferias",
    kind: "session",
    title: "Planejamento das férias",
    date: "2026-06-10",
    versions: [
      {
        at: "2026-06-10",
        body: "Planejamento das férias de dezembro: passagens para Lisboa, de 10 a 24 de dezembro, ficando na casa da Ana. Comprar com milhas da Smiles.",
        entities: ["Lisboa", "Ana Souza", "Smiles"],
      },
    ],
  },
  {
    key: "sessao-churrasco",
    kind: "session",
    title: "Churrasco na casa do Bruno",
    date: "2026-04-26",
    versions: [
      {
        at: "2026-04-26",
        body: "Churrasco de domingo na casa do Bruno e da Patrícia. Rafael elogiou a picanha e ficou de levar a sobremesa na próxima vez.",
        entities: ["Bruno Lima", "Patrícia Lima"],
      },
    ],
  },
];
