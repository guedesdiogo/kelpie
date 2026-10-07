// Builds the synthetic vault: the gold memories, surrounded by distractors until the vault holds
// the requested number of memories. Seeded, so a size always produces the same vault. Distractors
// reuse the gold's first names, cities and topics, so they compete with the answers.
import {
  type Kind,
  type MemoryInput,
  memoryPath,
  type Scope,
  type VaultChange,
  type VaultCommit,
  writeMemory,
} from "../src/index.ts";
import { GOLD_MEMORIES, type GoldMemory } from "./gold-vault.ts";

/** A small, fast, seeded PRNG (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FIRST_NAMES = [
  // The gold's own first names, so distractors compete with them
  "Ana",
  "Bruno",
  "Carla",
  "Paulo",
  "Júlia",
  "Helena",
  "Marcos",
  "Lúcia",
  "Patrícia",
  "Fernanda",
  "Renato",
  "Theo",
  "Gabriel",
  "Mariana",
  "Lucas",
  "Beatriz",
  "Pedro",
  "Camila",
  "Rodrigo",
  "Larissa",
  "Thiago",
  "Amanda",
  "Felipe",
  "Letícia",
  "Gustavo",
  "Isabela",
  "Matheus",
  "Vanessa",
  "Diego",
  "Aline",
  "Eduardo",
  "Natália",
  "Leonardo",
  "Priscila",
  "André",
  "Tatiane",
  "Ricardo",
  "Bianca",
  "Vinícius",
  "Daniela",
  "Fábio",
  "Renata",
  "Sérgio",
  "Cláudia",
  "Henrique",
  "Débora",
  "Igor",
  "Elaine",
  "Murilo",
  "Sabrina",
  "Otávio",
  "Yasmin",
  "Caio",
  "Gisele",
  "Rafaela",
  "Alexandre",
  "Simone",
  "Wagner",
  "Luana",
  "Márcio",
  "Viviane",
  "Roberto",
];
const SURNAMES = [
  "Almeida",
  "Barbosa",
  "Cardoso",
  "Castro",
  "Costa",
  "Dias",
  "Fernandes",
  "Freitas",
  "Gomes",
  "Lopes",
  "Martins",
  "Melo",
  "Moreira",
  "Nascimento",
  "Oliveira",
  "Pereira",
  "Ramos",
  "Ribeiro",
  "Rocha",
  "Santos",
  "Silva",
  "Soares",
  "Vieira",
  "Azevedo",
  "Campos",
  "Correia",
  "Duarte",
  "Farias",
  "Moura",
  "Nogueira",
  "Pinto",
  "Queiroz",
  "Rezende",
  "Sales",
  "Tavares",
  "Xavier",
  "Brandão",
  "Cunha",
  "Fonseca",
  "Guimarães",
];
const CITIES = [
  "São Paulo",
  "Rio de Janeiro",
  "Belo Horizonte",
  "Curitiba",
  "Porto Alegre",
  "Salvador",
  "Recife",
  "Fortaleza",
  "Brasília",
  "Florianópolis",
  "Campinas",
  "Santos",
  "Niterói",
  "Vitória",
  "Goiânia",
  "Manaus",
  "Belém",
  "Natal",
  "João Pessoa",
  "Londrina",
  "Ribeirão Preto",
  "Juiz de Fora",
  "Petrópolis",
  "Paraty",
  "Itaipava",
  "Lisboa",
  "Porto",
  "Madri",
  "Buenos Aires",
  "Santiago",
  "Montevidéu",
  "Londres",
  "Berlim",
  "Nova York",
  "Toronto",
];
const NEIGHBORHOODS = [
  "Moema",
  "Perdizes",
  "Tatuapé",
  "Santana",
  "Butantã",
  "Lapa",
  "Ipiranga",
  "Brooklin",
  "Itaim Bibi",
  "Consolação",
  "Liberdade",
  "Higienópolis",
  "Mooca",
  "Saúde",
  "Pinheiros",
  "Vila Mariana",
  "Vila Madalena",
  "Aclimação",
];
const PROFESSIONS = [
  "engenheira civil",
  "advogado",
  "enfermeira",
  "professor de história",
  "desenvolvedora",
  "fotógrafo",
  "nutricionista",
  "dentista",
  "arquiteto",
  "jornalista",
  "economista",
  "psicóloga",
  "farmacêutico",
  "chef de cozinha",
  "músico",
  "designer de interiores",
  "contadora",
  "veterinário",
  "fisioterapeuta",
  "piloto",
  "médica pediatra",
  "designer gráfica",
];
const RELATIONS = [
  "Colega de faculdade do Rafael",
  "Cliente da consultoria",
  "Amigo do Bruno",
  "Vizinho do antigo prédio",
  "Prima da Júlia",
  "Ex-colega de trabalho do Rafael",
  "Conhecido do clube de corrida",
  "Fornecedor da Lima & Souza",
  "Colega da Ana na agência",
  "Amiga da família em Belo Horizonte",
  "Primo do Rafael",
  "Professor do curso de inglês",
];
const HOBBIES = [
  "fotografia",
  "tênis",
  "ciclismo",
  "jardinagem",
  "xadrez",
  "culinária japonesa",
  "surfe",
  "cinema europeu",
  "vinhos",
  "escalada",
  "crochê",
  "natação",
  "pesca",
  "violão",
  "yoga",
  "trilhas",
  "cerâmica",
  "corrida de rua",
  "jazz",
  "MPB",
];
const FOODS = [
  "lasanha",
  "sushi",
  "feijoada",
  "risoto de cogumelos",
  "pizza napolitana",
  "tapioca",
  "acarajé",
  "pão de queijo",
  "bacalhau",
  "churrasco",
  "salada caesar",
  "ramen",
  "moqueca baiana",
  "escondidinho",
  "café com leite",
  "picanha",
];
const CLIENTS = [
  "Construtora Atlântica",
  "Grupo Vértice",
  "Mercado Boa Praça",
  "Clínica Sorriso",
  "Transportadora Rápida Sul",
  "Editora Lumen",
  "Hotel Mirante",
  "Laboratório Vida",
  "Agência Pixel",
  "Escola Aprender",
  "Fazenda Boa Vista",
  "Banco Regional",
  "Studio Forma",
  "Cervejaria Serra Alta",
  "Rede Farma Mais",
  "Construtora Horizonte Sul",
];
const PRODUCTS = [
  ["sabão em pó", "Omo"],
  ["fones de ouvido", "Sony"],
  ["papel higiênico", "Neve"],
  ["caneta", "Pilot"],
  ["mochila", "Osprey"],
  ["travesseiro", "Nasa"],
  ["protetor solar", "La Roche"],
  ["shampoo", "Natura"],
  ["cerveja", "Baden Baden"],
  ["vinho", "Miolo"],
  ["chocolate", "Cacau Show"],
  ["chá", "Leão"],
  ["azeite", "Gallo"],
  ["notebook", "Lenovo"],
  ["cadeira de escritório", "Flexform"],
  ["tênis de corrida", "Asics"],
  ["iogurte", "Batavo"],
  ["queijo", "Canastra"],
] as const;
const PLACE_TYPES = [
  "Restaurante",
  "Café",
  "Livraria",
  "Academia",
  "Mercado",
  "Pousada",
  "Hotel",
  "Oficina",
  "Lavanderia",
  "Farmácia",
  "Barbearia",
  "Pet shop",
  "Clínica",
  "Padaria",
  "Bar",
];
const PLACE_NAMES = [
  "Aurora",
  "Bom Gosto",
  "Central",
  "Da Esquina",
  "Flor de Lis",
  "Girassol",
  "Horizonte",
  "Ipê",
  "Jardim",
  "Lua Nova",
  "Mirante",
  "Oliveira",
  "Primavera",
  "Sabiá",
  "Vitória",
];
const TASKS = [
  "Responder a proposta do {client}",
  "Enviar o orçamento para o {client}",
  "Revisar o contrato do {client}",
  "Agendar a reunião de início com o {client}",
  "Comprar o presente de aniversário de {person}",
  "Devolver o livro emprestado de {person}",
  "Marcar exame de vista",
  "Levar o notebook para a assistência",
  "Pagar a anuidade da academia",
  "Renovar a assinatura do jornal",
  "Mandar as fotos da viagem para {person}",
  "Ligar para {person} sobre o churrasco",
  "Confirmar a reserva no {place}",
];
const SESSION_TOPICS = [
  "o orçamento do {client}",
  "a reforma da cozinha de {person}",
  "um curso de {hobby}",
  "a mudança de {person} para {city}",
  "o cronograma do {client}",
  "uma viagem a {city}",
  "o aniversário de {person}",
  "um jantar no {place}",
  "a renovação do contrato do {client}",
];
const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** Where a labelled memory version ended up. */
export interface LabelTarget {
  path: string;
  commit: string;
}

