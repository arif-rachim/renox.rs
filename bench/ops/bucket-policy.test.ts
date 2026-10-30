// #309: the export bucket refuses an unencrypted put and accepts an SSE-KMS
// one (docs/24-threat-model.md G, "Tenant files or backups read from
// storage"; ops/terraform/bucket.tf `DenyUnencryptedPut`). Runs against
// MinIO with a static KMS key (.github/workflows/ops.yml):
//   RENOX_TEST_S3_ENDPOINT=http://127.0.0.1:9000 RENOX_TEST_S3_KEY=… RENOX_TEST_S3_SECRET=…
//   RENOX_TEST_S3_KMS_KEY=renox-ci-key bun test bench/ops
// Without RENOX_TEST_S3_ENDPOINT the MinIO test is skipped; in CI that is an error.

import { describe, expect, test } from "bun:test";
import { minioPolicy, terraformSids } from "./bucket-policy.ts";
import { s3, type S3Endpoint } from "./s3.ts";

const endpoint = process.env.RENOX_TEST_S3_ENDPOINT;
const kmsKey = process.env.RENOX_TEST_S3_KMS_KEY ?? "renox-ci-key";

describe("ops/terraform/bucket.tf", () => {
  test("the policy refuses unencrypted puts, other keys, and plain HTTP", () => {
    expect(terraformSids()).toEqual(["DenyUnencryptedPut", "DenyOtherKmsKey", "DenyInsecureTransport"]);
  });

  test("CI runs the MinIO test", () => {
    if (process.env.CI !== undefined && process.env.RENOX_OPS_CI !== undefined) expect(endpoint).toBeDefined();
  });
});

describe.skipIf(endpoint === undefined)("the export bucket on MinIO", () => {
  const e: S3Endpoint = {
    endpoint: endpoint ?? "",
    region: process.env.RENOX_TEST_S3_REGION ?? "us-east-1",
    accessKeyId: process.env.RENOX_TEST_S3_KEY ?? "",
    secretAccessKey: process.env.RENOX_TEST_S3_SECRET ?? "",
  };
  const bucket = `renox-exports-test-${Date.now()}`;

  test("an unencrypted put is refused, an SSE-KMS put succeeds", async () => {
    const made = await s3(e, e.endpoint, "PUT", `/${bucket}`, "", "");
    expect(made.status, await made.text()).toBe(200);
    const policy = await s3(e, e.endpoint, "PUT", `/${bucket}`, "policy", minioPolicy(bucket), { "content-type": "application/json" });
    expect(policy.status, await policy.text()).toBeLessThan(300);

    const plain = await s3(null, e.endpoint, "PUT", `/${bucket}/exports/t_a/t_a/1.db`, "", "SQLite format 3\u0000");
    expect(plain.status).toBe(403);
    await plain.text();

    const sealed = await s3(null, e.endpoint, "PUT", `/${bucket}/exports/t_a/t_a/2.db`, "", "SQLite format 3\u0000", {
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": kmsKey,
    });
    expect(sealed.status, await sealed.text()).toBe(200);
    expect(sealed.headers.get("x-amz-server-side-encryption")).toBe("aws:kms");
  });
});
