import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
const read=(name:string)=>readFileSync(new URL(`../infra/customer-role/${name}`,import.meta.url),"utf8");
const template=JSON.parse(read("aws/cloudformation.json"));
const role=template.Resources.CustomerRole.Properties;
function evaluate(value:unknown,params:Record<string,string>):unknown {
  if(Array.isArray(value))return value.map(v=>evaluate(v,params));
  if(!value||typeof value!=="object")return value;
  const obj=value as Record<string,unknown>;
  if("Ref" in obj)return params[obj.Ref as string]??obj.Ref;
  if("Fn::Equals" in obj){const values=evaluate(obj["Fn::Equals"],params) as unknown[];return values[0]===values[1];}
  if("Fn::Not" in obj)return !(evaluate(obj["Fn::Not"],params) as boolean[])[0];
  if("Fn::If" in obj){const [condition,yes,no]=obj["Fn::If"] as unknown[];return evaluate(evaluate(template.Conditions[condition as string],params)?yes:no,params);}
  return Object.fromEntries(Object.entries(obj).map(([k,v])=>[k,evaluate(v,params)]));
}
test("CloudFormation requires an explicit principal and ExternalId and emits role reference only",()=>{
  const external=template.Parameters.ExternalId;
  assert.equal(external.NoEcho,true);assert.ok(external.MinLength>=16);assert.equal(external.Default,undefined);
  assert.equal(template.Parameters.AegisPrincipalArn.Default,undefined);
  assert.equal(new RegExp(`^(?:${template.Parameters.AegisPrincipalArn.AllowedPattern})$`).test("*"),false);
  const trust=role.AssumeRolePolicyDocument.Statement[0];
  assert.deepEqual(trust.Principal,{AWS:{Ref:"AegisPrincipalArn"}});
  assert.deepEqual(trust.Condition,{StringEquals:{"sts:ExternalId":{Ref:"ExternalId"}}});
  assert.equal(role.MaxSessionDuration,3600);
  assert.deepEqual(Object.keys(template.Outputs),["RoleArn"]);
  assert.deepEqual(Object.values(template.Resources).map((r:unknown)=>(r as {Type:string}).Type),["AWS::IAM::Role"]);
});
test("CloudFormation write defaults off and enabled writes require an exact instance and one tag key",()=>{
  assert.equal(template.Parameters.EnableWrite.Default,"false");
  assert.equal(evaluate(role.Policies[1],{EnableWrite:"false"}),"AWS::NoValue");
  const rule=template.Rules.WriteRequiresInstance;
  assert.equal(evaluate(rule.RuleCondition,{EnableWrite:"true"}),true);
  assert.equal(evaluate(rule.Assertions[0].Assert,{WriteResourceArn:""}),false);
  assert.equal(evaluate(rule.Assertions[0].Assert,{WriteResourceArn:"arn:aws:ec2:us-east-1:444455556666:instance/i-12345678"}),true);
  const write=evaluate(role.Policies[1],{EnableWrite:"true",WriteResourceArn:"arn:aws:ec2:us-east-1:444455556666:instance/i-12345678"}) as {PolicyDocument:{Statement:{Action:string[];Resource:string;Condition:unknown}[]}};
  assert.deepEqual(write.PolicyDocument.Statement[0].Action,["ec2:CreateTags"]);
  assert.deepEqual(write.PolicyDocument.Statement[0].Condition,{"ForAllValues:StringEquals":{"aws:TagKeys":["aegis:poam-id"]},Null:{"aws:TagKeys":"false"}});
  assert.equal(new RegExp(template.Parameters.WriteResourceArn.AllowedPattern).test("arn:aws:ec2:*:*:instance/*"),false);
});
test("AWS Terraform and CloudFormation deny standing credential creation",()=>{
  const aws=read("aws/main.tf");
  assert.match(aws,/variable "external_id"[\s\S]*sensitive\s*= true/);
  assert.match(aws,/variable "enable_write"\s*\{[\s\S]*?default\s*= false/);
  assert.match(aws,/"sts:ExternalId"\s*= var.external_id/);
  assert.match(aws,/!var.enable_write \|\| length\(var.write_resource_arns\) > 0/);
  const deny=role.Policies[0].PolicyDocument.Statement[0];assert.equal(deny.Effect,"Deny");
  for(const action of ["iam:CreateAccessKey","iam:UpdateAccessKey","iam:CreateServiceSpecificCredential","iam:ResetServiceSpecificCredential"]){assert.ok(deny.Action.includes(action));assert.ok(aws.includes(`"${action}"`));}
  assert.doesNotMatch(aws,/resource "aws_iam_(user|access_key)"/);
});
test("GCP uses an explicit impersonator, no keys, deny-key policies and no default write",()=>{
  const gcp=read("gcp/main.tf");
  assert.match(gcp,/variable "enable_write"\s*\{[\s\S]*?default\s*= false/);
  assert.match(gcp,/role\s*= "roles\/iam.serviceAccountTokenCreator"/);
  assert.match(gcp,/member\s*= "serviceAccount:\$\{var.aegis_service_account_email\}"/);
  assert.match(gcp,/iam.disableServiceAccountKeyCreation/);assert.match(gcp,/iam.disableServiceAccountKeyUpload/);
  assert.match(gcp,/enforce\s*= "TRUE"/);
  assert.match(gcp,/permissions\s*= \["compute.instances.get", "compute.instances.setLabels"\]/);
  assert.match(gcp,/expression\s*= "resource.name in \$\{jsonencode\(var.write_instance_names\)\}"/);
  assert.doesNotMatch(gcp,/resource "google_service_account_key"/);
  assert.deepEqual([...gcp.matchAll(/^output "([^"]+)"/gm)].map(m=>m[1]),["service_account_email","service_account_name"]);
});

test("CloudFormation launcher builds console links without uploading or accepting embedded credentials",async()=>{
  const {customerRoleLaunchUrl}=await import("../scripts/customer-role-launch-url.mjs");
  const link=customerRoleLaunchUrl("https://customer-templates.s3.us-east-1.amazonaws.com/aegis/cloudformation.json","us-east-1");
  assert.equal(new URL(link).hostname,"console.aws.amazon.com");assert.ok(link.includes("/stacks/quickcreate?"));
  assert.equal(new URL(customerRoleLaunchUrl("https://example.invalid/template.json","us-gov-west-1")).hostname,"console.amazonaws-us-gov.com");
  for(const bad of ["http://example.invalid/template.json","https://user:password@example.invalid/template.json","https://example.invalid/template.json?signature=private"]){assert.throws(()=>customerRoleLaunchUrl(bad),/without credentials/);}
});
