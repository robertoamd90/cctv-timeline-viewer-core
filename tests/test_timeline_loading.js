const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const nodes=new Map();
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:`existing-${id}`,addEventListener(){}});return nodes.get(id);};
const ctx=vm.createContext({S:{timeline:{from:100,to:200,cameras:[{camera_id:1}]},
  zoomRange:null,cameras:[{id:1}],currentTime:null,loadingPartitions:1,session:{is_admin:true}},
  window:{addEventListener(){}},document:{getElementById:node,addEventListener(){}},t:x=>x});
vm.runInContext(fs.readFileSync(require.resolve('../ctv_web/js/timeline.js'),'utf8'),ctx);
const callback=fs.readFileSync(require.resolve('../ctv_web/js/app.js'),'utf8')
  .match(/function updateTimelinePartitionState[\s\S]*?\n\}/)[0];
vm.runInContext(callback,ctx);
const before=node('timeline-body').innerHTML;
for(let n=0;n<5;n++)ctx.updateTimelinePartitionState(1,'scanning',n,5);
assert.equal(node('timeline-body').innerHTML,before);
assert.equal(ctx.S.zoomRange,null);assert.equal(ctx.S.currentTime,null);
assert.equal(ctx.S.timeline.cameras[0].progress_done,4,'progress still updates during loading');
let queued;ctx.requestAnimationFrame=cb=>{queued=cb;return 1;};
ctx.queuePanRender();queued();assert.equal(node('timeline-body').innerHTML,before);
// Once loadTimeline installs the new coherent state, the normal render resumes.
ctx.S.timeline={from:300,to:400,cameras:[{camera_id:1}]};ctx.S.zoomRange=[300,400];
const drawn=[];ctx.contentWidth=()=>800;ctx.rowWidth=()=>900;
ctx.renderRuler=(a,b)=>drawn.push(['ruler',a,b]);
ctx.renderOverview=(a,b)=>drawn.push(['overview',a,b]);
ctx.renderRows=(a,b)=>drawn.push(['rows',a,b]);ctx.updateCursor=()=>{};
ctx.renderTimeline();assert.deepEqual(drawn,[['ruler',300,400],['overview',300,400],['rows',300,400]]);
// Empty-day rendering must still clear the old day even if no range is present.
ctx.S.timeline={cameras:[]};ctx.S.zoomRange=null;ctx.renderTimeline();
assert.match(node('timeline-body').innerHTML,/timeline.loadingDay/);
assert.equal(node('timeline-ruler').innerHTML,'');assert.equal(node('overview').innerHTML,'');
console.log('Timeline day-loading interleaving tests passed');
