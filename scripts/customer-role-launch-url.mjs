import {pathToFileURL} from "node:url";
export function customerRoleLaunchUrl(templateUrl,region="us-east-1") {
  const template=new URL(templateUrl);
  if(template.protocol!=="https:"||template.username||template.password||template.search||template.hash)throw new Error("Use an HTTPS template URL without credentials, query or fragment.");
  if(!/^(?:us-gov-(?:east|west)|[a-z]{2}-(?:east|west|central|north|south|northeast|northwest|southeast|southwest))-[1-9]$/.test(region))throw new Error("Use a supported AWS region.");
  const host=region.startsWith("us-gov-")?"console.amazonaws-us-gov.com":"console.aws.amazon.com";
  const query=new URLSearchParams({templateURL:template.toString(),stackName:"AegisCustomerReader"});
  return `https://${host}/cloudformation/home?region=${encodeURIComponent(region)}#/stacks/quickcreate?${query}`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{process.stdout.write(customerRoleLaunchUrl(process.argv[2],process.argv[3])+"\n");}
  catch{process.stderr.write("Provide an HTTPS template URL without credentials and a supported AWS region.\n");process.exitCode=1;}
}
