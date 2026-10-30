variable "region" {
  description = "The UAE region tenant data stays in (docs/21-uae-gcc-strategy.md)."
  type        = string
  default     = "me-central-1"
}

variable "name_prefix" {
  description = "Prefix of every resource name, e.g. renox-prod."
  type        = string
  default     = "renox"
}

variable "control_api_role_arn" {
  description = "IAM role of the control API: encrypts exports, reads and deletes them."
  type        = string
}

variable "worker_role_arn" {
  description = "IAM role of the worker nodes: encrypts and decrypts Litestream replicas."
  type        = string
}

variable "restore_role_arn" {
  description = "IAM role of the restore runbook: decrypts replicas."
  type        = string
}

variable "export_expiry_days" {
  description = "Exports and their noncurrent versions are deleted after this many days."
  type        = number
  default     = 7
}
