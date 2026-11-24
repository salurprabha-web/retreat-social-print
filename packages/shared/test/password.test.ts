import { describe, it, expect } from "vitest";
import { passwordProblem } from "../src";

describe("password policy", () => {
  it("accepts long, unpredictable passwords and passphrases", () => {
    for (const p of ["correct horse battery staple", "T7#kq9-Lm2v!xP4z", "a-long-sentence-about-nothing-1", "Zx9!Zx9!Qw3@"]) expect(passwordProblem(p), p).toBeNull();
  });
  it("refuses short ones", () => { expect(passwordProblem("Ab1!xyz")).toBe("too_short"); expect(passwordProblem("12345678901")).toBe("too_short"); });
  it("refuses very long ones", () => expect(passwordProblem("a1".repeat(80) + "Qz!")).toBe("too_long"));
  it("refuses common and repetitive passwords", () => {
    for (const p of ["password1234", "Password123456", "qwertyuiop12", "123456789012", "changeme12345", "aaaaaaaaaaaa", "abcabcabcabc", "retreat123456"]) expect(passwordProblem(p), p).not.toBeNull();
  });
  it("refuses passwords built from the person's own email or name", () => {
    expect(passwordProblem("jane.smith-2026-xyz", { email: "jane.smith@corp.test" })).toBe("contains_identity");
    expect(passwordProblem("my-name-is-Priya Nair-ok", { name: "Priya Nair" })).toBe("contains_identity");
    expect(passwordProblem("unrelated-passphrase-here", { email: "jane.smith@corp.test", name: "Jane" })).toBeNull();
  });
});
