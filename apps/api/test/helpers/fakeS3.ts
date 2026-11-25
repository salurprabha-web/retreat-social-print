import { Readable } from "node:stream";

/**
 * In-memory stand-in for the part of the S3 client the platform uses. It mimics the real behaviours the code depends on:
 * a missing key raises NoSuchKey (Head: NotFound, status 404), listing is paginated and honours Prefix/Delimiter, deletes are idempotent.
 * It proves OUR logic. It does not prove the behaviour of a real R2 bucket; that is checked on the real deployment.
 */
export class FakeS3 {
  objects = new Map<string, { body: Buffer; contentType?: string }>();
  calls: string[] = [];
  constructor(private pageSize = 1000) {}

  async send(cmd: any): Promise<any> {
    const name = cmd.constructor.name as string; const i = cmd.input; this.calls.push(name);
    switch (name) {
      case "PutObjectCommand": this.objects.set(i.Key, { body: Buffer.from(i.Body), contentType: i.ContentType }); return {};
      case "GetObjectCommand": {
        const o = this.objects.get(i.Key); if (!o) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        return { Body: Object.assign(Readable.from([o.body]), { transformToByteArray: async () => new Uint8Array(o.body) }), ContentLength: o.body.length, ContentType: o.contentType };
      }
      case "HeadObjectCommand": {
        const o = this.objects.get(i.Key); if (!o) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        return { ContentLength: o.body.length };
      }
      case "DeleteObjectCommand": this.objects.delete(i.Key); return {};
      case "DeleteObjectsCommand":
        if (i.Delete.Objects.length > 1000) throw new Error("MalformedXML: more than 1000 keys");
        for (const o of i.Delete.Objects) this.objects.delete(o.Key); return {};
      case "ListObjectsV2Command": {
        const pre: string = i.Prefix ?? ""; const keys = [...this.objects.keys()].filter((k) => k.startsWith(pre)).sort();
        const contents: { Key: string }[] = [];
        for (const k of keys) { const rest = k.slice(pre.length); if (i.Delimiter && rest.includes(i.Delimiter)) continue; contents.push({ Key: k }); }
        const start = i.ContinuationToken ? Number(i.ContinuationToken) : 0;
        const page = contents.slice(start, start + this.pageSize);
        const more = start + this.pageSize < contents.length;
        return { Contents: page, IsTruncated: more, NextContinuationToken: more ? String(start + this.pageSize) : undefined };
      }
      default: throw new Error("FakeS3: unsupported command " + name);
    }
  }
}
