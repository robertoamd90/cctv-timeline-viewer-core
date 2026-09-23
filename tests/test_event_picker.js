const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
class Element {
  constructor() { this.value=''; this.children=[]; this.hidden=false; this.attrs={}; this.classList={toggle(){}}; }
  replaceChildren(...items) { this.children=items; }
  append(...items) { this.children.push(...items); }
  setAttribute(k,v) { this.attrs[k]=v; }
  removeAttribute(k) { delete this.attrs[k]; }
  scrollIntoView() {}
  focus() { document.activeElement=this; this.onfocus?.(); }
}
const ids=['cam-ha-events','ha-event-fields','ha-entities-status','ha-entities-retry'];
const els=Object.fromEntries(ids.map(id=>[id,new Element()]));
const document={activeElement:null,getElementById:id=>els[id],createElement:()=>new Element(),createTextNode:text=>({textContent:text})};
let fail=false, reads=0;
const context={window:{CtvEventIcons:{svg:()=>''}},document,t:key=>key,api:async()=>{
 reads++;if(fail)throw Error('ha_entities.unauthorized');
 return {entities:[{entity_id:'binary_sensor.front',name:'Front person',state:'on'},{entity_id:'binary_sensor.back',name:'Back',state:'off'}]};
}};
vm.runInNewContext(fs.readFileSync('ctv_web/js/event-picker.js','utf8'),context);
const rows=els['ha-event-fields'].children;
const input=n=>rows[n].children[1].children[0];
const clear=n=>rows[n].children[1].children[1];
const menu=n=>rows[n].children[1].children[2];
const settle=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 assert.equal(rows.length,5);
 input(0).focus();await settle();
 input(0).value='FRONT';input(0).oninput();
 assert.equal(menu(0).children.length,1);
 assert.equal(els['cam-ha-events'].value,''); // Typing is not a selection.
 menu(0).children[0].onclick();
 assert.equal(els['cam-ha-events'].value,'binary_sensor.front=person');
 assert.equal(input(0).readOnly,true);
 assert.equal(rows[0].children[2].textContent,'binary_sensor.front');
 context.window.CtvEventPicker.setMapping('binary_sensor.back=vehicle');
 assert.equal(input(0).value,'');assert.equal(input(1).value,'Back');
 clear(1).onclick();assert.equal(els['cam-ha-events'].value,'');
 input(1).value='back';input(1).oninput();
 input(1).onkeydown({key:'ArrowDown',preventDefault(){}});
 input(1).onkeydown({key:'Enter',preventDefault(){}});
 assert.equal(els['cam-ha-events'].value,'binary_sensor.back=vehicle');
 fail=true;await els['ha-entities-retry'].onclick();
 assert.ok(els['ha-entities-status'].textContent.includes('ha_entities.unauthorized'));
 assert.equal(els['cam-ha-events'].value,'binary_sensor.back=vehicle');
 context.window.CtvEventPicker.setMapping('binary_sensor.missing=motion');
 assert.ok(rows[3].children[2].textContent.includes('events.missing'));
 context.window.CtvEventPicker.setMapping('binary_sensor.front=person\nbinary_sensor.back=person');
 assert.equal(els['cam-ha-events'].value,'binary_sensor.front=person\nbinary_sensor.back=person');
 assert.ok(rows[0].children[2].textContent.includes('events.legacyMultiple'));
 context.window.CtvEventPicker.setMapping('');
 assert.equal(els['cam-ha-events'].value,'');
 console.log('Five-field HA picker tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
