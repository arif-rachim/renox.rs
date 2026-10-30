# One KMS key per purpose, automatic yearly rotation on (ops/security/keys.md).
data "aws_caller_identity" "current" {}

locals {
  account_root = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
}

resource "aws_kms_key" "backup" {
  description             = "Litestream replicas of tenant databases (SSE-KMS)"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Admin", Effect = "Allow", Principal = { AWS = local.account_root }, Action = "kms:*", Resource = "*" },
      {
        Sid       = "Workers"
        Effect    = "Allow"
        Principal = { AWS = var.worker_role_arn }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
      },
      {
        Sid       = "Restore"
        Effect    = "Allow"
        Principal = { AWS = var.restore_role_arn }
        Action    = ["kms:Decrypt", "kms:DescribeKey"]
        Resource  = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "backup" {
  name          = "alias/${var.name_prefix}-backup"
  target_key_id = aws_kms_key.backup.key_id
}

resource "aws_kms_key" "export" {
  description             = "Tenant database exports in the export bucket (SSE-KMS)"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Admin", Effect = "Allow", Principal = { AWS = local.account_root }, Action = "kms:*", Resource = "*" },
      {
        Sid       = "ControlApi"
        Effect    = "Allow"
        Principal = { AWS = var.control_api_role_arn }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "export" {
  name          = "alias/${var.name_prefix}-export"
  target_key_id = aws_kms_key.export.key_id
}
