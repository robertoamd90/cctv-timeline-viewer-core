// Synthetic localhost only: day-load interleaving with real browser rendering.
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
const arg=name=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3);
const origin=arg('origin')||'http://127.0.0.1:8766/';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname))throw Error('Local fixtures only');
(async()=>{
 const pw=require(process.env.CTV_PLAYWRIGHT_MODULE||'playwright');const engine=arg('engine')||'webkit';
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.CTV_CHROME_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  if(arg('baseline'))await page.route('**/js/timeline.js*',route=>route.fulfill({contentType:'text/javascript',
   body:cp.execFileSync('git',['show',`${arg('baseline')}:ctv_web/js/timeline.js`]).toString()}));
  if(arg('mbps')) {
   const r=await page.request.post(new URL('/__network',origin).toString(),{data:{bytes_per_second:Number(arg('mbps'))*1e6/8}});
   assert(r.ok(),'Network shaping requires the synthetic proxy');
  }
  await page.goto(origin);await page.waitForFunction(()=>S.timeline?.cameras.length===4&&S.zoomRange);
  assert(await page.evaluate(()=>S.cameras.every(c=>/^Test [1-4]$/.test(c.name)&&c.source_path.startsWith('/private/tmp/ctv-fixture-'))));
  let hold=true,held=false,release;const gate=new Promise(resolve=>release=resolve);
  await page.route(/\/api\/timeline\?/,async route=>{
   if(hold){held=true;await gate;}await route.continue();
  });
  await page.locator('#timeline-date').fill('2026-10-11');await page.locator('#timeline-date').dispatchEvent('change');
  const began=Date.now();while(!held){if(Date.now()-began>10000)throw Error('Day request not intercepted');await page.waitForTimeout(20);}
  const before=await page.evaluate(()=>({range:S.zoomRange,html:document.getElementById('timeline-body').innerHTML}));
  assert.equal(before.range,null);
  await page.evaluate(()=>{
   // Dispatch through the actual SSE listener during the pending API request.
   const camera=S.timeline.cameras[0].camera_id;
   setTimeout(()=>evtSource.dispatchEvent(new MessageEvent('partition_progress',{
    data:JSON.stringify({camera_id:camera,partition:'synthetic',done:1,total:10})})),0);
   queuePanRender();
  });
  await page.waitForTimeout(150);
  const during=await page.evaluate(()=>({range:S.zoomRange,html:document.getElementById('timeline-body').innerHTML}));
  assert.equal(during.range,null);assert.equal(during.html,before.html);
  const loadingErrors=errors.slice();hold=false;release();
  await page.waitForFunction(()=>S.zoomRange&&S.zoomRange[0]===selectedDayRange()[0]);
  await page.locator('#timeline-date').fill('2026-10-10');await page.locator('#timeline-date').dispatchEvent('change');
  await page.waitForFunction(()=>S.zoomRange&&S.timeline?.cameras.some(c=>c.segments.length)&&S.currentTime!=null);
  await page.locator('#speed-select').selectOption('16');const start=await page.evaluate(()=>S.currentTime);
  await page.locator('#btn-play').click();await page.waitForTimeout(8000);
  const playback=await page.evaluate(()=>({playing:S.playing,time:S.currentTime,range:S.zoomRange}));
  assert(playback.playing&&playback.time>start+20,'Playback resumes after a coherent day load');
  await page.locator('#btn-play').click();
  const result={engine,version:browser.version(),baseline:arg('baseline')||'working-tree',loadingErrors,errors,
   previousDrawingPreserved:true,playbackAdvance:playback.time-start,playback};
  if(arg('baseline'))assert(loadingErrors.some(e=>e.includes('null')),'Old render must reproduce null range error');
  else assert.deepEqual(errors,[]);
  if(arg('output'))fs.writeFileSync(arg('output'),JSON.stringify(result,null,2)+'\n');
  console.log(result);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
