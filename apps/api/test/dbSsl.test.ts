import { describe, it, expect } from "vitest";
import { connectionSettings } from "../src/db";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----";

describe("database connection settings", () => {
  it("without a CA the connection string is used exactly as given (public authorities)", () => {
    const url = "postgres://u:p@host.example:5432/rsp?sslmode=require";
    expect(connectionSettings(url, {})).toEqual({ connectionString: url });
    expect(connectionSettings(url, { DATABASE_CA: "   " })).toEqual({ connectionString: url });
  });

  it("with a CA: the CA is trusted, the chain must verify, and the SSL parameters in the address are removed so they cannot override it", () => {
    const r = connectionSettings("postgres://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require&uselibpqcompat=true&application_name=rsp", { DATABASE_CA: PEM });
    expect(r.connectionString).toBe("postgres://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?application_name=rsp");
    const ssl = r.ssl as { ca: string; rejectUnauthorized: boolean; checkServerIdentity: () => unknown };
    expect(ssl.ca).toBe(PEM); expect(ssl.rejectUnauthorized).toBe(true); expect(ssl.checkServerIdentity()).toBeUndefined();
  });

  it("accepts the certificate with literal \n (how it is often pasted into a one-line setting)", () => {
    const r = connectionSettings("postgres://u:p@h/db", { DATABASE_CA: PEM.replace(/\n/g, "\n") });
    expect((r.ssl as { ca: string }).ca).toBe(PEM);
  });

  it("refuses something that is not a certificate (a mistyped setting must not silently weaken the connection)", () => {
    for (const bad of ["not a cert", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "https://example.com/ca.crt"]) {
      expect(() => connectionSettings("postgres://u:p@h/db", { DATABASE_CA: bad })).toThrow(/DATABASE_CA/);
    }
  });

  it("keeps a password with special characters intact", () => {
    const r = connectionSettings("postgres://u:p%40ss%2Fword@h:6543/db?sslmode=require", { DATABASE_CA: PEM });
    expect(new URL(r.connectionString).password).toBe("p%40ss%2Fword");
  });
});
