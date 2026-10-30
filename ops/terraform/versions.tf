# OpenTofu (or Terraform) and the AWS provider (#309). The backend is the
# owner's choice (README.md): this module has none, so `tofu init
# -backend=false` and `tofu validate` work without credentials in CI.
terraform {
  required_version = ">= 1.8.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

provider "aws" {
  region = var.region
}
