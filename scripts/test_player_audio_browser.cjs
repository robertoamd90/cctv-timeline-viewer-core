// Local synthetic fixtures only; checks decoded media and the actual camera controls.
const assert=require('node:assert/strict'),fs=require('node:fs');
const arg=n=>process.argv.find(v=>v.startsWith(`--${n}=`))?.slice(n.length+3);
const origin=arg('origin')||'http://127.0.0.1:8775/api/hassio_ingress/synthetic-fixture/';
assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
(async()=>{
 const pw=require(process.env.CTV_PLAYWRIGHT_MODULE||'playwright'),engine=arg('engine')||'chromium';
 const browser=await pw[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.CTV_CHROME_EXECUTABLE}:{})});
 let page;
 try{
  page=await browser.newPage(engine==='webkit'?{isMobile:true,hasTouch:true,viewport:{width:390,height:844}}:{}),errors=[];
  if(engine==='webkit')await page.addInitScript(()=>Object.defineProperty(navigator,'maxTouchPoints',{get:()=>2}));
  page.on('pageerror',e=>errors.push(e.message));
  // The proxy defaults to a shared slow link; establish an explicit baseline.
  await page.request.post(new URL('/__network',origin).toString(),{data:{bytes_per_second:0}});
  await page.goto(origin);
  await page.waitForFunction(()=>S.timeline?.cameras.length===4&&S.zoomRange);
  assert(await page.evaluate(()=>S.cameras.every(c=>/^Test [1-4]$/.test(c.name)&&c.source_path.startsWith('/private/tmp/ctv-fixture-'))));
  await page.evaluate(()=>{
   window.audioViolations=[];window.audioMediaFailures=[];
   const traceAction=window.ctvTraceAction;window.ctvTraceAction=(type,value)=>{if(type==='recording-failed')audioMediaFailures.push(value);traceAction?.(type,value)};
   document.addEventListener('error',e=>{if(e.target.tagName==='VIDEO')audioMediaFailures.push({code:e.target.error?.code,message:e.target.error?.message})},true);
   function check(){
    const videos=getVideos(),audible=videos.filter(v=>!v.muted);
    if(audible.length>1||audible.length&&(S.speed!==1||_wasBuffering||audible.some(v=>v.seeking||v.dataset.warming==='1')))
     audioViolations.push({count:audible.length,speed:S.speed,buffering:_wasBuffering});
    requestAnimationFrame(check);
   }requestAnimationFrame(check);
  });
  console.log(await page.evaluate(()=>({touch:navigator.maxTouchPoints,coarse:matchMedia('(pointer: coarse)').matches,hls:getVideos()[0].canPlayType('application/vnd.apple.mpegurl')})));
  const results=[];
  for(const profile of ['native','fast']){
   await page.locator('#btn-stream-options').click();
   await page.locator('#quality-select').selectOption(profile);
   await page.mouse.click(5,5);
   await page.evaluate(()=>{S.currentTime=Math.min(...S.timeline.cameras.flatMap(c=>c.segments.map(s=>s.start_ts)));seekPlayersToTime()});
   await page.locator('#btn-play').click();
   await page.waitForFunction(()=>S.playing&&!_wasBuffering&&getVideos().every(v=>!v.hidden&&v.readyState>=3)).catch(async e=>{console.log(await page.evaluate(()=>({playing:S.playing,time:S.currentTime,from:S.timeline.from,speed:S.speed,buffering:_wasBuffering,notice:document.getElementById('playback-notice-text').textContent,videos:getVideos().map(v=>({cam:v.parentElement.dataset.cam,hidden:v.hidden,ready:v.readyState,rec:v.dataset.recording,error:v.error?.message,paused:v.paused,muted:v.muted,buffering:v.parentElement.dataset.buffering,mediaTime:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,buffer:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)])}))})));throw e});
   await page.locator('.player-audio').nth(0).click();
   await page.waitForFunction(()=>!getVideos()[0].muted);
   const before=await page.evaluate(()=>({time:S.currentTime,recording:getVideos()[0].dataset.recording}));
   await page.locator('.player-audio').nth(1).click();
   await page.waitForFunction(()=>getVideos()[0].muted&&!getVideos()[1].muted);
   await page.locator('.player-audio').nth(1).click();assert(await page.evaluate(()=>getVideos().every(v=>v.muted)));
   await page.locator('.player-audio').nth(0).click();
   // A real seek must silence warmup and resume the same selected camera.
   await page.evaluate(()=>{S.currentTime=Math.min(...S.timeline.cameras.flatMap(c=>c.segments.map(s=>s.start_ts)))+5;seekPlayersToTime()});
   await page.waitForFunction(()=>!_wasBuffering&&!getVideos()[0].muted);
   await page.waitForFunction(old=>getVideos()[0].dataset.recording!==old&&!getVideos()[0].muted,before.recording,{timeout:20000});
   const after=await page.evaluate(()=>({time:S.currentTime,transport:getVideos()[0].parentElement.dataset.streamTransport,
    decodedAudioBytes:getVideos()[0].webkitAudioDecodedByteCount??null,frames:getVideos()[0].getVideoPlaybackQuality().totalVideoFrames}));
   assert(after.time>before.time&&after.frames>0);
   if(after.decodedAudioBytes!=null)assert(after.decodedAudioBytes>0);
   await page.locator('#btn-play').click();
   assert(await page.evaluate(()=>getVideos().every(v=>v.muted)&&document.querySelector('.player-audio').getAttribute('aria-pressed')==='true'));
   await page.locator('#btn-play').click();
   await page.waitForFunction(()=>S.playing&&!_wasBuffering&&!getVideos()[0].muted);
   if(profile==='native'&&arg('output'))await page.screenshot({path:arg('output').replace(/\.json$/, '-ui.png')});
   await page.request.post(new URL('/__network',origin).toString(),{data:{bytes_per_second:0,pause_seconds:2}});
   await page.evaluate(()=>{S.currentTime=Math.min(...S.timeline.cameras.flatMap(c=>c.segments.map(s=>s.start_ts)))+24;seekPlayersToTime()});
   assert(await page.evaluate(()=>getVideos().every(v=>v.muted)));
   await page.waitForTimeout(400);assert(await page.evaluate(()=>getVideos().every(v=>v.muted)));
   await page.waitForFunction(()=>S.playing&&!_wasBuffering&&!getVideos()[0].muted);
   await page.locator('#speed-select').selectOption('16');
   assert(await page.evaluate(()=>getVideos().every(v=>v.muted)&&Array.from(document.querySelectorAll('.player-audio')).every(b=>b.disabled&&b.getAttribute('aria-pressed')==='false')));
   await page.locator('#speed-select').selectOption('1');
   assert(await page.evaluate(()=>getVideos().every(v=>v.muted)));
   if(await page.evaluate(()=>S.playing))await page.locator('#btn-play').click();
   results.push({profile,...after});console.log({engine,profile,...after});
  }
  const violations=await page.evaluate(()=>audioViolations);assert.deepEqual(violations,[]);assert.deepEqual(errors,[]);
  const result={engine,version:browser.version(),realPhone:false,touchPointsEmulated:engine==='webkit',results,errors,violations};
  if(arg('output'))fs.writeFileSync(arg('output'),JSON.stringify(result,null,2));console.log(result);
 }catch(error){
  if(page)console.log(await page.evaluate(()=>({playing:S.playing,time:S.currentTime,buffering:_wasBuffering,failures:audioMediaFailures,videos:getVideos().map(v=>({cam:v.parentElement.dataset.cam,rec:v.dataset.recording,muted:v.muted,paused:v.paused,hidden:v.hidden,ready:v.readyState,mediaTime:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,selected:v.parentElement.querySelector('.player-audio').getAttribute('aria-pressed')}))})));
  throw error;
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
