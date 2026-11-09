import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvedStatementProse} from '../lib/aegis/map-view';
test('statement prose resolves profile values and labels unset and unknown parameters without OSCAL syntax',()=>{
 const prose='Use {{ insert: param, cm-06_odp.01 }} every {{ insert: param, cm-06_odp.02 }} with {{ insert: param, unknown }}.';
 assert.equal(resolvedStatementProse(prose,{'cm-06_odp.01':{label:'configurations',constraint:'common secure configurations'},'cm-06_odp.02':{label:'frequency',constraint:null}}),'Use common secure configurations every [Organization-defined parameter: frequency] with [Organization-defined parameter: unknown].');
 assert.equal(resolvedStatementProse('No parameters.'),'No parameters.');
});
