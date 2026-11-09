terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
variable "label" {
  type = string
  validation {
    condition     = startswith(var.label, "aegis-synthetic-")
    error_message = "Dedicated synthetic sandbox resources only."
  }
}
resource "aws_vpc" "synthetic" {
  cidr_block           = "10.247.0.0/24"
  enable_dns_support   = false
  enable_dns_hostnames = false
  tags                 = { Name = var.label, SyntheticDemo = "true" }
}
# No instances, routes, gateways, principals, keys or real data are provisioned.
