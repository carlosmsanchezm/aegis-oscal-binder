# GovCloud evidence reader role

This role is not applied by the repository. An operator applies it later in account `111122223333`, partition `aws-us-gov`.

The inline policy denies mutating actions, credential minting, and data reads. `SecurityAudit` and `ViewOnlyAccess` are the modeled read grants. `iam:GenerateCredentialReport` and `sts:GetCallerIdentity` are allowed explicitly. Requests outside `us-gov-west-1` and `us-gov-east-1` are denied for services other than IAM, STS, SSO, and Identity Store.

Trust is GitHub Actions OIDC for `repo:carlosmsanchezm/aegis-oscal-binder:ref:refs/heads/main` with audience `sts.amazonaws.com`, plus an Identity Center principal matching `AWSReservedSSO_AegisReader_*`. The OIDC thumbprints in `main.tf` are the commonly published GitHub values. They are unverified for GovCloud. Confirm them before apply.

Do not run `terraform apply` from this checkout.
