import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";

/**
 * In-memory stand-in for the part of the S3 client the platform uses. It mimics the real behaviours the code depends on:
 * a missing key raises NoSuchKey (Head: NotFound, status 404), listing is paginated and honours Prefix/Delimiter, deletes are idempotent.
 * It proves OUR logic. It does not prove the behaviour of a real R2 bucket; that is checked on the real deployment.
 */
export class FakeS3 extends S3Client {
  objects = new Map<string, { body: Buffer; contentType?: string }>();
  calls: string[] = [];
  /** Simulates a store that refuses the batch delete call. */
  refuseBatchDelete = false;
  uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  // A real client configuration (the multipart uploader and the presigner read it); only `send` is replaced, so nothing touches a network.
  constructor(private pageSize = 1000) { super({ region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com", credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" } }); }

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
      case "CreateMultipartUploadCommand": { const id = "mp" + this.uploads.size + "-" + Date.now(); this.uploads.set(id, { key: i.Key, parts: new Map() }); return { UploadId: id }; }
      case "UploadPartCommand": {
        const u = this.uploads.get(i.UploadId); if (!u) throw Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" });
        u.parts.set(i.PartNumber, Buffer.from(i.Body)); return { ETag: '"part' + i.PartNumber + '"' };
      }
      case "CompleteMultipartUploadCommand": {
        const u = this.uploads.get(i.UploadId); if (!u) throw Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" });
        const order = (i.MultipartUpload.Parts as { PartNumber: number }[]).map((p) => p.PartNumber);
        this.objects.set(u.key, { body: Buffer.concat(order.map((n) => u.parts.get(n)!)) }); this.uploads.delete(i.UploadId); return {};
      }
      case "AbortMultipartUploadCommand": this.uploads.delete(i.UploadId); return {};
      case "CopyObjectCommand": {
        const src = decodeURIComponent(String(i.CopySource)); const key = src.slice(src.indexOf("/") + 1);
        const o = this.objects.get(key); if (!o) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        this.objects.set(i.Key, { body: Buffer.from(o.body), contentType: o.contentType }); return {};
      }
      case "DeleteObjectCommand": this.objects.delete(i.Key); return {};
      case "DeleteObjectsCommand":
        if (this.refuseBatchDelete) throw Object.assign(new Error("Missing required header for this request: Content-Md5."), { name: "InvalidRequest" });
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