export interface SyntheticVault {
  commits: VaultCommit[];
  /** `key` (current version) and `key@n` (the n-th) to where each landed. */
  labels: Map<string, LabelTarget>;
  /** Memories in the vault at its head. */
  memories: number;
}

interface Planned {
  /** `YYYY-MM-DD` */
  at: string;
  path: string;
  input: MemoryInput;
  /** Set for gold versions: `key@n`. */
  label?: string;
  /** Gold versions go in their own commit after the day's distractors. */
  gold: boolean;
}

const DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00Z");
const DAYS = 273; // through 2026-09-30

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Builds a vault of `size` memories: the gold ones plus seeded distractors. */
/** The seed the baseline was recorded with. */
export const SEED = 107;

export async function buildVault(
  size: number,
  seed = SEED,
  options: {
    /** Abstracts for session pages by path, as Dream would give them (#112). */
    abstracts?: ReadonlyMap<string, string>;
  } = {},
): Promise<SyntheticVault> {
  if (size < GOLD_MEMORIES.length)
    throw new RangeError(`size must be at least ${GOLD_MEMORIES.length}`);
  const rand = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const used = new Set<string>();
  const planned: Planned[] = [];
  const goldNames = new Set(GOLD_MEMORIES.filter((m) => m.kind === "person").map((m) => m.title));

  const claim = (scope: Scope, kind: Kind, title: string, date?: string): string => {
    const base = memoryPath(scope, kind, title, date);
    let path = base;
    for (let n = 2; used.has(path); n += 1) path = base.replace(/\.md$/, `-${n}.md`);
    used.add(path);
    return path;
  };

  // The gold first, so it keeps its readable paths.
  for (const memory of GOLD_MEMORIES) planGold(memory, planned, claim);

  const person = () => {
    for (;;) {
      const name = `${pick(FIRST_NAMES)} ${pick(SURNAMES)}`;
      if (!goldNames.has(name)) return name;
    }
  };
  // Only the placeholders a template has draw from the generator.
  const fillers: Record<string, () => string> = {
    client: () => pick(CLIENTS),
    person,
    city: () => pick(CITIES),
    hobby: () => pick(HOBBIES),
    place: () => `${pick(PLACE_TYPES)} ${pick(PLACE_NAMES)}`,
  };
  const fill = (template: string) =>
    template.replace(/\{(\w+)\}/g, (_, key: string) => fillers[key]?.() ?? `{${key}}`);
  const day = () => Math.floor(rand() * DAYS);

  for (let i = 0; i < size - GOLD_MEMORIES.length; i += 1) {
    const first = day();
    const distractor = makeDistractor(rand, pick, person, fill, first);
    const path = claim(distractor.scope, distractor.kind, distractor.title, distractor.date);
    const level = rand() < 0.7 ? "explicit" : rand() < 0.5 ? "deduced" : "inferred";
    const base: MemoryInput = {
      scope: distractor.scope,
      kind: distractor.kind,
      title: distractor.title,
      body: distractor.body,
      level,
      confidence: Math.round((0.5 + rand() * 0.5) * 100) / 100,
      ...(distractor.entities.length ? { entities: distractor.entities } : {}),
      ...(distractor.validFrom ? { validFrom: distractor.validFrom } : {}),
      ...(distractor.invalidAt ? { invalidAt: distractor.invalidAt } : {}),
    };
    planned.push({ at: isoDate(START + first * DAY), path, input: base, gold: false });
    // One in ten changes later, so the index holds superseded versions at every size.
    if (rand() < 0.1 && first < DAYS - 1) {
      const later = first + 1 + Math.floor(rand() * (DAYS - 1 - first));
      planned.push({
        at: isoDate(START + later * DAY),
        path,
        input: { ...base, body: `${base.body} Atualização: ${fill(pick(UPDATES))}.` },
        gold: false,
      });
    }
  }

  for (const item of planned) {
    const abstract = options.abstracts?.get(item.path);
    if (abstract !== undefined && item.input.kind === "session") {
      item.input = { ...item.input, abstract };
    }
  }
  return assemble(planned);
}

