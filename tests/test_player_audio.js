const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const state={speed:1,playing:true,buffering:false,hidden:false,day:1}, mutations=[];
function video(cam){
 let muted=true;
 const button={dataset:{},setAttribute(k,v){this[k]=v}};
 const v={dataset:{},hidden:false,seeking:false,error:null,ended:false,paused:true,
  parentElement:{dataset:{cam},querySelector:()=>button},listeners:{},addEventListener(k,f){this.listeners[k]=f},button};
 Object.defineProperty(v,'muted',{get:()=>muted,set:v=>{muted=v;mutations.push([cam,v])}});return v;
}
const a=video('1'),b=video('2');let videos=[a,b],resumes=0,blocked=0;
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync('ctv_web/js/player-audio.js','utf8'),ctx);
const audio=ctx.CtvPlayerAudio;audio.configure({state:()=>state,videos:()=>videos,label:k=>k,resume:()=>resumes++,blocked:()=>blocked++});
audio.attach(a);audio.attach(b);assert(a.muted&&b.muted);
audio.toggle('1');assert(!a.muted&&b.muted);assert.equal(a.button['aria-pressed'],'true');
mutations.length=0;audio.toggle('2');assert(a.muted&&!b.muted);assert.deepEqual(mutations.slice(0,2),[['1',true],['2',false]]);
audio.toggle('2');assert(a.muted&&b.muted);
audio.toggle('1');state.buffering=true;audio.sync();assert(a.muted&&b.muted);state.buffering=false;audio.sync();assert(!a.muted);
a.seeking=true;audio.sync();assert(a.muted);a.seeking=false;a.dataset.warming='1';audio.sync();assert(a.muted);a.dataset.warming='0';audio.sync();assert(!a.muted);
state.playing=false;audio.sync();assert(a.muted);assert.equal(a.button['aria-pressed'],'true');state.playing=true;audio.sync();assert(!a.muted);
// Changing source on the same video keeps the selection; a missing clip stays silent.
a.hidden=true;audio.sync();assert(a.muted);a.hidden=false;audio.sync();assert(!a.muted);
state.speed=16;audio.sync();assert(a.muted&&b.muted&&a.button.disabled);state.speed=1;audio.sync();assert(a.muted&&b.muted&&!a.button.disabled);
audio.toggle('1');state.day=2;audio.sync();assert(a.muted);audio.toggle('1');videos=[b];audio.sync();assert(b.muted);videos=[a,b];audio.sync();assert(a.muted);
audio.toggle('1');a.paused=false;audio.markPause(a);a.paused=true;a.listeners.pause();assert(!a.muted);assert.equal(resumes,0);a.paused=false;a.listeners.pause();assert(!a.muted);assert.equal(resumes,0);a.paused=true;a.listeners.pause();assert(a.muted);assert.equal(resumes,1);assert.equal(blocked,1);a.listeners.pause();assert.equal(resumes,1);
let stops=0;a.button.onclick({stopPropagation(){stops++}});assert.equal(stops,1);assert(!a.muted);
console.log('Player audio tests passed');
