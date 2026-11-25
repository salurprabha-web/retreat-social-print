import { S3Client } from "@aws-sdk/client-s3";
import { S3Backend } from "../src/storageBackends";
import { FakeS3 } from "./helpers/fakeS3";

// TEST_STORAGE=s3fake runs a whole suite on the S3 backend (in-memory stand-in) instead of the local disk.
// Each test file gets its own empty bucket. The signing client is a real one (signing is local arithmetic, no network).
const signer = new S3Client({ region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com", credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" } });
(globalThis as any).__rspStorageFactory = () => new S3Backend(new FakeS3(), "test-bucket", "", signer);
