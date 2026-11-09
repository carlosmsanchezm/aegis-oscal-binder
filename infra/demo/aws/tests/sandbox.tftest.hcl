mock_provider "aws" {
  alias = "commercial"
}
mock_provider "aws" {
  alias = "govcloud"
}
run "synthetic_sandbox_plan" {
  command = plan
  variables {
    commercial_account_id = "111111111111"
    govcloud_account_id   = "222222222222"
  }
  assert {
    condition     = contains(module.commercial.ssh_cidrs, "0.0.0.0/0") && contains(module.govcloud.ssh_cidrs, "0.0.0.0/0")
    error_message = "Both partitions must retain the documented isolated SSH gap."
  }
  assert {
    condition     = module.commercial.versioning_status == "Suspended" && module.govcloud.versioning_status == "Suspended"
    error_message = "Both partitions must retain the documented synthetic versioning gap."
  }
}

run "wrong_sandbox_id_refused" {
  command = plan
  variables {
    commercial_account_id = "not-an-account"
    govcloud_account_id   = "222222222222"
  }
  expect_failures = [var.commercial_account_id]
}
run "wrong_govcloud_region_refused" {
  command = plan
  variables {
    commercial_account_id = "111111111111"
    govcloud_account_id   = "222222222222"
    govcloud_region       = "us-east-1"
  }
  expect_failures = [var.govcloud_region]
}
