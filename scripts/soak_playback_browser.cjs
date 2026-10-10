// Local synthetic archives only. See STABILIZATION_REPORT.md for commands/limits.
// Separate Playwright browsers; a touch viewport is not a physical phone.
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const origin = arg('origin') || 'http://127.0.0.1:8765';
const networkControlUrl = new URL('/__network', origin).toString();
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw Error('Local fixture servers only');
const seconds = Number(arg('seconds') || 120), speed = Number(arg('speed') || 16);
const engine = arg('engine') || 'chromium', profile = arg('profile') || 'native';
const baseline = arg('baseline');
const output = arg('output') || '/private/tmp/ctv-soak.json';
const touch = arg('touch') === '1', disruption = arg('disruption');
const percentile = (a, p) => a.length ? [...a].sort((x,y)=>x-y)[Math.floor((a.length-1)*p)] : null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

if (require.main === module) (async () => {
  const pw = require(process.env.CTV_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await pw[engine].launch({headless:true,
    ...(engine === 'chromium' ? {executablePath: process.env.CTV_CHROME_EXECUTABLE} : {})});
  const result = {engine, version:browser.version(), profile, speed, touchEmulation:touch,
    baseline:baseline || 'working-tree', origin, requestedSeconds:seconds, samples:[], errors:[], events:[], resources:[]};
  const source = baseline ? cp.execFileSync('git',['show',`${baseline}:ctv_web/js/player.js`])
    : fs.readFileSync(path.join(__dirname,'../ctv_web/js/player.js'));
  result.playerSha256 = crypto.createHash('sha256').update(source).digest('hex');
  try {
    const page = await browser.newPage({viewport:touch ? {width:390,height:844} : {width:1280,height:900},
      hasTouch:touch, isMobile:touch});
    page.setDefaultTimeout(15000);
    if (arg('touch-points')) {
      const points = Number(arg('touch-points'));
      await page.addInitScript(points => Object.defineProperty(navigator,'maxTouchPoints',{get:()=>points}),points);
      result.touchPointsOverride = points;
    }
    if (baseline) {
      const body = source.toString('utf8');
      await page.route('**/js/player.js*', route => route.fulfill({contentType:'text/javascript', body}));
    }
    page.on('pageerror', e => result.errors.push({type:'page', message:e.message}));
    page.on('console', m => {if (m.type() === 'error') result.errors.push({type:'console', message:m.text()});});
    page.on('response', r => {if (r.status() >= 400) result.errors.push({type:'http',url:r.url(),status:r.status()});});
    if (arg('mbps')) {
      const shaped = await page.request.post(networkControlUrl, {data:{bytes_per_second:Number(arg('mbps'))*1e6/8}});
      if (!shaped.ok()) throw Error('Network shaping requires the synthetic proxy');
      result.mbps = Number(arg('mbps'));
    }
    await page.goto(origin);
    console.log('Loaded fixture', engine, baseline || 'working-tree');
    await page.waitForFunction(()=>S.timeline?.cameras.length === 4 && document.querySelectorAll('#player-area video').length === 4);
    result.capabilities = await page.evaluate(()=>({maxTouchPoints:navigator.maxTouchPoints,
      coarse:matchMedia('(pointer: coarse)').matches,
      nativeHls:document.createElement('video').canPlayType('application/vnd.apple.mpegurl')}));
    // Verify that this is the synthetic fixture before creating playback sessions.
    const cameras = await page.evaluate(()=>S.cameras.map(c=>({name:c.name,source:c.source_path})));
    if (cameras.some(c=>!/^Test [1-4]$/.test(c.name) || !c.source.startsWith('/private/tmp/ctv-fixture-'))) throw Error('Not a synthetic fixture');
    await page.evaluate(() => {
      window.__soakEvents = [];
      for (const v of document.querySelectorAll('#player-area video')) {
        for (const type of ['waiting','playing','seeking','seeked','ended','error','pause','loadeddata']) {
          v.addEventListener(type, () => {
            window.__soakEvents.push({wall:performance.now(),type,cam:v.parentElement.dataset.cam,
              recording:v.dataset.recording,media:v.currentTime,global:S.currentTime});
          });
        }
      }
    });
    await page.locator('#speed-select').selectOption(String(speed));
    if (profile !== 'native') {
      await page.locator('#btn-stream-options').click();
      await page.locator('#quality-select').selectOption(profile);
    }
    result.startTime = await page.evaluate(()=>S.currentTime);
    result.archiveEnd = await page.evaluate(()=>Math.max(...S.timeline.cameras.flatMap(c=>c.segments.map(s=>s.end_ts))));
    await page.locator('#btn-play').click();
    console.log('Playback started', engine, profile, speed);
    const began = Date.now();
    let disrupted = false;
    let lastRefresh = -Infinity;
    while (Date.now()-began < seconds*1000) {
      const elapsed = (Date.now()-began)/1000;
      if (disruption === 'refresh-burst' && elapsed >= 5 && elapsed < 35 && elapsed - lastRefresh >= 0.5) {
        lastRefresh = elapsed;
        await page.evaluate(() => loadTimeline(undefined, undefined, false));
        result.events.push({action:'timeline-refresh',elapsed});
      }
      if (disruption && disruption !== 'refresh-burst' && !disrupted && elapsed >= 5) {
        disrupted = true;
        if (disruption === 'outage') {
          await page.request.post(networkControlUrl, {data:{pause_seconds:5}});
        } else if (disruption === 'seek-barrier') {
          await page.request.post(networkControlUrl, {data:{pause_seconds:40}});
          await page.evaluate(()=>{S.currentTime += 80; seekPlayersToTime();});
          await page.waitForFunction(()=>_wasBuffering && activeVideos().some(v=>v.readyState < 3));
          await page.evaluate(()=>{S.currentTime += 10; seekPlayersToTime();});
        } else if (disruption === 'seek') {
          await page.evaluate(()=>{S.currentTime += 15; seekPlayersToTime();});
        } else if (disruption === 'pause') {
          await page.locator('#btn-play').click();
          await delay(2500);
          await page.locator('#btn-play').click();
        } else if (disruption === 'viewport-rerender') {
          // Mobile browser chrome/orientation can resize a visible page.
          // Keep existing sources and exercise the actual resize handler.
          await page.setViewportSize({width:390,height:760});
        } else if (disruption === 'clock-error') {
          // Controlled fault: prove the recorder distinguishes a dead clock
          // from stalled media. This does not reproduce a user's root cause.
          await page.evaluate(() => {
            const original = updatePlaybackUi;
            updatePlaybackUi = (...args) => {
              updatePlaybackUi = original;
              throw new Error('Synthetic clock UI failure');
            };
          });
        } else if (disruption === 'play-pause-race') {
          // Actual decoder play()/pause() generates AbortError. Delay delivery
          // of that rejection to expose the stale-promise ordering explicitly.
          await page.evaluate(() => {
            window.__playRace = {rejections:[], staleBarrierEntries:0};
            const video = activeVideos()[0], originalPlay = video.play.bind(video);
            const originalBarrier = enterBufferingBarrier;
            let delayed = false;
            enterBufferingBarrier = (...args) => {
              if (delayed && args[0] === video) __playRace.staleBarrierEntries++;
              return originalBarrier(...args);
            };
            video.play = () => {
              video.play = originalPlay;
              // Force a genuinely pending browser play on the same URL. This
              // controlled reload is artificial and must be reported as such.
              video.load();
              __playRace.controlledSameSourceReload = true;
              const promise = originalPlay();
              enterBufferingBarrier(null,null);
              return promise.catch(error => new Promise((_,reject) => setTimeout(() => {
                __playRace.rejections.push({name:error.name,buffering:_wasBuffering,
                  ready:video.readyState,paused:video.paused,media:video.currentTime});
                delayed = true; reject(error);
                setTimeout(() => {delayed = false;}, 10);
              },500)));
            };
            enterBufferingBarrier(null,null);
          });
        } else if (disruption === 'play-denied') {
          // Controlled browser-policy fault, not a spontaneous mobile failure.
          await page.evaluate(() => {
            const video = activeVideos()[0], original = video.play.bind(video);
            window.__restoreDeniedPlay = () => {video.play = original;};
            video.play = () => Promise.reject(new DOMException('Synthetic browser policy refusal','NotAllowedError'));
            enterBufferingBarrier(null,null);
          });
        } else if (disruption === 'visibility-handler') {
          // Exercises the page handler with real decoders, not OS suspension.
          result.simulatedVisibility = true;
          await page.evaluate(()=>{
            Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
            document.dispatchEvent(new Event('visibilitychange'));
          });
          const hidden = await page.evaluate(()=>({playing:S.playing,buffering:_wasBuffering,
            paused:[...document.querySelectorAll('#player-area video')].every(v=>v.paused)}));
          if (hidden.playing || hidden.buffering || !hidden.paused) throw Error('Visibility handler did not pause');
          result.events.push({action:'hidden-handler-state',...hidden});
          await delay(2500);
          await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
          await page.locator('#btn-play').click();
        }
        result.events.push({action:disruption,elapsed});
      }
      const state = await page.evaluate(()=>({wall:performance.now(),time:S.currentTime,playing:S.playing,
        buffering:_wasBuffering,recoveryStarted:_recoveryStarted,hidden:document.hidden,
        videos:[...document.querySelectorAll('#player-area video')].map(v=>({
          cam:v.parentElement.dataset.cam,rec:v.dataset.recording,transport:v.parentElement.dataset.streamTransport,
          media:v.currentTime,absolute:absoluteVideoTime(v),ready:v.readyState,network:v.networkState,
          paused:v.paused,seeking:v.seeking,failed:v.parentElement.dataset.failed === '1',
          warming:v.dataset.warming,buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)]),
          frames:v.getVideoPlaybackQuality?.().totalVideoFrames ?? v.webkitDecodedFrameCount ?? null,
          dropped:v.getVideoPlaybackQuality?.().droppedVideoFrames ?? v.webkitDroppedFrameCount ?? null,
          error:v.error?.code || null,duration:v.duration,
        }))}));
      state.elapsed = elapsed;
      result.samples.push(state);
      if (result.samples.length % 120 === 0) {
        fs.mkdirSync(path.dirname(output),{recursive:true});
        fs.writeFileSync(output+'.partial',JSON.stringify(result,null,2));
        console.log('Progress',engine,profile,Math.round(elapsed),'seconds',Math.round(state.time-result.startTime),'timeline seconds');
      }
      if (result.samples.length % 20 === 1 && arg('pid')) {
        const resource = cp.execFileSync('ps',['-o','pid=,rss=,pcpu=','-p',arg('pid')],{encoding:'utf8'}).trim();
        result.resources.push({elapsed,ps:resource});
      }
      await delay(250);
    }
    result.events.push(...await page.evaluate(()=>window.__soakEvents));
    result.diagnostics = await page.evaluate(()=>window.ctvPlaybackDiagnostics());
    result.flightTrace = await page.evaluate(()=>window.ctvExportPlaybackTrace?.() || null);
    result.playPauseRace = await page.evaluate(()=>window.__playRace || null);
    if (disruption === 'play-denied') {
      result.deniedPlayback = await page.evaluate(()=>({playing:S.playing,time:S.currentTime,
        noticeVisible:!document.getElementById('playback-notice').hidden,
        diagnostics:ctvPlaybackDiagnostics()}));
      await page.evaluate(()=>__restoreDeniedPlay());
      if (result.deniedPlayback.playing) await page.locator('#btn-play').click();
      await page.locator('#btn-play').click();
      await delay(2000);
      result.deniedRecovery = await page.evaluate(()=>({playing:S.playing,time:S.currentTime}));
    }
    if (arg('download-trace') === '1') {
      await page.locator('#btn-stream-options').click();
      const downloading = page.waitForEvent('download');
      await page.locator('#btn-playback-trace').click();
      const download = await downloading;
      await download.saveAs(output + '.download.json');
      const trace = JSON.parse(fs.readFileSync(output + '.download.json', 'utf8'));
      if (trace.schema !== 1 || !trace.samples.length) throw Error('Invalid downloaded playback trace');
      result.downloadedTrace = {filename:download.suggestedFilename(), samples:trace.samples.length,
        bytes:fs.statSync(output + '.download.json').size};
    }
    result.summary = summarize(result);
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify(result,null,2));
    console.log(JSON.stringify({...result.summary,output}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

function summarize(result) {
  const samples = result.samples, intervals = [], transitions = [], drifts = [];
  let run = 0, stalled = 0, buffering = 0, failures = new Set(), changes = 0;
  let transitionStart = null, activeSeconds = 0, decodedFrames = 0, decoderPausedSeconds = 0;
  let backwardSteps = 0, largestBackwardStep = 0;
  const frameStalls = new Map(), longestFrameStall = new Map();
  for (let i=1;i<samples.length;i++) {
    const prev=samples[i-1], s=samples[i], dt=(s.wall-prev.wall)/1000;
    if (s.time < prev.time - 0.001) {
      backwardSteps++; largestBackwardStep=Math.max(largestBackwardStep,prev.time-s.time);
    }
    if (s.playing && prev.playing) activeSeconds += dt;
    if (s.playing && prev.playing && Math.abs(s.time-prev.time) < 0.001) {run+=dt; stalled+=dt;}
    else if (run) {intervals.push(run);run=0;}
    if (s.buffering) buffering+=dt;
    const healthy=s.videos.filter(v=>!v.failed && v.rec);
    for (const v of healthy) {
      const old = prev.videos.find(p=>p.cam === v.cam);
      if (s.playing && v.paused) decoderPausedSeconds += dt;
      if (v.frames !== null && old?.frames !== null) {
        decodedFrames += v.rec === old.rec && v.frames >= old.frames ? v.frames-old.frames : v.frames;
        const still = s.playing && prev.playing && v.rec === old.rec && v.frames === old.frames;
        frameStalls.set(v.cam,still ? (frameStalls.get(v.cam)||0)+dt : 0);
        longestFrameStall.set(v.cam,Math.max(longestFrameStall.get(v.cam)||0,frameStalls.get(v.cam)));
      }
    }
    if (s.playing && healthy.length && !s.buffering) drifts.push(Math.max(...healthy.map(v=>v.absolute))-Math.min(...healthy.map(v=>v.absolute)));
    for(const v of s.videos) if(v.failed) failures.add(`${v.cam}:${v.rec}`);
    if (s.videos.some((v,j)=>v.rec !== prev.videos[j]?.rec)) {changes++;transitionStart=s.wall;}
    if (transitionStart !== null && !s.buffering && s.time > prev.time && healthy.every(v=>!v.paused&&!v.seeking)) {
      transitions.push((s.wall-transitionStart)/1000);transitionStart=null;
    }
  }
  if(run) intervals.push(run);
  return {engine:result.engine,profile:result.profile,speed:result.speed,baseline:result.baseline,
    wallSeconds:(samples.at(-1).wall-samples[0].wall)/1000,
    activeSeconds,decodedFrames,decoderPausedSeconds,backwardSteps,largestBackwardStep,
    longestFrameStallByCamera:Object.fromEntries(longestFrameStall),
    timelineSeconds:samples.at(-1).time-result.startTime,
    effectiveRate:(samples.at(-1).time-result.startTime)/((samples.at(-1).wall-samples[0].wall)/1000),
    activeEffectiveRate:activeSeconds ? (samples.at(-1).time-result.startTime)/activeSeconds : null,
    reachedArchiveEnd:Number.isFinite(result.archiveEnd) && samples.at(-1).time >= result.archiveEnd-.05,
    stalledSeconds:stalled,maxStallSeconds:Math.max(0,...intervals),bufferingSeconds:buffering,
    transitionCount:changes,transitionP95Seconds:percentile(transitions,.95),transitionMaxSeconds:Math.max(0,...transitions),
    driftP95Seconds:percentile(drifts,.95),maxDriftSeconds:Math.max(0,...drifts),
    failedRecordings:[...failures],errors:result.errors.length,
    missingRecoveryDeadlineSamples:samples.filter(s=>s.playing&&s.buffering&&s.recoveryStarted===null).length};
}
module.exports = {summarize};
