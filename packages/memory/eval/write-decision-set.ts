// The labeled PT-BR set for the write decision (#149, ADR-0009): a new memory, an existing note,
// and how the memory relates to the note, as `decideWrite` asks the qualifier. Built on the
// evaluation's gold vault (gold-vault.ts) and frozen like its labels: `test/eval-labels.test.ts`
// fails when this file changes without WRITE_SET_SHA256 being updated.
//
// - duplicate: the note already says everything the memory says;
// - refines: the memory adds detail, and the note stays true;
// - replaces: the memory says the note is no longer true, or changes what it says;
// - unrelated: the memory is about something else, though it may share a name.

export type WriteRelation = "duplicate" | "refines" | "replaces" | "unrelated";

export interface WritePair {
  id: string;
  memory: { title: string; body: string };
  note: { title: string; body: string };
  label: WriteRelation;
}

const p = (
  n: number,
  label: WriteRelation,
  memory: [string, string],
  note: [string, string],
): WritePair => ({
  id: `w${String(n).padStart(3, "0")}`,
  memory: { title: memory[0], body: memory[1] },
  note: { title: note[0], body: note[1] },
  label,
});

const ANA_LISBOA =
  "Irmã mais nova do Rafael. Designer gráfica, mora em Lisboa desde 2023 e trabalha numa agência de branding. Aniversário em 14 de março. Gosta de cerâmica.";
const ANA_PORTO =
  "Irmã mais nova do Rafael. Designer gráfica; em julho de 2026 mudou-se de Lisboa para o Porto, onde abriu um estúdio próprio de branding. Aniversário em 14 de março.";
const HELENA =
  "Mãe do Rafael. Professora de matemática aposentada, mora em Belo Horizonte, no bairro Santa Tereza. Tem pressão alta e toma losartana. Aniversário em 2 de agosto.";
const BRUNO =
  "Sócio do Rafael na consultoria Lima & Souza. Cuida da parte comercial. Casado com a Patrícia, tem um filho, o Theo, de 6 anos. Torce pelo Atlético Mineiro.";
const PATRICIA =
  "Esposa do Bruno Lima. Médica pediatra no Hospital das Clínicas. Irmã da Fernanda Couto. Alérgica a camarão.";
const FERNANDA =
  "Irmã da Patrícia Lima. Arquiteta, mora em Curitiba. Projetou a reforma do escritório da Lima & Souza.";
const CARLA_ANTES =
  "Gerente de projetos da Lima & Souza. Coordena o projeto da Construtora Horizonte. Prefere reuniões curtas e por escrito.";
const PAULO =
  "Dentista do Rafael, consultório na Rua Pamplona, 1200, em São Paulo. Atende às terças e quintas.";
const JULIA_ANTES =
  "Namorada do Rafael desde 2024. Veterinária, trabalha numa clínica em Pinheiros. É vegetariana e não come nada com glúten. Aniversário em 30 de setembro.";
const JULIA_NOIVA =
  "Noiva do Rafael: ficaram noivos em 6 de setembro de 2026, em Paraty. Veterinária, trabalha numa clínica em Pinheiros. É vegetariana e não come nada com glúten.";
const MARCOS =
  "Irmão da Helena, tio do Rafael. Tem um sítio em Itaipava onde a família passa o Réveillon. Mecânico aposentado, entende de carros antigos.";
const LUCIA =
  "Vizinha do apartamento 52, no prédio de Pinheiros. Fica com a chave reserva do Rafael e rega as plantas quando ele viaja. Tem um gato chamado Biscoito.";
const THEO =
  "Filho do Bruno e da Patrícia, afilhado do Rafael. Faz aniversário em 22 de abril. Adora dinossauros e Lego.";
const RENATO =
  "Contador da Lima & Souza, do escritório Alves Contabilidade. Cuida do imposto de renda do Rafael também. Prefere receber documentos por e-mail em PDF.";
const APTO_ANTES =
  "Rafael mora num apartamento alugado na Vila Mariana, São Paulo, Rua Domingos de Morais. O aluguel vence no dia 10.";
