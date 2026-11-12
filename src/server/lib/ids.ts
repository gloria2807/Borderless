import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford-ish, no ambiguous chars

/** Sortable, prefixed identifier, e.g. `pur_01kc2…`. Time-ordered for readable audit logs. */
export function newId(prefix: string): string {
  const time = Date.now().toString(32).padStart(10, "0");
  const bytes = randomBytes(10);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `${prefix}_${time}${rand}`;
}
