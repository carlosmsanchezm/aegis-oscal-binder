import {it,expect} from "vitest";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {readFileSync} from "node:fs";
import {RollupMap} from "../components/binder/RollupMap";
import {pkg,records,proposalCounts} from "./pmap-r2-fixture";
it("keeps family selection and touched counts without the removed relationship badge or outline",()=>{
 const html=renderToStaticMarkup(React.createElement(RollupMap,{pkg,proposalCounts,history:records,record:records[0],packageControlIds:[],onRecordChange(){}}));
 expect(html).toContain('data-family-header=');expect(html).toContain('family details');
 expect(html).not.toContain('data-family-focus=');expect(html).not.toContain('data-family-rel-count=');
 expect(html).toMatch(/\d+ of \d+/);expect(html).toContain('package-map-r2');
 const css=readFileSync('app/globals.css','utf8');expect(css).toMatch(/\.pmap \.pmap-lane-label \{[^}]*border-bottom:0/);
});