const UPDATES = [
  "mudou-se para {city}",
  "agora trabalha com o {client}",
  "passou a gostar de {hobby}",
  "o encontro foi remarcado para {city}",
  "a conversa continua com {person}",
];

interface Distractor {
  scope: Scope;
  kind: Kind;
  title: string;
  body: string;
  entities: string[];
  date?: string;
  validFrom?: string;
  invalidAt?: string;
}

function makeDistractor(
  rand: () => number,
  pick: <T>(list: readonly T[]) => T,
  person: () => string,
  fill: (template: string) => string,
  first: number,
): Distractor {
  const roll = rand();
  const dayOfYear = isoDate(START + first * DAY);
  if (roll < 0.25) {
    const name = person();
    const city = pick(CITIES);
    return {
      scope: "global",
      kind: "person",
      title: name,
      body: `${pick(RELATIONS)}. ${capitalize(pick(PROFESSIONS))}, mora em ${city}. Aniversário em ${1 + Math.floor(rand() * 28)} de ${pick(MONTHS)}. Gosta de ${pick(HOBBIES)}.`,
      entities: [name, city],
    };
  }
  if (roll < 0.35) {
    const name = `${pick(PLACE_TYPES)} ${pick(PLACE_NAMES)}`;
    const where = rand() < 0.6 ? pick(NEIGHBORHOODS) : pick(CITIES);
    return {
      scope: "global",
      kind: "place",
      title: `${name} (${where})`,
      body: `${name}, em ${where}. O destaque é ${pick(FOODS)}; fecha às ${18 + Math.floor(rand() * 6)}h e aceita reserva por WhatsApp.`,
      entities: [name, where],
    };
  }
  if (roll < 0.47) {
    if (rand() < 0.5) {
      const [product, brand] = pick(PRODUCTS);
      return {
        scope: "global",
        kind: "preference",
        title: capitalize(product),
        body: `Rafael prefere ${product} da marca ${brand}; acha o custo-benefício melhor.`,
        entities: [brand],
      };
    }
    const name = person();
    return {
      scope: "global",
      kind: "preference",
      title: `Preferências de ${name}`,
      body: `${name} prefere ${pick(FOODS)} e não gosta de ${pick(FOODS)}. Para presentes, gosta de coisas ligadas a ${pick(HOBBIES)}.`,
      entities: [name],
    };
  }
  if (roll < 0.6) {
    const start = first;
    const end = Math.min(start + 7 + Math.floor(rand() * 120), 364);
    const due = new Date(START + end * DAY);
    return {
      scope: rand() < 0.5 ? "area/work" : "global",
      kind: "commitment",
      title: fill(pick(TASKS)),
      body: `Prazo: ${due.getUTCDate()} de ${MONTHS[due.getUTCMonth()]} de 2026.`,
      entities: [],
      validFrom: dayOfYear,
      invalidAt: isoDate(START + (end + 1) * DAY),
    };
  }
  if (roll < 0.68) {
    const client = pick(CLIENTS);
    return {
      scope: "area/work",
      kind: "decision",
      title: `Decisão sobre ${fill("o {client}")} (${dayOfYear})`,
      body: `Para o ${client}, decidimos ${pick(["adiar a entrega", "trocar o fornecedor", "fechar contrato anual", "contratar mais um analista", "rever o escopo"])} por causa de ${pick(["custo", "prazo", "qualidade", "pedido do cliente", "risco de atraso"])}.`,
      entities: [client],
    };
  }
  if (roll < 0.78) {
    const name = person();
    const city = pick(CITIES);
    const what = pick(["Casamento", "Formatura", "Aniversário", "Viagem", "Mudança", "Show"]);
    return {
      scope: "global",
      kind: "event",
      title: `${what} de ${name}`,
      date: dayOfYear,
      body: `${what} de ${name} em ${city}, em ${new Date(START + first * DAY).getUTCDate()} de ${MONTHS[new Date(START + first * DAY).getUTCMonth()]}. Rafael ${pick(["foi", "não pôde ir", "mandou presente", "ligou para dar parabéns"])}.`,
      entities: [name, city],
    };
  }
  if (roll < 0.9) {
    const topic = fill(pick(SESSION_TOPICS));
    return {
      scope: rand() < 0.3 ? "area/work" : "global",
      kind: "session",
      title: `Conversa sobre ${topic}`,
      date: dayOfYear,
      body: `Conversa sobre ${topic}. Ficou combinado ${pick(["retomar na semana que vem", "mandar um resumo por e-mail", "pesquisar preços", "falar com o Bruno antes", "esperar a resposta"])}.`,
      entities: [],
    };
  }
  if (roll < 0.95) {
    const task = pick([
      "pedir reembolso de despesas",
      "agendar a sala de reunião",
      "atualizar o site da consultoria",
      "fazer backup do notebook",
      "renovar o certificado digital",
      "cadastrar um fornecedor novo",
      "trocar o filtro do purificador",
      "configurar a impressora",
    ]);
    return {
      scope: rand() < 0.6 ? "area/work" : "global",
      kind: "procedure",
      title: `Como ${task} (${dayOfYear})`,
      body: `Para ${task}: abrir o sistema, preencher o formulário e avisar ${person()} por e-mail.`,
      entities: [],
    };
  }
  const food = pick(FOODS);
  return {
    scope: "global",
    kind: "note",
    title: `Receita de ${food} (${dayOfYear})`,
    body: `Anotação: receita de ${food} que ${person()} passou. Rende quatro porções.`,
    entities: [],
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function planGold(
  memory: GoldMemory,
  planned: Planned[],
  claim: (scope: Scope, kind: Kind, title: string, date?: string) => string,
): void {
  const scope = memory.scope ?? "global";
  const path = claim(scope, memory.kind, memory.title, memory.date);
  memory.versions.forEach((version, index) => {
    planned.push({
      at: version.at,
      path,
      label: `${memory.key}@${index + 1}`,
      gold: true,
      input: {
        scope,
        kind: memory.kind,
        title: memory.title,
        body: version.body,
        level: "explicit",
        confidence: 0.9,
        ...(version.entities ? { entities: version.entities } : {}),
        ...(version.validFrom ? { validFrom: version.validFrom } : {}),
        ...(version.invalidAt ? { invalidAt: version.invalidAt } : {}),
        ...(version.abstract ? { abstract: version.abstract } : {}),
      },
    });
  });
}

async function assemble(planned: Planned[]): Promise<SyntheticVault> {
  // Commits in date order; on a day, distractors at 10:00 and the gold at 12:00 UTC.
  const groups = new Map<string, Planned[]>();
  for (const item of planned) {
    const key = `${item.at}${item.gold ? "T12" : "T10"}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const files = new Map<string, string>();
  const labels = new Map<string, LabelTarget>();
  const commits: VaultCommit[] = [];
  for (const key of [...groups.keys()].sort()) {
    const items = groups.get(key) ?? [];
    const sha = (commits.length + 1).toString(16).padStart(40, "0");
    const committedAt = Date.parse(`${key}:00:00Z`);
    const changes: VaultChange[] = [];
    for (const item of items) {
      const existing = files.get(item.path);
      const { text } = await writeMemory(item.input, {
        at: new Date(committedAt).toISOString().replace(".000Z", "Z"),
        ...(existing === undefined ? {} : { existing }),
      });
      files.set(item.path, text);
      changes.push({ path: item.path, content: text });
      if (item.label) labels.set(item.label, { path: item.path, commit: sha });
    }
    commits.push({ sha, committedAt, changes });
  }
  // `key` names the current version: the last one.
  for (const memory of GOLD_MEMORIES) {
    const last = labels.get(`${memory.key}@${memory.versions.length}`);
    if (last) labels.set(memory.key, last);
  }
  return { commits, labels, memories: files.size };
}
