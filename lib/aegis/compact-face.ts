import {faceLines,manropeWidth} from "./map-layout";

const words:Record<string,string>={configuration:"Config",management:"Mgmt",enforcement:"Enforce",confidentiality:"Confid.",remediation:"Remediate",authentication:"Auth",identification:"Identify",information:"Info",authorization:"Authz",assessment:"Assess",development:"Develop",maintenance:"Maintain",organization:"Org",organizational:"Org",protection:"Protect",communication:"Comms",reconstitution:"Restore",communications:"Comms",accountability:"Account"};
/** Short faces keep the full catalog title in the accessible label and details. */
export function compactFaceLines(id:string,title:string,width:number):[string,string]{
  const lines=faceLines(id,title).map(line=>line.split(/\s+/).map(word=>words[word.toLowerCase()]??word).join(" "));
  const fit=(line:string)=>{
    if(manropeWidth(line,9,400)<=width-12)return line;
    const parts=line.split(" ").filter(word=>! /^(and|of|the|for|&)$/i.test(word));
    let label=parts[0]??line;
    if(manropeWidth(label,9,400)<=width-12)return label;
    while(label.length>2&&manropeWidth(`${label}.`,9,400)>width-12)label=label.slice(0,-1);
    return `${label}.`;
  };
  return [fit(lines[0]),fit(lines[1])];
}