const ESCRITORIO =
  "O escritório da consultoria fica na Avenida Paulista, 1500, conjunto 82. Estacionamento conveniado no prédio ao lado.";
const PADARIA =
  "Padaria na esquina de casa, onde Rafael toma café da manhã aos sábados. O pão de queijo é o melhor do bairro; fecha às 20h.";
const SITIO =
  "Sítio em Itaipava, na serra de Petrópolis. Tem piscina e uma oficina com carros antigos. Sem sinal de celular perto da casa; o Wi-Fi só funciona na varanda.";
const CAFE =
  "Rafael toma café coado, sem açúcar, e no máximo três xícaras por dia; depois das 16h só descafeinado.";
const ALIMENTACAO_ANTES =
  "Rafael come de tudo, mas evita fritura durante a semana. Prato favorito: moqueca capixaba.";
const REUNIOES =
  "Rafael prefere reuniões pela manhã, nunca antes das 9h, e não aceita reuniões na sexta à tarde, que reserva para trabalho focado.";
const TOM =
  "Rafael quer respostas curtas, em português, sem emojis, com a conclusão primeiro. Para listas longas, prefere receber um resumo e o detalhe só se pedir.";
const VIAGENS =
  "Em viagens, Rafael prefere voos diretos e assento no corredor; não despacha bagagem em viagens de até cinco dias. Programa de milhas: Smiles.";
const MUSICA =
  "Rafael ouve MPB e jazz para trabalhar; Milton Nascimento e Chet Baker são os favoritos. Não gosta de sertanejo.";
const EXERCICIO_ANTES =
  "Rafael corre no Parque Ibirapuera às terças e quintas, às 6h30, cerca de 8 km.";
const DENTISTA =
  "Consulta de revisão com o Dr. Paulo Teixeira em 12 de novembro de 2026, às 14h. Levar o raio-X panorâmico.";
const PASSAPORTE =
  "O passaporte do Rafael vence em 3 de fevereiro de 2027. Agendar a renovação na Polícia Federal até dezembro de 2026, antes da viagem a Lisboa.";
const RELATORIO_ANTES =
  "Entregar à Construtora Horizonte o relatório mensal de acompanhamento até o dia 30 de cada mês.";
const IR =
  "Mandar ao Renato Alves os informes de rendimento e os recibos médicos até 15 de abril para a declaração do imposto de renda.";
const CASAMENTO =
  "Rafael e Júlia vão se casar em 15 de maio de 2027, no sítio do Tio Marcos em Itaipava. Lista de convidados até janeiro; o bufê precisa ter opções vegetarianas e sem glúten.";
const REMEDIO =
  "Comprar losartana para a Helena todo começo de mês e mandar pelos Correios para Belo Horizonte.";
const CONTABILIDADE =
  "Rafael e Bruno decidiram contratar a Alves Contabilidade em vez da Contabiliza, por causa do atendimento por e-mail e do preço fixo de R$ 900 por mês.";
const CARRO =
  "Rafael decidiu vender o Gol 2014 e não comprar outro carro; vai usar metrô e aplicativo, e alugar carro nas viagens.";
const FERIAS_ANTES =
  "As férias de dezembro serão em Lisboa, de 10 a 24 de dezembro de 2026, para visitar a Ana.";
const BANCO =
  "A conta PJ da Lima & Souza fica no Banco Inter, pela tarifa zero e pela API de boletos.";
const VIAGEM_CASA =
  "Antes de viajar: deixar a chave reserva com a Lúcia Ferraz, desligar o aquecedor, avisar a portaria e programar a rega automática das plantas da varanda.";
const WIFI_ANTES =
  "Rede de casa: VilaMariana-5G. O roteador fica atrás da televisão; reiniciar resolve quase tudo.";

