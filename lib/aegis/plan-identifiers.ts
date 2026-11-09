import type {PlanProposal} from "./plan-proposal";
async function uuid(name: string): Promise<string> {
  const namespace = Uint8Array.from("6ba7b8119dad11d180b400c04fd430c8".match(/../g)!, byte=>parseInt(byte,16));
  const text = new TextEncoder().encode(name), input = new Uint8Array(namespace.length+text.length);
  input.set(namespace); input.set(text,namespace.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1",input)).slice(0,16);
  bytes[6]=(bytes[6]&15)|80; bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function planIdentifiers(plan: PlanProposal) {
  const result=plan.result;
  const identity=JSON.stringify([plan.controlId.toLowerCase(),result?.asset,result?.sourceReleaseUrl,result?.sourceReleaseSha256,result?.reviewItemId??result?.finding]);
  const [finding,observation,risk]=await Promise.all([uuid(`binder-ar:${identity}:finding`),uuid(`binder-ar:${identity}:observation`),uuid(`binder-poam:${identity}:risk`)]);
  return {finding,observation,risk};
}
