resource "aws_s3_bucket" "synthetic" {
  bucket_prefix = "${var.label}-"
  force_destroy = false
  tags          = { SyntheticDemo = "true" }
}
resource "aws_s3_bucket_public_access_block" "synthetic" {
  bucket                  = aws_s3_bucket.synthetic.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
# DEMO-IAC-01: version history is deliberately disabled. No evidence/data is stored.
resource "aws_s3_bucket_versioning" "synthetic" {
  bucket = aws_s3_bucket.synthetic.id
  versioning_configuration {
    status = "Suspended"
  }
}
