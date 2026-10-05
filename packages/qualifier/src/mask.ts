const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** A run of digits with the separators phone, CPF, CNPJ and card numbers use. */
const DIGIT_RUN = /\+?\(?\d[\d\s()./-]{6,}\d/g;
/** Fewer digits than this stay: order numbers, times, prices and dates. */
const MIN_MASKED_DIGITS = 8;

/**
 * Replaces emails and long numbers (phones, CPF, CNPJ, cards, accounts) in every string inside
 * `value`, before a qualifier sends it out (ADR-0009, ADR-0018). Names and addresses aren't caught.
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
  return text
    .replace(EMAIL, "[email]")
    .replace(DIGIT_RUN, (run) =>
      (run.match(/\d/g)?.length ?? 0) >= MIN_MASKED_DIGITS ? "[number]" : run,
    );
}
