# The export bucket (docs/contracts/deploy-api.md section 14): private,
# versioned, exports expire, and every put must be SSE-KMS with the export
# key. bench/ops/bucket-policy.test.ts proves the same conditions against
# MinIO in CI (an unencrypted put is refused, an SSE-KMS put succeeds).
resource "aws_s3_bucket" "export" {
  bucket = "${var.name_prefix}-exports-${var.region}"
}

resource "aws_s3_bucket_public_access_block" "export" {
  bucket                  = aws_s3_bucket.export.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "export" {
  bucket = aws_s3_bucket.export.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "export" {
  bucket = aws_s3_bucket.export.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "export" {
  bucket = aws_s3_bucket.export.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.export.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "export" {
  bucket = aws_s3_bucket.export.id
  rule {
    id     = "expire-exports"
    status = "Enabled"
    filter {
      prefix = "exports/"
    }
    expiration {
      days = var.export_expiry_days
    }
    noncurrent_version_expiration {
      noncurrent_days = var.export_expiry_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# The conditions are the ones bench/ops/bucket-policy.ts applies to MinIO;
# keep the two in step (the test reads the statement ids from this file).
resource "aws_s3_bucket_policy" "export" {
  bucket = aws_s3_bucket.export.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyUnencryptedPut"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.export.arn}/*"
        Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" } }
      },
      {
        Sid       = "DenyOtherKmsKey"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.export.arn}/*"
        Condition = { StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.export.arn } }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.export.arn, "${aws_s3_bucket.export.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.export]
}
