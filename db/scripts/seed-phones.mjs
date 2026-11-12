// Seed phones must be non-dialable: +82 10-0000-00NN (an exchange never issued in KR), so no sender can ever page
// a real person. Used by check.mjs (`npm test -w @alarmops/db`); unit-tested in seed-phones.test.mjs.
const ALLOWED_LITERAL = /^\+8210000000(\d{2}|\$\{[^}]+\})$/;
const ALLOWED_DIGITS = /^\+8210000000\d{2}$/;
// a phone-shaped number anywhere (quoted or not; with or without +82 / leading 0; - or space separated):
// 010-1234-5678, 01012345678, 1012345678, +82 10 1234 5678. Not inside a longer word or number.
const PHONE_SHAPED = /(?<![\w+])(?:\+?82[- ]?)?0?10[- ]?\d{3,4}[- ]?\d{4}(?!\d)/g;

/** Every quoted literal that starts with `+` and a digit (', " or `). */
export const phoneLiterals = (text) => [...text.matchAll(/([`'"])(\+\d[^`'"\n]*)\1/g)].map((m) => m[2]);

/** The phone literals and phone-shaped numbers of `text` that are not the allowed +8210000000NN. */
export function badSeedPhones(text) {
  const bad = phoneLiterals(text).filter((p) => !ALLOWED_LITERAL.test(p));
  for (const m of text.matchAll(PHONE_SHAPED)) if (!ALLOWED_DIGITS.test(m[0].replace(/[- ]/g, ''))) bad.push(m[0]);
  return [...new Set(bad)];
}
