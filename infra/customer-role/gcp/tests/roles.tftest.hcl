mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "444455556666" }
  }
}
variables {
  project_id                  = "customer-example"
  aegis_service_account_email = "aegis-broker@aegis-example.iam.gserviceaccount.com"
}
run "read_only_default" {
  command = plan
  assert {
    condition     = length(google_project_iam_member.write) == 0 && length(google_project_iam_custom_role.write) == 0
    error_message = "Default must not grant write."
  }
  assert {
    condition     = length(google_org_policy_policy.deny_standing_keys) == 2 && google_service_account_iam_member.aegis_impersonator.role == "roles/iam.serviceAccountTokenCreator"
    error_message = "Deny key creation/upload and use scoped impersonation."
  }
}
run "wildcard_principal_refused" {
  command = plan
  variables { aegis_service_account_email = "*" }
  expect_failures = [var.aegis_service_account_email]
}
run "write_requires_instances" {
  command = plan
  variables { enable_write = true }
  expect_failures = [google_service_account.customer]
}
run "wrong_project_refused" {
  command = plan
  variables { write_instance_names = ["projects/another-project/zones/us-central1-a/instances/example"] }
  expect_failures = [var.write_instance_names]
}
run "narrow_opt_in" {
  command = plan
  variables {
    enable_write         = true
    write_instance_names = ["projects/customer-example/zones/us-central1-a/instances/example"]
  }
  assert {
    condition     = google_project_iam_member.write[0].condition[0].expression == "resource.name in [\"projects/customer-example/zones/us-central1-a/instances/example\"]"
    error_message = "Write opt-in must bind exact customer instances."
  }
}