export const WRITE_PAIRS: readonly WritePair[] = [
  // The memory changes what the note says.
  p(1, "replaces", ["Ana Souza", ANA_PORTO], ["Ana Souza", ANA_LISBOA]),
  p(
    2,
    "replaces",
    ["Ana mudou para o Porto", "A Ana mudou-se de Lisboa para o Porto em julho de 2026."],
    ["Ana Souza", ANA_LISBOA],
  ),
  p(
    3,
    "replaces",
    [
      "Carla Mendes",
      "A Carla saiu da Lima & Souza em maio de 2026 e agora é diretora de operações da Construtora Horizonte.",
    ],
    ["Carla Mendes", CARLA_ANTES],
  ),
  p(4, "replaces", ["Júlia Prado", JULIA_NOIVA], ["Júlia Prado", JULIA_ANTES]),
  p(
    5,
    "replaces",
    [
      "Apartamento",
      "Desde agosto de 2026, Rafael mora num apartamento próprio em Pinheiros, comprado com financiamento da Caixa.",
    ],
    ["Apartamento", APTO_ANTES],
  ),
  p(
    6,
    "replaces",
    ["Alimentação", "Desde maio de 2026, Rafael não come carne vermelha; come peixe e frango."],
    ["Alimentação", ALIMENTACAO_ANTES],
  ),
  p(
    7,
    "replaces",
    ["Exercícios", "Rafael agora corre no Parque Villa-Lobos às terças e quintas, às 6h30."],
    ["Exercícios", EXERCICIO_ANTES],
  ),
  p(
    8,
    "replaces",
    [
      "Relatório mensal",
      "O relatório mensal da Construtora Horizonte agora vence no dia 5 de cada mês.",
    ],
    ["Relatório mensal da Construtora Horizonte", RELATORIO_ANTES],
  ),
  p(
    9,
    "replaces",
    [
      "Férias de dezembro",
      "As férias de dezembro passaram a ser no Porto, de 10 a 24 de dezembro.",
    ],
    ["Férias de dezembro", FERIAS_ANTES],
  ),
  p(
    10,
    "replaces",
    [
      "Wi-Fi de casa",
      "A rede do apartamento novo é Pinheiros-Casa; o roteador fica no armário do corredor.",
    ],
    ["Wi-Fi de casa", WIFI_ANTES],
  ),
  p(
    11,
    "replaces",
    ["Café", "Rafael passou a tomar café com uma colher de açúcar."],
    ["Café", CAFE],
  ),
  p(
    12,
    "replaces",
    ["Reuniões", "Rafael agora aceita reuniões na sexta à tarde, desde que terminem até as 16h."],
    ["Reuniões", REUNIOES],
  ),
  p(
    13,
    "replaces",
    ["Helena Souza", "A Helena mudou-se de Belo Horizonte para São Paulo, para perto do Rafael."],
    ["Helena Souza", HELENA],
  ),
  p(
    14,
    "replaces",
    ["Passaporte", "O passaporte do Rafael foi renovado em outubro de 2026 e vale até 2036."],
    ["Renovar o passaporte", PASSAPORTE],
  ),
  p(
    15,
    "replaces",
    ["Banco da empresa", "A conta PJ da Lima & Souza mudou do Banco Inter para o Itaú."],
    ["Banco da empresa", BANCO],
  ),
  p(
    16,
    "replaces",
    ["Carro", "Rafael desistiu de ficar sem carro e comprou um Onix 2025."],
    ["Carro", CARRO],
  ),
  p(
    17,
    "replaces",
    [
      "Lúcia Ferraz",
      "A Lúcia mudou-se do prédio em setembro; agora quem fica com a chave reserva é o porteiro.",
    ],
    ["Lúcia Ferraz", LUCIA],
  ),
  p(
    18,
    "replaces",
    [
      "Consulta no dentista",
      "A consulta com o Dr. Paulo foi remarcada para 19 de novembro de 2026, às 10h.",
    ],
    ["Consulta no dentista", DENTISTA],
  ),
  p(
    19,
    "replaces",
    [
      "Escritório de contabilidade",
      "A Lima & Souza trocou a Alves Contabilidade pela Contabiliza em 2026.",
    ],
    ["Escritório de contabilidade", CONTABILIDADE],
  ),
  p(
    20,
    "replaces",
    [
      "Tom das respostas",
      "Rafael agora prefere respostas detalhadas, com o raciocínio antes da conclusão.",
    ],
    ["Tom das respostas", TOM],
  ),

  // The memory adds detail, and the note stays true.
  p(
    21,
    "refines",
    ["Estúdio da Ana", "O estúdio de branding que a Ana abriu no Porto se chama Atelier Norte."],
    ["Ana Souza", ANA_PORTO],
  ),
  p(
    22,
    "refines",
    ["Patrícia Lima", "A Patrícia atende no Hospital das Clínicas às segundas e quartas."],
    ["Patrícia Lima", PATRICIA],
  ),
  p(
    23,
    "refines",
    [
      "Fernanda Couto",
      "A Fernanda tem dois filhos e um escritório próprio de arquitetura em Curitiba.",
    ],
    ["Fernanda Couto", FERNANDA],
  ),
  p(
    24,
    "refines",
    ["Padaria Estrela", "A Padaria Estrela também abre aos domingos, até as 13h."],
    ["Padaria Estrela", PADARIA],
  ),
  p(
    25,
    "refines",
    ["Música", "Rafael também gosta de Caetano Veloso, principalmente os discos dos anos 70."],
    ["Música", MUSICA],
  ),
  p(
    26,
    "refines",
    ["Escritório", "A vaga do Rafael no estacionamento conveniado é a 14."],
    ["Escritório da Lima & Souza", ESCRITORIO],
  ),
  p(
    27,
    "refines",
    ["Tio Marcos", "O Tio Marcos tem um Fusca 1965 restaurado na oficina do sítio."],
    ["Tio Marcos", MARCOS],
  ),
  p(
    28,
    "refines",
    ["Casamento", "A cerimônia do casamento será às 16h, com recepção no mesmo lugar."],
    ["Casamento", CASAMENTO],
  ),
  p(
    29,
    "refines",
    ["Remédio da mãe", "A losartana da Helena é de 50 mg, uma caixa de 30 comprimidos por mês."],
    ["Remédio da mãe", REMEDIO],
  ),
  p(
    30,
    "refines",
    ["Antes de viajar", "Antes de viajar, também tirar o lixo e esvaziar a geladeira."],
    ["Antes de viajar", VIAGEM_CASA],
  ),
  p(
    31,
    "refines",
    [
      "Imposto de renda",
      "Para o imposto de renda, mandar também o informe da previdência privada.",
    ],
    ["Imposto de renda", IR],
  ),
  p(
    32,
    "refines",
    ["Júlia Prado", "A Júlia tem um cachorro, um vira-lata chamado Tofu."],
    ["Júlia Prado", JULIA_NOIVA],
  ),
  p(
    33,
    "refines",
    ["Theo Lima", "O Theo começou a fazer natação aos sábados."],
    ["Theo Lima", THEO],
  ),
  p(
    34,
    "refines",
    ["Bruno Lima", "O Bruno também cuida dos contratos com os fornecedores da consultoria."],
    ["Bruno Lima", BRUNO],
  ),
  p(
    35,
    "refines",
    ["Sítio do Tio Marcos", "Para chegar ao sítio, pegar a Estrada União e Indústria até o km 12."],
    ["Sítio do Tio Marcos", SITIO],
  ),
  p(
    36,
    "refines",
    [
      "Viagens",
      "Em voos de mais de oito horas, Rafael prefere a classe executiva quando a empresa paga.",
    ],
    ["Viagens", VIAGENS],
  ),
  p(
    37,
    "refines",
    ["Dr. Paulo Teixeira", "O consultório do Dr. Paulo fica no 8º andar, sala 84."],
    ["Dr. Paulo Teixeira", PAULO],
  ),
  p(
    38,
    "refines",
    ["Renato Alves", "O Renato atende pelo e-mail do escritório e responde em até dois dias."],
    ["Renato Alves", RENATO],
  ),
  p(
    39,
    "refines",
    ["Helena Souza", "A Helena faz caminhada no Parque Municipal todas as manhãs."],
    ["Helena Souza", HELENA],
  ),
  p(
    40,
    "refines",
    ["Banco da empresa", "O gerente da conta PJ no Banco Inter é o Marcelo."],
    ["Banco da empresa", BANCO],
  ),

  // The note already says it.
  p(
    41,
    "duplicate",
    [
      "Café",
      "Rafael bebe café coado sem açúcar, até três por dia; depois das 16h, só descafeinado.",
    ],
    ["Café", CAFE],
  ),
  p(
    42,
    "duplicate",
    [
      "Helena",
      "A mãe do Rafael, Helena, é professora de matemática aposentada e mora em Belo Horizonte.",
    ],
    ["Helena Souza", HELENA],
  ),
  p(
    43,
    "duplicate",
    ["Afilhado", "O Theo, afilhado do Rafael, faz aniversário em 22 de abril."],
    ["Theo Lima", THEO],
  ),
  p(
    44,
    "duplicate",
    ["Padaria", "A Padaria Estrela, na esquina de casa, fecha às 20h."],
    ["Padaria Estrela", PADARIA],
  ),
  p(
    45,
    "duplicate",
    ["Reuniões", "Rafael não marca reuniões antes das 9h nem na sexta à tarde."],
    ["Reuniões", REUNIOES],
  ),
  p(
    46,
    "duplicate",
    ["Música", "Para trabalhar, Rafael ouve MPB e jazz, sobretudo Milton Nascimento e Chet Baker."],
    ["Música", MUSICA],
  ),
  p(
    47,
    "duplicate",
    ["Bruno", "O Bruno é sócio do Rafael e cuida da parte comercial da Lima & Souza."],
    ["Bruno Lima", BRUNO],
  ),
  p(
    48,
    "duplicate",
    ["Patrícia", "A Patrícia, esposa do Bruno, é pediatra e alérgica a camarão."],
    ["Patrícia Lima", PATRICIA],
  ),
  p(
    49,
    "duplicate",
    [
      "Passaporte",
      "Agendar na Polícia Federal a renovação do passaporte, que vence em 3 de fevereiro de 2027.",
    ],
    ["Renovar o passaporte", PASSAPORTE],
  ),
  p(
    50,
    "duplicate",
    [
      "Remédio",
      "Todo começo de mês, comprar a losartana da Helena e mandar pelos Correios para BH.",
    ],
    ["Remédio da mãe", REMEDIO],
  ),
  p(
    51,
    "duplicate",
    ["Carro", "Rafael não vai ter carro: usa metrô e aplicativo, e aluga um quando viaja."],
    ["Carro", CARRO],
  ),
  p(
    52,
    "duplicate",
    ["Banco", "A Lima & Souza usa o Banco Inter na conta PJ, pela tarifa zero."],
    ["Banco da empresa", BANCO],
  ),
  p(
    53,
    "duplicate",
    ["Viagens", "Rafael prefere voo direto e corredor, e não despacha mala em viagens curtas."],
    ["Viagens", VIAGENS],
  ),
  p(
    54,
    "duplicate",
    ["Tom", "Respostas curtas, em português, sem emojis, com a conclusão primeiro."],
    ["Tom das respostas", TOM],
  ),
  p(
    55,
    "duplicate",
    [
      "Antes de viajar",
      "Deixar a chave com a Lúcia, desligar o aquecedor e avisar a portaria antes de viajar.",
    ],
    ["Antes de viajar", VIAGEM_CASA],
  ),
  p(
    56,
    "duplicate",
    ["Escritório", "A Lima & Souza fica na Avenida Paulista, 1500, conjunto 82."],
    ["Escritório da Lima & Souza", ESCRITORIO],
  ),
  p(
    57,
    "duplicate",
    ["Fernanda", "A Fernanda Couto, irmã da Patrícia, é arquiteta em Curitiba."],
    ["Fernanda Couto", FERNANDA],
  ),
  p(
    58,
    "duplicate",
    ["Dentista", "A revisão no dentista é em 12 de novembro, às 14h, com o raio-X panorâmico."],
    ["Consulta no dentista", DENTISTA],
  ),
  p(
    59,
    "duplicate",
    [
      "Tio Marcos",
      "O Tio Marcos, irmão da Helena, é mecânico aposentado e tem um sítio em Itaipava.",
    ],
    ["Tio Marcos", MARCOS],
  ),
  p(
    60,
    "duplicate",
    [
      "Imposto de renda",
      "Até 15 de abril, mandar ao Renato os informes de rendimento e os recibos médicos.",
    ],
    ["Imposto de renda", IR],
  ),

  // About something else, though it shares a name.
  p(
    61,
    "unrelated",
    ["Gato da Lúcia", "A Lúcia tem um gato chamado Biscoito."],
    ["Antes de viajar", VIAGEM_CASA],
  ),
  p(
    62,
    "unrelated",
    ["Alergia da Patrícia", "A Patrícia é alérgica a camarão."],
    ["Fernanda Couto", FERNANDA],
  ),
  p(
    63,
    "unrelated",
    ["Renato e PDFs", "O Renato prefere receber documentos por e-mail em PDF."],
    ["Escritório de contabilidade", CONTABILIDADE],
  ),
  p(
    64,
    "unrelated",
    ["Wi-Fi do sítio", "No sítio do Tio Marcos, o Wi-Fi só funciona na varanda."],
    ["Wi-Fi de casa", WIFI_ANTES],
  ),
  p(
    65,
    "unrelated",
    ["Corrida", "Rafael corre às terças e quintas às 6h30."],
    ["Apartamento", APTO_ANTES],
  ),
  p(
    66,
    "unrelated",
    ["Aniversário da Ana", "A Ana faz aniversário em 14 de março."],
    ["Férias de dezembro", FERIAS_ANTES],
  ),
  p(
    67,
    "unrelated",
    ["Time do Bruno", "O Bruno torce pelo Atlético Mineiro."],
    ["Theo Lima", THEO],
  ),
  p(68, "unrelated", ["Pressão da Helena", "A Helena tem pressão alta."], ["Tio Marcos", MARCOS]),
  p(
    69,
    "unrelated",
    ["Reuniões da Carla", "A Carla prefere reuniões curtas e por escrito."],
    ["Reuniões", REUNIOES],
  ),
  p(
    70,
    "unrelated",
    ["Clínica da Júlia", "A Júlia trabalha numa clínica veterinária em Pinheiros."],
    ["Casamento", CASAMENTO],
  ),
  p(
    71,
    "unrelated",
    ["Milhas", "O programa de milhas do Rafael é o Smiles."],
    ["Férias de dezembro", FERIAS_ANTES],
  ),
  p(
    72,
    "unrelated",
    ["Moqueca", "O prato favorito do Rafael é moqueca capixaba."],
    ["Padaria Estrela", PADARIA],
  ),
  p(
    73,
    "unrelated",
    ["Estacionamento", "O estacionamento conveniado fica no prédio ao lado do escritório."],
    ["Banco da empresa", BANCO],
  ),
  p(74, "unrelated", ["Lego do Theo", "O Theo adora dinossauros e Lego."], ["Bruno Lima", BRUNO]),
  p(
    75,
    "unrelated",
    ["Reforma do escritório", "A Fernanda projetou a reforma do escritório da Lima & Souza."],
    ["Escritório da Lima & Souza", ESCRITORIO],
  ),
  p(76, "unrelated", ["Glúten", "A Júlia não come nada com glúten."], ["Padaria Estrela", PADARIA]),
  p(
    77,
    "unrelated",
    ["Dentista às terças", "O Dr. Paulo atende às terças e quintas."],
    ["Exercícios", EXERCICIO_ANTES],
  ),
  p(
    78,
    "unrelated",
    ["Réveillon", "A família passa o Réveillon no sítio do Tio Marcos."],
    ["Casamento", CASAMENTO],
  ),
  p(
    79,
    "unrelated",
    ["Cerâmica", "A Ana gosta de cerâmica."],
    ["Estúdio da Ana", "O estúdio de branding que a Ana abriu no Porto se chama Atelier Norte."],
  ),
  p(
    80,
    "unrelated",
    ["Descafeinado", "Depois das 16h, Rafael só toma descafeinado."],
    ["Reuniões", REUNIOES],
  ),
];
