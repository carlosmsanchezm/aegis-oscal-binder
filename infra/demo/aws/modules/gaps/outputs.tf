output "versioning_status" {
  value = aws_s3_bucket_versioning.synthetic.versioning_configuration[0].status
}
output "ssh_cidrs" {
  value = flatten([for rule in aws_security_group.synthetic.ingress : rule.cidr_blocks])
}
