# ops/terraform

The cloud resources that hold the platform's keys and exports (#309): one KMS key per purpose with rotation on (`kms.tf`), and the export bucket, private, versioned, with exports expiring after 7 days and a policy that refuses any `PutObject` that is not SSE-KMS with the export key (`bucket.tf`). What each key protects and how it is rotated: `ops/security/keys.md`. Code-owner review for every change (`ops/`).

## Use

The backend (state storage) is the owner's: add a `backend.tf` next to these files (for example an S3 backend in the same account with its own KMS key), or keep local state for a first run.

```sh
cd ops/terraform
tofu init
tofu plan -var control_api_role_arn=arn:aws:iam::<acct>:role/renox-control-api \
          -var worker_role_arn=arn:aws:iam::<acct>:role/renox-worker \
          -var restore_role_arn=arn:aws:iam::<acct>:role/renox-restore
tofu apply …            # the same variables; owner step
```

The outputs go to configuration: `backup_kms_key_arn` to `[replication] sse_kms_key_id` of each `worker.toml`, `export_kms_key_arn` to the control API's `EXPORT_KMS_KEY_ID`, `export_bucket` to its object store bucket.

## CI

`.github/workflows/ops.yml` on changes under `ops/terraform/**` or `bench/ops/**`: `tofu fmt -check -recursive`, `tofu init -backend=false`, `tofu validate`, and `bench/ops/bucket-policy.test.ts` against MinIO with the same policy conditions (an unencrypted put is refused, a put with SSE-KMS succeeds). MinIO stands in for S3: its SSE-KMS uses a static key (`MINIO_KMS_SECRET_KEY`), not AWS KMS.
