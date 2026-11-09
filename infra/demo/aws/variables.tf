variable "commercial_account_id" {
  type        = string
  description = "Dedicated synthetic sandbox account. Never a production/customer account."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.commercial_account_id))
    error_message = "Supply the dedicated 12-digit commercial sandbox account ID."
  }
}
variable "govcloud_account_id" {
  type        = string
  description = "Dedicated synthetic GovCloud sandbox account."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.govcloud_account_id))
    error_message = "Supply the dedicated 12-digit GovCloud sandbox account ID."
  }
}
variable "commercial_region" {
  type    = string
  default = "us-east-1"
  validation {
    condition     = contains(["us-east-1", "us-east-2", "us-west-1", "us-west-2"], var.commercial_region)
    error_message = "Use a US commercial sandbox region."
  }
}
variable "govcloud_region" {
  type    = string
  default = "us-gov-west-1"
  validation {
    condition     = contains(["us-gov-west-1", "us-gov-east-1"], var.govcloud_region)
    error_message = "Use a GovCloud sandbox region."
  }
}
variable "demo_label" {
  type    = string
  default = "aegis-synthetic-phase4"
  validation {
    condition     = can(regex("^aegis-synthetic-[a-z0-9-]{1,25}$", var.demo_label))
    error_message = "Retain the aegis-synthetic prefix."
  }
}
