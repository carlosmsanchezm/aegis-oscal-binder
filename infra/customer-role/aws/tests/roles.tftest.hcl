mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
}
variables {
  aegis_principal_arn = "arn:aws:iam::111122223333:role/AegisBroker"
  external_id         = "customer-specific-example-identifier"
}
run "read_only_default" {
  command = plan
  assert {
    condition     = length(aws_iam_role_policy.write) == 0
    error_message = "Default must not grant write."
  }
  assert {
    condition     = length(aws_iam_role_policy_attachment.read_only) == 2 && aws_iam_role.customer.max_session_duration == 3600
    error_message = "Read policies and one-hour role maximum are required."
  }
}
run "external_id_required" {
  command = plan
  variables { external_id = "" }
  expect_failures = [var.external_id]
}
run "wildcard_principal_refused" {
  command = plan
  variables { aegis_principal_arn = "*" }
  expect_failures = [var.aegis_principal_arn]
}
run "write_requires_instances" {
  command = plan
  variables { enable_write = true }
  expect_failures = [aws_iam_role.customer]
}
run "narrow_opt_in" {
  command = plan
  variables {
    enable_write        = true
    write_resource_arns = ["arn:aws:ec2:us-east-1:444455556666:instance/i-1234567890abcdef0"]
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.write[0].policy).Statement[0].Action == ["ec2:CreateTags"]
    error_message = "Write opt-in must stay limited to instance tags."
  }
}
