/** Zero-width and other format characters, which could split a number or an address. */
const INVISIBLE = /\p{Cf}/gu;
/** A link's query string or fragment, where tokens travel. */
const LINK_QUERY = /(https?:\/\/[^\s?#]+)[?#]\S*/giu;
/** Bounded parts (RFC 5321 limits), so a long run without an @ is scanned in linear time. */
const EMAIL = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+/gu;
/** Key- or token-like strings. Ordinary words are shorter. */
const TOKEN = /[A-Za-z0-9_-]{24,}/g;
/** A run of digits, in any script, with the separators phones, CPF, CNPJ and cards use. */
const DIGIT_RUN = /\+?\(?\p{Nd}[\p{Nd}\s()./-]{6,}\p{Nd}/gu;
/** Fewer digits than this stay: order numbers, times, prices. A full date has 8 and is masked. */
const MIN_MASKED_DIGITS = 8;

/**
 * Replaces emails, link query strings, token-like strings and long numbers (phones, CPF, CNPJ,
 * cards, accounts) in every string inside `value`, before a qualifier sends it out (ADR-0009,
 * ADR-0018). Names, addresses and numbers written in words aren't caught.
 */
export function maskPersonalData(value: unknown): unknown {
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map(maskPersonalData);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, maskPersonalData(entry)]),
    );
  }
  return value;
}

function maskText(text: string): string {
  // NFKC turns full-width digits and "＠" into their ASCII forms first.
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(LINK_QUERY, "$1?[query]")
    .replace(EMAIL, "[email]")
    .replace(TOKEN, "[token]")
    .replace(DIGIT_RUN, (run) =>
      (run.match(/\p{Nd}/gu)?.length ?? 0) >= MIN_MASKED_DIGITS ? "[number]" : run,
    );
}
