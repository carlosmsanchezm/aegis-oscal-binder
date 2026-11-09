import {it,expect} from "vitest";
import {triageIssue} from "../lib/aegis/issue-actions";
const base={issueId:"issue",receiptId:"receipt",actor:"reviewer-id",at:"2026-10-26T12:00:00Z"};
it.each(["fix-now","plan-it"])("records %s with the server actor, time and reason",outcome=>{const decision=triageIssue({...base,outcome,reason:"Reviewed scope"});expect(decision).toEqual({...base,outcome,reason:"Reviewed scope"});});
it("rejects the removed outcome even with a recorded reason",()=>{for(const outcome of ["accept-risk","accept risk"])expect(()=>triageIssue({...base,outcome,reason:"Reviewed scope"})).toThrow(/outcome/);});
it("requires a reason for supported outcomes and rejects arbitrary outcomes",()=>{expect(()=>triageIssue({...base,outcome:"plan-it",reason:""})).toThrow(/reason/);expect(()=>triageIssue({...base,outcome:"close",reason:"x"})).toThrow(/outcome/);});
