import type { FastifyReply } from "fastify";
import { config } from "./config";
import { getFile, presignGet } from "./storage";

/**
 * Sends a stored file. On object storage the browser is redirected to a short-lived signed address and fetches the bytes from the store
 * itself (a serverless function cannot return more than about 4.5 MB, and a finished 300 DPI picture or an original can be larger).
 * On local disk the bytes are sent directly, as before. Whoever may call this route has already been checked: the signed address only lives
 * a few minutes and names this one file.
 */
export async function sendStored(reply: FastifyReply, key: string, o: { mime: string; filename?: string; inline?: boolean }) {
  const url = await presignGet(key, { expiresIn: config.directUrlTtlSeconds, filename: o.filename, inline: o.inline, contentType: o.mime });
  if (url) return reply.redirect(url, 302);
  reply.header("Content-Type", o.mime);
  if (o.filename) reply.header("Content-Disposition", `attachment; filename="${o.filename}"`);
  else if (o.inline) reply.header("Content-Disposition", "inline");
  return reply.send(await getFile(key));
}
