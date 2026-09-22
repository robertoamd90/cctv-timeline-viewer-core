const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
class Element {
  constructor() { this.value=''; this.children=[]; this.disabled=false; }
  replaceChildren(...items) { this.children=items; this.value=''; }
  get options() { return this.children; }
  add(item) { this.children.push(item); }
  append(...items) { this.children.push(...items); }
  setAttribute() {}
}
const ids = ['cam-ha-events','ha-entity-search','ha-entity-select','ha-event-type','ha-entity-add','ha-entities-load','ha-entities-status','ha-entity-mappings'];
const els = Object.fromEntries(ids.map(id=>[id,new Element()]));
let fail=false;
const context={window:{},document:{getElementById:id=>els[id],createElement:()=>new Element()},Option:function(text,value){this.text=text;this.value=value;},t:key=>key,api:async()=>{if(fail)throw Error('offline');return {entities:[{entity_id:'binary_sensor.front',name:'Front person',state:'on'},{entity_id:'binary_sensor.back',name:'Back',state:'off'}]};}};
vm.runInNewContext(fs.readFileSync('ctv_web/js/event-picker.js','utf8'),context);
(async()=>{
 await els['ha-entities-load'].onclick();
 els['ha-entity-search'].value='FRONT';els['ha-entity-search'].oninput();
 assert.equal(els['ha-entity-select'].options.length,2);
 els['ha-entity-select'].value='binary_sensor.front';els['ha-entity-select'].onchange();
 assert.equal(els['ha-entity-add'].disabled,true);
 els['ha-event-type'].value='person';els['ha-event-type'].onchange();els['ha-entity-add'].onclick();
 assert.equal(els['cam-ha-events'].value,'binary_sensor.front=person');
 fail=true;await els['ha-entities-load'].onclick();
 assert.equal(els['cam-ha-events'].value,'binary_sensor.front=person');
 context.window.CtvEventPicker.setMapping('binary_sensor.missing=motion');
 assert.ok(els['ha-entity-mappings'].children[0].children[0].textContent.includes('events.missing'));
 els['ha-entity-mappings'].children[0].children[1].onclick();
 assert.equal(els['cam-ha-events'].value,'');
 context.window.CtvEventPicker.setMapping('');
 assert.equal(els['ha-entity-mappings'].children.length,0);
 console.log('HA entity picker tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
