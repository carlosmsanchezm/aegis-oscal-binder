terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
  }
}

variable "role_name" {
  type        = string
  default     = "AegisCustomerReader"
  description = "Customer role name. No user or access key is created."
  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.role_name))
    error_message = "Use a valid IAM role name."
  }
}
variable "aegis_principal_arn" {
  type        = string
  description = "Explicit Aegis IAM role ARN; a whole-account or wildcard principal is not accepted."
  validation {
    condition     = can(regex("^arn:aws(-us-gov|-cn)?:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", var.aegis_principal_arn))
    error_message = "Provide an explicit trusted IAM role ARN."
  }
}
variable "external_id" {
  type        = string
  sensitive   = true
  description = "Required unique customer ExternalId agreed with the operator. Never output."
  validation {
    condition     = length(var.external_id) >= 16 && length(var.external_id) <= 1224 && can(regex("^[A-Za-z0-9+=,.@:/_-]+$", var.external_id))
    error_message = "ExternalId is required and must be 16 to 1224 valid characters."
  }
}
variable "enable_write" {
  type        = bool
  default     = false
  description = "Explicitly opt in to tagging only the listed EC2 instances with aegis:poam-id. No remediation broker is provided."
}
variable "write_resource_arns" {
  type        = list(string)
  default     = []
  description = "Exact EC2 instance ARNs for optional tag writes. No wildcards."
  validation {
    condition     = alltrue([for arn in var.write_resource_arns : can(regex("^arn:aws(-us-gov|-cn)?:ec2:[a-z0-9-]+:[0-9]{12}:instance/i-[a-f0-9]+$", arn))])
    error_message = "Write resources must be exact EC2 instance ARNs."
  }
}

data "aws_partition" "current" {}
resource "aws_iam_role" "customer" {
  name                 = var.role_name
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = var.aegis_principal_arn }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "sts:ExternalId" = var.external_id } }
    }]
  })
  lifecycle {
    precondition {
      condition     = !var.enable_write || length(var.write_resource_arns) > 0
      error_message = "Explicit instance ARNs are required when enabling writes."
    }
    precondition {
      condition     = startswith(var.aegis_principal_arn, "arn:${data.aws_partition.current.partition}:") && alltrue([for arn in var.write_resource_arns : startswith(arn, "arn:${data.aws_partition.current.partition}:")])
      error_message = "Principal and resource ARNs must use the provider partition."
    }
  }
}
resource "aws_iam_role_policy_attachment" "read_only" {
  for_each   = toset(["SecurityAudit", "job-function/ViewOnlyAccess"])
  role       = aws_iam_role.customer.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/${each.value}"
}
resource "aws_iam_role_policy" "deny_standing_credentials" {
  name = "DenyStandingCredentials"
  role = aws_iam_role.customer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Deny"
      Action   = ["iam:CreateAccessKey", "iam:UpdateAccessKey", "iam:CreateServiceSpecificCredential", "iam:ResetServiceSpecificCredential"]
      Resource = "*"
    }]
  })
}
resource "aws_iam_role_policy" "write" {
  count = var.enable_write ? 1 : 0
  name  = "OptionalPoamReferenceTag"
  role  = aws_iam_role.customer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ec2:CreateTags"]
      Resource = var.write_resource_arns
      Condition = {
        "ForAllValues:StringEquals" = { "aws:TagKeys" = ["aegis:poam-id"] }
        "Null"                      = { "aws:TagKeys" = "false" }
      }
    }]
  })
}
output "role_arn" {
  value       = aws_iam_role.customer.arn
  description = "Role reference only. No STS credentials or access keys are output."
}
