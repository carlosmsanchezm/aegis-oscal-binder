# SYNTHETIC deliberate gaps. Templates only: no live apply was performed.
provider "aws" {
  alias               = "commercial"
  region              = var.commercial_region
  allowed_account_ids = [var.commercial_account_id]
  default_tags {
    tags = { SyntheticDemo = "true", Purpose = var.demo_label }
  }
}
provider "aws" {
  alias               = "govcloud"
  region              = var.govcloud_region
  allowed_account_ids = [var.govcloud_account_id]
  default_tags {
    tags = { SyntheticDemo = "true", Purpose = var.demo_label }
  }
}
module "commercial" {
  source    = "./modules/gaps"
  providers = { aws = aws.commercial }
  label     = "${var.demo_label}-commercial"
}
module "govcloud" {
  source    = "./modules/gaps"
  providers = { aws = aws.govcloud }
  label     = "${var.demo_label}-govcloud"
}
