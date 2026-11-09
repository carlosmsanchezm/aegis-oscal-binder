terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0, < 8.0"
    }
  }
}
variable "project_id" {
  type        = string
  description = "Customer project. The installer needs IAM and Organization Policy administration."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Provide a valid customer project id."
  }
}
variable "account_id" {
  type        = string
  default     = "aegis-customer-reader"
  description = "Service account to impersonate; the module never creates a service account key."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.account_id))
    error_message = "Use a service account id of 6 to 30 characters."
  }
}
variable "aegis_service_account_email" {
  type        = string
  description = "Explicit trusted Aegis service account email. No user, group or wildcard principal."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\\.iam\\.gserviceaccount\\.com$", var.aegis_service_account_email))
    error_message = "Provide an explicit Aegis service account email."
  }
}
variable "enable_write" {
  type        = bool
  default     = false
  description = "Explicitly allow label changes only on listed instances; no credential Broker is included."
}
variable "write_instance_names" {
  type        = list(string)
  default     = []
  description = "Exact customer instance resource names, projects/PROJECT/zones/ZONE/instances/NAME."
  validation {
    condition     = alltrue([for name in var.write_instance_names : can(regex("^projects/${var.project_id}/zones/[a-z0-9-]+/instances/[a-z0-9-]+$", name))])
    error_message = "Use exact instance names in this customer project; no wildcards."
  }
}

data "google_project" "customer" {
  project_id = var.project_id
}
resource "google_service_account" "customer" {
  project      = var.project_id
  account_id   = var.account_id
  display_name = "Aegis customer evidence reader"
  lifecycle {
    precondition {
      condition     = !var.enable_write || length(var.write_instance_names) > 0
      error_message = "Explicit instance names are required when enabling writes."
    }
  }
}
resource "google_service_account_iam_member" "aegis_impersonator" {
  service_account_id = google_service_account.customer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.aegis_service_account_email}"
}
resource "google_project_iam_member" "read_only" {
  for_each = toset(["roles/iam.securityReviewer", "roles/browser"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.customer.email}"
}
# These project-wide guardrails deliberately prohibit key creation AND upload.
# Import already-managed policies instead of managing them from two modules.
resource "google_org_policy_policy" "deny_standing_keys" {
  for_each = toset(["iam.disableServiceAccountKeyCreation", "iam.disableServiceAccountKeyUpload"])
  parent   = "projects/${data.google_project.customer.number}"
  name     = "projects/${data.google_project.customer.number}/policies/${each.value}"
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}
resource "google_project_iam_custom_role" "write" {
  count       = var.enable_write ? 1 : 0
  project     = var.project_id
  role_id     = "aegisInstanceLabelWriter"
  title       = "Aegis scoped instance labels"
  permissions = ["compute.instances.get", "compute.instances.setLabels"]
}
resource "google_project_iam_member" "write" {
  count   = var.enable_write ? 1 : 0
  project = var.project_id
  role    = google_project_iam_custom_role.write[0].name
  member  = "serviceAccount:${google_service_account.customer.email}"
  condition {
    title      = "ExactCustomerInstances"
    expression = "resource.name in ${jsonencode(var.write_instance_names)}"
  }
}
output "service_account_email" {
  value       = google_service_account.customer.email
  description = "Impersonation target only; no private key or bearer credential is returned."
}
output "service_account_name" {
  value       = google_service_account.customer.name
  description = "Resource name for the IAM Credentials API; request short-lived access tokens externally."
}
