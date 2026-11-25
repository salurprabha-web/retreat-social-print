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

  describe("object storage and Vercel", () => {
    const s3env = { ...good, STORAGE_DIR: undefined, STORAGE_BACKEND: "s3", S3_BUCKET: "photos", S3_ACCESS_KEY_ID: "AKIAEXAMPLE", S3_SECRET_ACCESS_KEY: "s3cr3t-value-xyz", S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com" };
    const vercel = { ...s3env, VERCEL: "1", RATE_LIMIT_STORE: "pg", CRON_SECRET: "c".repeat(40), TRUST_PROXY: "1" };
    it("accepts a complete object-storage configuration (no STORAGE_DIR needed)", () => {
      expect(checkProductionEnv(s3env)).toEqual({ errors: [], warnings: [] });
    });
    it("object storage needs a bucket, keys and an https address", () => {
      expect(checkProductionEnv({ ...s3env, S3_BUCKET: undefined }).errors.join()).toMatch(/S3_BUCKET/);
      expect(checkProductionEnv({ ...s3env, S3_ACCESS_KEY_ID: undefined }).errors.join()).toMatch(/S3_ACCESS_KEY_ID/);
      expect(checkProductionEnv({ ...s3env, S3_SECRET_ACCESS_KEY: "" }).errors.join()).toMatch(/S3_SECRET_ACCESS_KEY/);
      expect(checkProductionEnv({ ...s3env, S3_ENDPOINT: "http://storage.example.com" }).errors.join()).toMatch(/https/);
      expect(checkProductionEnv({ ...s3env, S3_ENDPOINT: "http://localhost:9000" }).errors).toEqual([]);      // local test servers are fine
    });
    it("accepts a complete Vercel configuration", () => {
      expect(checkProductionEnv(vercel).errors).toEqual([]);
    });
    it("on Vercel it refuses local-disk storage, in-memory rate limits, a missing or short cron secret and offline mode", () => {
      expect(checkProductionEnv({ ...vercel, STORAGE_BACKEND: undefined, STORAGE_DIR: "/tmp/x" }).errors.join()).toMatch(/no persistent disk/);
      expect(checkProductionEnv({ ...vercel, RATE_LIMIT_STORE: undefined }).errors.join()).toMatch(/RATE_LIMIT_STORE=pg/);
      expect(checkProductionEnv({ ...vercel, RATE_LIMIT_STORE: "memory" }).errors.join()).toMatch(/RATE_LIMIT_STORE=pg/);
      expect(checkProductionEnv({ ...vercel, CRON_SECRET: undefined }).errors.join()).toMatch(/CRON_SECRET/);
      expect(checkProductionEnv({ ...vercel, CRON_SECRET: "short" }).errors.join()).toMatch(/CRON_SECRET/);
      expect(checkProductionEnv({ ...vercel, RSP_MODE: "local" }).errors.join()).toMatch(/offline venue server/);
    });
    it("the same settings are fine on a server of your own (the Vercel rules only apply on Vercel)", () => {
      expect(checkProductionEnv({ ...good, RATE_LIMIT_STORE: undefined, CRON_SECRET: undefined }).errors).toEqual([]);
    });
  });
});
