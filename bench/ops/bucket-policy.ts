// The export bucket's policy for the MinIO test (#309), built from the
// statements of ops/terraform/bucket.tf so the two cannot drift: the test
// fails when a statement id it relies on is missing there.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const TF = join(import.meta.dir, "../../ops/terraform/bucket.tf");

/** The `Sid`s of the bucket policy in bucket.tf. */
export function terraformSids(): string[] {
  const text = readFileSync(TF, "utf8");
  return [...text.matchAll(/Sid\s*=\s*"([A-Za-z]+)"/gu)].map((m) => m[1] as string);
}

/**
 * The policy MinIO gets: `DenyUnencryptedPut` with the condition of
 * bucket.tf, and an anonymous `PutObject` allow so the test can send
 * unsigned puts (MinIO's root user bypasses bucket policies, so the deny is
 * proved on the principal it applies to). `DenyInsecureTransport` is left
 * out (the MinIO of CI is plain HTTP) and `DenyOtherKmsKey` too (MinIO's
 * static KMS key has its own id); both are AWS-side.
 */
export function minioPolicy(bucket: string): string {
  const sids = terraformSids();
  if (!sids.includes("DenyUnencryptedPut")) throw new Error("ops/terraform/bucket.tf has no DenyUnencryptedPut statement");
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "AnonymousPutForTheTest", Effect: "Allow", Principal: { AWS: ["*"] }, Action: ["s3:PutObject"], Resource: [`arn:aws:s3:::${bucket}/*`] },
      {
        Sid: "DenyUnencryptedPut",
        Effect: "Deny",
        Principal: { AWS: ["*"] },
        Action: ["s3:PutObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
        Condition: { StringNotEquals: { "s3:x-amz-server-side-encryption": "aws:kms" } },
      },
    ],
  });
}
