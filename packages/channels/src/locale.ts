// Kelpie's fixed texts in the person's language (#187, ADR-0027): English, Brazilian Portuguese
// and Spanish. A chat text follows the language the person writes in, else the one their device
// selects; a page, the language of the conversation that sent its link, else the browser's. Any
// other language gets English.

export const LOCALES = ["en", "pt-BR", "es"] as const;
export type Locale = (typeof LOCALES)[number];

/** One text in every locale. */
export type Localized<T = string> = Record<Locale, T>;

/** The longest language tag kept, as Telegram's `language_code` names one. */
export const MAX_LANGUAGE_TAG_CHARS = 35;
/** The longest device language kept: a tag, or an `Accept-Language` value of a few tags. */
export const MAX_LANGUAGE_CHARS = 200;

/** The locale of a value Kelpie stored or put in a link, or null for anything else. */
export function isLocale(value: unknown): value is Locale {
  return (LOCALES as readonly unknown[]).includes(value);
}

/**
 * The locale a language tag names (Telegram's `language_code`, `navigator.language`), or that an
 * `Accept-Language` header's first choice names: `pt` and `pt-PT` read as Brazilian Portuguese,
 * `es-419` as Spanish. Null when it names none of them, so the caller's fallback applies: the
 * selected language is the first choice, and a later one doesn't stand in for it.
 */
export function localeOf(value: string | null | undefined): Locale | null {
  if (!value) return null;
  let first = "";
  let best = 0;
  for (const part of value.split(",")) {
    const [tag = "", ...params] = part.split(";").map((piece) => piece.trim());
    const quality = params.find((param) => param.toLowerCase().startsWith("q="));
    const weight = quality === undefined ? 1 : Number(quality.slice(2));
    if (tag !== "" && Number.isFinite(weight) && weight > best) {
      first = tag;
      best = weight;
    }
  }
  switch (first.toLowerCase().split(/[-_]/)[0]) {
    case "pt":
      return "pt-BR";
    case "es":
      return "es";
    case "en":
      return "en";
    default:
      return null;
  }
}

/**
 * Words that mark one language among the three: common words the others don't share. Shared ones
 * ("de", "que", "para", "no", "a", "o", "as", "do") are left out.
 */
const MARKERS: Localized<ReadonlySet<string>> = {
  en: new Set(
    "the and is are was you your what which who how please thanks thank yes hello hi hey with this that these have has want can does don't dont not will would should there here i i'm we let's lets it to of for in on my new create done now good great just an or be if from about up".split(
      " ",
    ),
  ),
  "pt-BR": new Set(
    "não nao você voce vocês está estou estão obrigado obrigada olá ola oi sim isso isto também tambem então entao feito agora quero posso pode fazer meu minha meus minhas com uma um umas uns os das na ao é eu ele ela esse essa quais qual aí tenho tem criar novo nova ainda muito tudo bom boa pra mude faça faz certo beleza mostra ajuda preciso".split(
      " ",
    ),
  ),
  es: new Set(
    "el los las del al y estoy están usted ustedes gracias hola sí también entonces hecho listo ahora aquí quiero puedo hacer mi mis con una un lo le les yo él ella eso esto ese cuál cuáles cual pero muy ya hay soy tengo tiene crear nuevo nueva bueno buena bien qué cómo dónde ahí muestra muéstrame ayuda ayúdame necesito".split(
      " ",
    ),
  ),
};

/** Letters only one of the three uses. */
const MARKER_LETTERS: [RegExp, Locale][] = [
  [/[ãõç]/giu, "pt-BR"],
  [/[ñ¿¡]/giu, "es"],
];

/** Each language's marker words and letters in a text. */
function scoresOf(text: string): Localized<number> {
  const scores: Localized<number> = { en: 0, "pt-BR": 0, es: 0 };
  // One spelling for each word: composed accents, and a straight apostrophe for a curly one.
  const plain = text.normalize("NFC").replace(/[\u2018\u2019]/gu, "'");
  const words = plain
    .toLowerCase()
    .replace(/https?:\/\/\S+/giu, " ")
    .match(/[\p{L}']+/gu);
  for (const word of words ?? []) {
    for (const locale of LOCALES) if (MARKERS[locale].has(word)) scores[locale] += 1;
  }
  for (const [letters, locale] of MARKER_LETTERS) {
    scores[locale] += plain.match(letters)?.length ?? 0;
  }
  return scores;
}

/**
 * The language of what a person wrote, when its words say it clearly: the one with the most
 * marker words and letters, ahead of the others. Given several messages, newest first, each counts
 * half as much as the one after it, so a clear switch shows at once while a stray word doesn't
 * outweigh the conversation. Null for text that doesn't say, such as "ok", a code or a link, so the
 * conversation keeps the language it had.
 */
export function detectLocale(texts: string | readonly string[]): Locale | null {
  const scores: Localized<number> = { en: 0, "pt-BR": 0, es: 0 };
  (typeof texts === "string" ? [texts] : texts).forEach((text, age) => {
    const own = scoresOf(text);
    for (const locale of LOCALES) scores[locale] += own[locale] / 2 ** age;
  });
  const [first, second] = [...LOCALES].sort((a, b) => scores[b] - scores[a]);
  if (!first || !second || scores[first] === 0 || scores[first] === scores[second]) return null;
  return first;
}
