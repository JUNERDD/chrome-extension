const SENSITIVE_FIELD_PATTERN =
  /(?:password|passwd|passcode|pwd|pin|otp|token|secret|auth(?!or)|authorization|credential|cookie|session|csrf|xsrf|apikey|clientsecret|accesstoken|refreshtoken|account|identity|payment|card|iban|ssn|idnumber|requestbody|responsebody)/iu;

export function isSensitiveFieldName(name: string): boolean {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return compact.length > 0 && SENSITIVE_FIELD_PATTERN.test(compact);
}
