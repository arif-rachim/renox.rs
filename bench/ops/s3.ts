// A minimal S3 client for the bucket-policy test (#309): AWS Signature
// Version 4 for the few calls the test makes (create a bucket, put its
// policy, put an object with or without SSE-KMS). Bun's S3Client has no
// server-side encryption options and no bucket policy call.

const enc = new TextEncoder();

async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export interface S3Endpoint {
  /** `http://127.0.0.1:9000` */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Path-style request; `credentials` null sends it unsigned (anonymous). */
export async function s3(
  e: S3Endpoint | null,
  base: string,
  method: string,
  path: string,
  query: string,
  body: Uint8Array<ArrayBuffer> | string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = new URL(`${base}${path}${query === "" ? "" : `?${query}`}`);
  const bytes = typeof body === "string" ? enc.encode(body) : body;
  const h: Record<string, string> = { ...headers };
  if (e !== null) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
    const day = amzDate.slice(0, 8);
    const payload = await sha256Hex(bytes);
    h["x-amz-date"] = amzDate;
    h["x-amz-content-sha256"] = payload;
    h.host = url.host;
    const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
    const lower: Record<string, string> = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v.trim()]));
    const canonicalQuery = query
      .split("&")
      .filter((p) => p !== "")
      .map((p) => (p.includes("=") ? p : `${p}=`))
      .sort()
      .join("&");
    const canonical = [method, url.pathname, canonicalQuery, ...names.map((n) => `${n}:${lower[n]}`), "", names.join(";"), payload].join("\n");
    const scope = `${day}/${e.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
    let key = await hmac(enc.encode(`AWS4${e.secretAccessKey}`), day);
    for (const part of [e.region, "s3", "aws4_request"]) key = await hmac(key, part);
    const signature = hex(await hmac(key, toSign));
    h.authorization = `AWS4-HMAC-SHA256 Credential=${e.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    delete h.host;
  }
  return fetch(url, { method, headers: h, body: method === "GET" || method === "HEAD" ? undefined : bytes });
}
