// Use only with the two synthetic fixture servers; see README.md for setup.
// Optional dependencies: Playwright and Chrome, outside the runtime image.
const {chromium}=require(process.env.CTV_PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CTV_CHROME_EXECUTABLE || undefined,headless:true});
 const results=[]; const throughProxy = process.env.CTV_BENCHMARK_PROXY === '1';
 try {
  for(const scenario of (throughProxy ? [{profile:'fast',cams:4,mbps:1.2,duration:25}, {profile:'fast',cams:4,mbps:2.4,outage:true,duration:20}] : [
   {profile:'native',cams:1,mbps:0,duration:4},
   {profile:'fast',cams:4,mbps:0,duration:5},
   {profile:'balanced',cams:4,mbps:0,duration:5},
   {profile:'fast',cams:4,mbps:2.4,duration:10},
   {profile:'fast',cams:4,mbps:0.8,duration:10},
   {profile:'balanced',cams:4,mbps:6,duration:10},
  ])) for(let rep=0;rep<Number(process.env.CTV_BENCHMARK_REPETITIONS || 3);rep++) for(const port of (throughProxy ? [8776,8775] : [8766,8765])) {
   const page=await browser.newPage({viewport:{width:1280,height:900}});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`http://127.0.0.1:${port}`);
   await page.waitForFunction(()=>document.querySelectorAll('#player-area video').length===4);
   if(scenario.cams===1) await page.locator('#layout-select').selectOption('1x1');
   const cdp=await page.context().newCDPSession(page);
   await cdp.send('Network.enable');
   let bytes=0,requests=0;
   const mediaRequests=new Set();
   cdp.on('Network.requestWillBeSent',e=>{if(/\/(stream|video|hls)\//.test(e.request.url)){requests++;mediaRequests.add(e.requestId);}});
   cdp.on('Network.dataReceived',e=>{if(mediaRequests.has(e.requestId))bytes+=e.dataLength;});
   const net={offline:false,latency:scenario.mbps?150:0,downloadThroughput:scenario.mbps?scenario.mbps*1e6/8:-1,uploadThroughput:-1};
   if (throughProxy) await page.request.post(`http://127.0.0.1:${port}/__network`, {data:{bytes_per_second:scenario.mbps*1e6/8}});
   else await cdp.send('Network.emulateNetworkConditions',net);
   const start=Date.now();
   if(scenario.profile!=='native') {
    await page.locator('#btn-stream-options').click();
    await page.locator('#quality-select').selectOption(scenario.profile);
   }
   await page.locator('#btn-play').click();
   let first=null,stalled=0,playingSamples=0,maxSpread=0,samples=0;
   let offline=false,restored=false,last=Date.now();
   while(Date.now()-start<scenario.duration*1000) {
    const elapsed=Date.now()-start;
    if(scenario.outage&&first!==null&&elapsed>=first+2000&&!offline){offline=true;await page.request.post(`http://127.0.0.1:${port}/__network`,{data:{pause_seconds:2}});}
    const state=await page.evaluate(()=>({playing:S.playing,buffering:_wasBuffering,time:S.currentTime, times:[...document.querySelectorAll('#player-area video')].filter(v=>!v.hidden).map(v=>v.currentTime+Number(v.parentElement.dataset.streamOffset||0))}));
    const now=Date.now();
    if(state.playing&&state.buffering)stalled+=now-last;
    if(state.playing&&!state.buffering){playingSamples++; if(first===null)first=now-start; if(state.times.length)maxSpread=Math.max(maxSpread,Math.max(...state.times)-Math.min(...state.times));}
    samples++;last=now;await delay(100);
   }
   const final=await page.evaluate(()=>({time:S.currentTime,playing:S.playing,notice:document.getElementById('playback-notice-text')?.textContent||'',diag:window.ctvPlaybackDiagnostics?.()}));
   const result={port,rep,...scenario,firstMs:first,bufferingMs:stalled,bytes,requests,playingSamples,samples,maxSpread,...final,errors};
   results.push(result);console.log(JSON.stringify({port,rep,profile:scenario.profile,mbps:scenario.mbps,outage:!!scenario.outage,first,stalled,requests,time:final.time,notice:final.notice}));
   fs.writeFileSync(process.env.CTV_BENCHMARK_OUTPUT || '/tmp/ctv-browser-comparison.json',JSON.stringify(results,null,2));
   await page.close();await delay(250);
  }
 } finally {await browser.close();}
})();
