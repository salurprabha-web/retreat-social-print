import { S3Backend } from "../src/storageBackends";
import { FakeS3 } from "./helpers/fakeS3";

// TEST_STORAGE=s3fake runs a whole suite on the S3 backend (in-memory stand-in) instead of the local disk.
// Each test file gets its own empty bucket. Suites that look at files on disk are listed in DISK_ONLY and skipped in this mode.
(globalThis as any).__rspStorageFactory = () => new S3Backend(new FakeS3(), "test-bucket");
