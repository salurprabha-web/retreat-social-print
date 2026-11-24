import { describe, it, expect } from "vitest";
import { checkProductionEnv, parseTrustProxy } from "../src/prodcheck";

const good = { SESSION_SECRET: "k9Xz2mQ7vL4nB8tR1wY6uE3pA5sD0fGh", DATABASE_URL: "postgres://rsp:S7k2-xQ9vLm4@db:5432/rsp", PUBLIC_BASE_URL: "https://photos.example.com", STORAGE_DIR: "/var/lib/rsp/storage", TRUST_PROXY: "1" };

describe("production environment check", () => {
  it("accepts a sound configuration without complaints", () => {
    expect(checkProductionEnv(good)).toEqual({ errors: [], warnings: [] });
  });
  it("refuses to start with a missing, short or placeholder secret", () => {
    expect(checkProductionEnv({ ...good, SESSION_SECRET: undefined }).errors[0]).toMatch(/SESSION_SECRET is not set/);
    expect(checkProductionEnv({ ...good, SESSION_SECRET: "abc" }).errors[0]).toMatch(/too short/);
    expect(checkProductionEnv({ ...good, SESSION_SECRET: "a".repeat(40) }).errors[0]).toMatch(/placeholder/);
    expect(checkProductionEnv({ ...good, SESSION_SECRET: "dev-only-insecure-secret" }).errors.length).toBeGreaterThan(0);
  });
  it("refuses a missing, default-password or malformed database address", () => {
    expect(checkProductionEnv({ ...good, DATABASE_URL: undefined }).errors[0]).toMatch(/DATABASE_URL is not set/);
    expect(checkProductionEnv({ ...good, DATABASE_URL: "postgres://postgres:postgres@db/rsp" }).errors[0]).toMatch(/default database password/);
    expect(checkProductionEnv({ ...good, DATABASE_URL: "mysql://u:p@db/x" }).errors[0]).toMatch(/must start with postgres/);
  });
  it("requires https for the public address and never allows insecure cookies", () => {
    expect(checkProductionEnv({ ...good, PUBLIC_BASE_URL: "http://photos.example.com" }).errors[0]).toMatch(/https/);
    expect(checkProductionEnv({ ...good, PUBLIC_BASE_URL: undefined }).warnings[0]).toMatch(/PUBLIC_BASE_URL/);
    expect(checkProductionEnv({ ...good, COOKIE_SECURE: "false" }).errors[0]).toMatch(/COOKIE_SECURE/);
    expect(checkProductionEnv({ ...good, COOKIE_SECURE: "true" }).errors).toEqual([]);
  });
  it("warns about storage and proxy settings that make a deployment fragile", () => {
    expect(checkProductionEnv({ ...good, STORAGE_DIR: undefined }).warnings.join()).toMatch(/STORAGE_DIR is not set/);
    expect(checkProductionEnv({ ...good, STORAGE_DIR: "./storage" }).warnings.join()).toMatch(/relative/);
    expect(checkProductionEnv({ ...good, TRUST_PROXY: undefined }).warnings.join()).toMatch(/TRUST_PROXY/);
    expect(checkProductionEnv({ ...good, STORAGE_DIR: "D:\\rsp\\storage" }).warnings).toEqual([]);
  });
  it("a venue (local) server must reach the cloud over https and have both halves of the sync setup", () => {
    const local = { ...good, RSP_MODE: "local" };
    expect(checkProductionEnv({ ...local, CLOUD_URL: "http://cloud.example.com", SYNC_TOKENS: "sync_x" }).errors[0]).toMatch(/CLOUD_URL must be an https/);
    expect(checkProductionEnv({ ...local, CLOUD_URL: "https://cloud.example.com" }).warnings.join()).toMatch(/SYNC_TOKENS is empty/);
    expect(checkProductionEnv({ ...local, SYNC_TOKENS: "sync_x" }).warnings.join()).toMatch(/CLOUD_URL is empty/);
    expect(checkProductionEnv({ ...local, CLOUD_URL: "https://cloud.example.com", SYNC_TOKENS: "sync_x", PUBLIC_BASE_URL: "https://x.test" }).errors).toEqual([]);
  });
});

describe("trust proxy setting", () => {
  it("understands booleans, hop counts and address lists", () => {
    expect(parseTrustProxy(undefined)).toBe(true); expect(parseTrustProxy("true")).toBe(true); expect(parseTrustProxy("false")).toBe(false); expect(parseTrustProxy("0")).toBe(false);
    expect(parseTrustProxy("2")).toBe(2); expect(parseTrustProxy("10.0.0.0/8, 172.16.0.1")).toEqual(["10.0.0.0/8", "172.16.0.1"]);
  });
});
