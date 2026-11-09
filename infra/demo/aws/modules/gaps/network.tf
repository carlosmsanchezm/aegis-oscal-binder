# DEMO-IAC-02: deliberate world-open SSH rule in an isolated VPC with no workloads.
resource "aws_security_group" "synthetic" {
  name_prefix = "${var.label}-"
  description = "SYNTHETIC deliberate gap; no instances or internet gateway"
  vpc_id      = aws_vpc.synthetic.id
  ingress {
    description = "DEMO-IAC-02 deliberate gap"
    protocol    = "tcp"
    from_port   = 22
    to_port     = 22
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { SyntheticDemo = "true" }
}
