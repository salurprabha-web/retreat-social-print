/** Browser-side photo helpers: decode, convert unusual formats, shrink oversized files and upload with progress. */

export class PhotoError extends Error { constructor(public code: string, msg: string) { super(msg); } }

export const FRIENDLY: Record<string, string> = {
  too_large: "That photo is too large. Please choose a smaller one.",
  unsupported_image: "We couldn't read that file. Please choose a JPG, PNG or WebP photo.",
  heic_unsupported: "This photo format isn't supported by your browser. Please pick the photo from your gallery, or set your camera to \"Most Compatible\" (JPG).",
  too_many_uploads: "You've replaced your photo too many times. Please ask event staff for help.",
  session_invalid: "Your session expired. Please start again.", session_required: "Your session expired. Please start again.",
  not_available: "This event is not available right now.", network: "Connection problem. Please check your internet and try again.",
  rate_limited: "Too many requests. Please wait a moment and try again.",
};

const OK_TYPES = ["image/jpeg", "image/png", "image/webp"];

async function decode(blob: Blob): Promise<ImageBitmap> {
  try { return await createImageBitmap(blob); } catch { throw new PhotoError("heic_unsupported", FRIENDLY.heic_unsupported); }
}
function toBlob(c: HTMLCanvasElement, q: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new PhotoError("unsupported_image", FRIENDLY.unsupported_image))), "image/jpeg", q));
}

/**
 * Returns a blob the server will accept. JPEG/PNG/WebP within the limit pass through UNTOUCHED (the original is kept as is).
 * Other formats (e.g. HEIC on Safari) are decoded and saved as high-quality JPEG; oversized photos are re-encoded just enough to fit.
 */
export async function prepare(file: Blob, maxBytes: number): Promise<Blob> {
  if (OK_TYPES.includes(file.type) && file.size <= maxBytes) return file;
  const bmp = await decode(file);
  try {
    for (const [maxDim, q] of [[Infinity, 0.95], [4800, 0.92], [4000, 0.88], [3200, 0.85], [2400, 0.8]] as const) {
      const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
      const b = await toBlob(c, q);
      if (b.size <= maxBytes) return b;
    }
  } finally { bmp.close(); }
  throw new PhotoError("too_large", FRIENDLY.too_large);
}

export interface UploadResult { uploadId: string; width: number; height: number; lowResolution: boolean }

export function uploadPhoto(token: string, sessionId: string, blob: Blob, onProgress: (pct: number) => void, slot = 1): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/api/v1/public/g/${token}/photo?slot=${slot}`);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.setRequestHeader("x-guest-session", sessionId);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    x.onerror = () => reject(new PhotoError("network", FRIENDLY.network));
    x.ontimeout = x.onerror; x.timeout = 120000;
    x.onload = () => {
      let body: any = {}; try { body = JSON.parse(x.responseText); } catch { /* ignore */ }
      if (x.status >= 200 && x.status < 300) return resolve(body as UploadResult);
      const code = x.status === 429 && !body.error?.startsWith("too_many") ? "rate_limited" : body.error ?? "network";
      reject(new PhotoError(code, FRIENDLY[code] ?? "Upload failed. Please try again."));
    };
    x.send(blob);
  });
}
