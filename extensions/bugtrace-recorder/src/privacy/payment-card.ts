export interface PaymentCardCandidate {
  index: number;
  value: string;
}

function passesLuhnCheck(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  if (/^(\d)\1+$/u.test(digits)) return false;

  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function hasSupportedPanShape(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length === 13) return digits.startsWith('4');
  if (digits.length === 14) return /^(?:30[0-5]|3[689])/u.test(digits);
  return digits.length >= 15 && digits.length <= 19;
}

function isJsonTimestamp(text: string, candidate: PaymentCardCandidate): boolean {
  const digits = candidate.value.replace(/[^0-9]/g, '');
  if (digits.length !== 13 || /[\p{White_Space}\p{Dash}]/u.test(candidate.value)) return false;
  const prefix = text.slice(Math.max(0, candidate.index - 48), candidate.index);
  return /["']?timestamp["']?\s*:\s*$/iu.test(prefix);
}

/**
 * Finds likely PANs without treating ordinary 13-digit epoch fields as cards. The export layer
 * consumes only the offsets; callers must never expose `value` in diagnostics.
 */
export function findPaymentCardCandidates(text: string): PaymentCardCandidate[] {
  const candidates: PaymentCardCandidate[] = [];
  // Card UIs and copied statements commonly use non-breaking/thin spaces or typographic
  // dashes. Treat every Unicode whitespace and Dash-property character as formatting,
  // otherwise the same PAN would bypass both capture-time redaction and the export guard.
  const expression =
    /(?:^|[^0-9])([0-9](?:[\p{White_Space}\p{Dash}]?[0-9]){12,18})(?=$|[^0-9])/gu;
  for (const match of text.matchAll(expression)) {
    const value = match[1];
    if (!value) continue;
    const candidate = {
      index: (match.index ?? 0) + match[0].indexOf(value),
      value,
    };
    if (
      hasSupportedPanShape(value) &&
      passesLuhnCheck(value) &&
      !isJsonTimestamp(text, candidate)
    ) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function redactPaymentCardsInText(
  text: string,
  pseudonymize: (secret: string) => string,
): string {
  const candidates = findPaymentCardCandidates(text);
  if (candidates.length === 0) return text;

  let cursor = 0;
  let output = '';
  for (const candidate of candidates) {
    output += text.slice(cursor, candidate.index);
    output += pseudonymize(candidate.value);
    cursor = candidate.index + candidate.value.length;
  }
  return output + text.slice(cursor);
}
