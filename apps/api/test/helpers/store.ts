// Backend-neutral views of what is stored, so a test can say "this file exists / has these bytes" without knowing whether the files
// are on the local disk or in (fake) object storage. Imported lazily: the storage folder is chosen from the environment at first use.
const s = () => import("../../src/storage");

export const exists = async (key: string) => (await (await s()).statFile(key)) !== null;
export const readStored = async (key: string) => (await s()).getFile(key);
export const listStored = async (dir: string) => (await s()).listFiles(dir);
