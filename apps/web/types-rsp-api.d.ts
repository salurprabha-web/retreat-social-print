declare module "@rsp/api/serverless" {
  /** Hands a web Request to the API and returns its answer (see apps/api/src/serverless.ts). */
  export function handleRequest(req: Request): Promise<Response>;
}
