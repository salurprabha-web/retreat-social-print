import { defineConfig } from 'vitest/config';
// TEST_STORAGE=s3fake: run every suite on the S3 backend (in-memory stand-in) instead of the local disk. Default: disk.
const s3 = process.env.TEST_STORAGE === "s3fake";
export default defineConfig({ test: { testTimeout: 60000, hookTimeout: 120000, fileParallelism: false, globalSetup: ['./test/globalSetup.ts'], setupFiles: s3 ? ['./test/setupS3Fake.ts'] : [] } });
