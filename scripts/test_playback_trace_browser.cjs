// Recorder/storage tests in real browser engines. Synthetic state and virtual
// time: these tests make no claim about real decoder throughput or iPhone use.
const assert=require('node:assert/strict'), fs=require('node:fs'), http=require('node:http'), path=require('node:path');
const pw=require(process.env.CTV_PLAYWRIGHT_MODULE || 'playwright');
const html=`<!doctype html><input id="playback-trace-enabled" type="checkbox"><button id="btn-playback-trace-stop"></button><button id="btn-playback-trace"></button><div id="playback-trace-status"></div><div id="player-area"><video></video></div><script>
window.t=k=>k;window.ctvPlaybackState=()=>({playing:true,time:performance.now()/1000*16,speed:16,buffering:false});
</script><script src="/js/player.js?v=recorder-test"></script><script src="/trace.js"></script>`;
const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/trace.js'?'text/javascript':'text/html');res.end(req.url==='/trace.js'?fs.readFileSync(path.join(__dirname,'../ctv_web/js/playback-trace.js')):req.url.startsWith('/js/')?'':html);});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const origin=`http://127.0.0.1:${server.address().port}`;
 try {for(const engine of ['chromium','webkit']) {
  const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.CTV_CHROME_EXECUTABLE}:{})});
  try {
   const context=await browser.newContext({acceptDownloads:true}); const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.clock.install();await page.goto(origin);await page.evaluate(()=>ctvPlaybackTraceReady);
   assert.equal(await page.evaluate(()=>ctvTraceEnabled()),false);
   assert.equal(await page.evaluate(()=>ctvExportPlaybackTrace()),null);
   assert.equal(await page.evaluate(()=>localStorage.getItem('ctvPlaybackTraceEnabled')),null);
   await page.evaluate(()=>ctvSetPlaybackTraceEnabled(true));
   // Advance 90 simulated minutes, flushing IndexedDB between clock batches.
   for(let i=0;i<540;i++) {await page.clock.runFor(10000);await page.evaluate(()=>ctvFlushPlaybackTrace());}
   await page.evaluate(()=>{
    ctvTraceAction('day-load-start',{requestId:1});
    const v=document.querySelector('video');
    for(let i=0;i<10000;i++) {v.dispatchEvent(new Event('waiting'));ctvTracePlayRejected(v,{name:'AbortError',message:'Failed https://host/SECRET/video'});}
    ctvTraceAction('day-load-rendered',{requestId:1,durationMs:1200});
   });
   const before=await page.evaluate(()=>ctvExportPlaybackTrace());
   assert(before.samples.length>5400);assert(before.samples[0].wall<1000);assert(before.samples.at(-1).wall>=5400000);
   assert.equal(before.events.filter(e=>e.type==='waiting').reduce((n,e)=>n+e.count,0),10000);
   assert.equal(before.events.filter(e=>e.type==='play-rejected').reduce((n,e)=>n+e.count,0),10000);
   assert(before.events.filter(e=>e.type==='waiting').length<=2);assert(!JSON.stringify(before).includes('SECRET'));
   await page.reload();await page.evaluate(()=>ctvPlaybackTraceReady);assert.equal(await page.evaluate(()=>ctvTraceEnabled()),true);
   await page.clock.runFor(2000);await page.evaluate(()=>ctvSetPlaybackTraceEnabled(false));
   const stopped=await page.evaluate(()=>ctvExportPlaybackTrace());assert(stopped.complete);assert.equal(stopped.pages,2);assert(stopped.samples.length>before.samples.length);
   const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#btn-playback-trace').click()]);
   const downloaded=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
   assert.equal(downloaded.samples.length,stopped.samples.length);assert(downloaded.complete);
   assert(downloaded.events.some(e=>e.type==='session-stop'));
   await page.clock.runFor(10000);assert.equal((await page.evaluate(()=>ctvExportPlaybackTrace())).samples.length,stopped.samples.length);
   await page.reload();await page.evaluate(()=>ctvPlaybackTraceReady);assert.equal(await page.evaluate(()=>ctvTraceEnabled()),false);
   assert.equal((await page.evaluate(()=>ctvExportPlaybackTrace())).samples.length,stopped.samples.length);
   // A new explicit session replaces the previous one.
   await page.evaluate(()=>ctvSetPlaybackTraceEnabled(true));const fresh=await page.evaluate(()=>ctvExportPlaybackTrace());assert(fresh.samples.length>=1 && fresh.samples.length<5);
   // Storage failure stops diagnostics, preserves available data and exposes it.
   await page.evaluate(()=>{
    const transaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(names,mode,...args){if(mode==='readwrite')throw new DOMException('Synthetic quota','QuotaExceededError');return transaction.call(this,names,mode,...args);};
   });
   await page.clock.runFor(6000);const partial=await page.evaluate(()=>ctvExportPlaybackTrace());
   assert.equal(await page.evaluate(()=>ctvTraceEnabled()),false);assert.equal(partial.complete,false);assert.equal(partial.storageError,'QuotaExceededError');assert(partial.samples.length>=5);
   assert.equal(await page.locator('#playback-trace-status').textContent(),'player.traceStorageError');assert.deepEqual(errors,[]);
   console.log(JSON.stringify({engine,simulatedSeconds:5400,retainedSamples:stopped.samples.length,eventCount:stopped.eventCount,downloadBytes:fs.statSync(await download.path()).size,checks:'default-off, long retention, event storm, reload, stop, download, replacement, quota failure passed'}));
   await context.close();
  } finally {await browser.close();}
 }} finally {await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
