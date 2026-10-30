output "backup_kms_key_arn" {
  description = "[replication] sse_kms_key_id of worker.toml."
  value       = aws_kms_key.backup.arn
}

output "export_kms_key_arn" {
  description = "EXPORT_KMS_KEY_ID of the control API."
  value       = aws_kms_key.export.arn
}

output "export_bucket" {
  description = "The control API's object store bucket for exports."
  value       = aws_s3_bucket.export.bucket
}
