# Not applied by this repository. An operator applies it in GovCloud account 111122223333.
# Confirm the GitHub OIDC thumbprints for aws-us-gov before apply. The values below
# are the commonly published GitHub thumbprints and are unverified for GovCloud.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region            = "us-gov-west-1"
  use_fips_endpoint = true
}

variable "govcloud_account_id" {
  type    = string
  default = "111122223333"
  validation {
    condition     = var.govcloud_account_id == "111122223333"
    error_message = "This role is only for GovCloud account 111122223333."
  }
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

resource "aws_iam_role" "reader" {
  name                 = "aegis-evidence-reader"
  max_session_duration = 3600
  assume_role_policy   = file("${path.module}/trust.json")
  tags = {
    purpose = "evidence-reader"
  }
}

resource "aws_iam_role_policy" "inline" {
  name   = "aegis-evidence-reader"
  role   = aws_iam_role.reader.id
  policy = file("${path.module}/policy.json")
}

resource "aws_iam_role_policy_attachment" "security_audit" {
  role       = aws_iam_role.reader.name
  policy_arn = "arn:aws-us-gov:iam::aws:policy/SecurityAudit"
}

resource "aws_iam_role_policy_attachment" "view_only" {
  role       = aws_iam_role.reader.name
  policy_arn = "arn:aws-us-gov:iam::aws:policy/job-function/ViewOnlyAccess"
}
