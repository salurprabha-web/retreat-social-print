/** Staff password policy, checked by the server wherever a password is set. Length matters more than complexity. */
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128;
const COMMON = ["password", "123456", "qwerty", "letmein", "welcome", "admin", "iloveyou", "abc123", "changeme", "retreat", "football", "monkey", "dragon", "master", "login"];

export type PasswordProblem = "too_short" | "too_long" | "too_common" | "contains_identity" | "repetitive";

export function passwordProblem(pw: string, who: { email?: string; name?: string } = {}): PasswordProblem | null {
  if (pw.length < MIN_PASSWORD) return "too_short";
  if (pw.length > MAX_PASSWORD) return "too_long";
  const low = pw.toLowerCase();
  if (/^(.)\1+$/.test(pw) || /^(.{1,3})\1+$/.test(pw)) return "repetitive";                     // aaaaaaaaaaaa, abcabcabcabc
  if (COMMON.some((c) => low.replace(/[^a-z0-9]/g, "").startsWith(c) && low.replace(/[^a-z]/g, "").length <= c.length + 4)) return "too_common";
  const local = (who.email ?? "").split("@")[0].toLowerCase();
  if ((local.length >= 4 && low.includes(local)) || ((who.name ?? "").trim().length >= 4 && low.includes((who.name ?? "").trim().toLowerCase()))) return "contains_identity";
  return null;
}
export const PASSWORD_MESSAGE: Record<PasswordProblem, string> = {
  too_short: `Use at least ${MIN_PASSWORD} characters.`, too_long: `Use at most ${MAX_PASSWORD} characters.`, too_common: "That password is too easy to guess.",
  contains_identity: "The password must not contain the email address or the name.", repetitive: "The password is too repetitive.",
};
