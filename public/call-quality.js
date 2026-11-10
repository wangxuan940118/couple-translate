/* Privacy-safe WebRTC diagnostics and best-effort Safari-compatible video limits. */
(function(root,factory){
 const tools=factory();
 if(typeof module==='object'&&module.exports)module.exports=tools;
 else root.CallTools=tools;
})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 const PRESETS=[
  {maxBitrate:450000,maxFramerate:15,scaleResolutionDownBy:1},
  {maxBitrate:220000,maxFramerate:12,scaleResolutionDownBy:1.5},
  {maxBitrate:100000,maxFramerate:8,scaleResolutionDownBy:2}
 ];
 const fallbackICE=()=>[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}];
 const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
 const invoke=(callback,value)=>{try{if(typeof callback==='function')callback(value)}catch{}};
 function safeIceServers(value){
  if(!Array.isArray(value)||!value.length||value.length>16)return null;
  const servers=[];
  for(const entry of value){
   if(!entry||typeof entry!=='object')return null;
   const urls=typeof entry.urls==='string'?[entry.urls]:entry.urls;
   if(!Array.isArray(urls)||!urls.length||urls.length>8||!urls.every(url=>typeof url==='string'&&url.length<=2048&&/^(stun|stuns|turn|turns):[^\s]+$/i.test(url)))return null;
   const server={urls:typeof entry.urls==='string'?urls[0]:urls.slice()};
   if(entry.username!==undefined){if(typeof entry.username!=='string'||entry.username.length>1024)return null;server.username=entry.username}
   if(entry.credential!==undefined){if(typeof entry.credential!=='string'||entry.credential.length>4096)return null;server.credential=entry.credential}
   servers.push(server);
  }
  return servers;
 }
 async function fetchRTCConfig(options={}){
  const fetcher=options.fetcher||(typeof fetch==='function'?fetch:null);
  const unavailable=message=>({iceServers:fallbackICE(),turnConfigured:false,configurationError:message});
  if(!fetcher)return unavailable('無法讀取通話中繼設定，目前僅使用直接連線。');
  let timeout;const controller=typeof AbortController==='function'?new AbortController():null;
  try{
   const watchdog=new Promise((_,reject)=>{timeout=setTimeout(()=>{if(controller)controller.abort();reject(Error('RTC configuration timeout'))},5000);timeout?.unref?.()});
   const request=(async()=>{
    const response=await fetcher('/api/rtc-config',{method:'GET',headers:options.token?{'X-Room-Token':options.token}:{},credentials:'same-origin',...(controller?{signal:controller.signal}:{})});
    if(!response.ok)throw Error('RTC configuration unavailable');
    const data=await response.json();const iceServers=safeIceServers(data.iceServers);
    if(!iceServers)throw Error('Invalid RTC configuration');
    return {iceServers,turnConfigured:data.turnConfigured===true,configurationError:null};
   })();
   return await Promise.race([request,watchdog]);
  }catch{return unavailable('無法讀取通話中繼設定，目前僅使用直接連線；跨網路通話可能受限。')}
  finally{clearTimeout(timeout)}
 }
 async function applyVideoPreset(sender,requestedLevel=0){
  const level=Math.max(0,Math.min(2,Math.trunc(Number(requestedLevel)||0))),preset={...PRESETS[level]};
  const result=(applied,method)=>({level,preset,applied,method});
  if(!sender||sender.track?.kind!=='video')return result(false,'not-video');
  if(typeof sender.getParameters==='function'&&typeof sender.setParameters==='function'){
   for(const mode of ['rtp','rtp-no-scale','rtp-bitrate-only']){
    try{
     // Fetch fresh parameters after every failure; Safari may invalidate old transactionIds.
     const current=sender.getParameters()||{};
     const encodings=Array.isArray(current.encodings)&&current.encodings.length?current.encodings:[{}];
     const parameters={...current,encodings:encodings.map(encoding=>{
      const next={...encoding,maxBitrate:preset.maxBitrate};
      if(mode!=='rtp-bitrate-only')next.maxFramerate=preset.maxFramerate;else delete next.maxFramerate;
      if(mode==='rtp')next.scaleResolutionDownBy=preset.scaleResolutionDownBy;else delete next.scaleResolutionDownBy;
      return next;
     })};
     await sender.setParameters(parameters);
     // FPS-only fallback is still useful if maxFramerate is unsupported in RTP parameters.
     if(mode==='rtp-bitrate-only'&&typeof sender.track.applyConstraints==='function'){
      try{await sender.track.applyConstraints({frameRate:{ideal:preset.maxFramerate,max:preset.maxFramerate}})}catch{}
     }
     return result(true,mode);
    }catch{}
   }
  }
  if(typeof sender.track.applyConstraints==='function'){
   try{await sender.track.applyConstraints({frameRate:{ideal:preset.maxFramerate,max:preset.maxFramerate}});return result(true,'track-framerate')}
   catch{}
  }
  return result(false,'unsupported');
 }
 function reportList(report){
  const rows=[];
  if(report&&typeof report.forEach==='function')report.forEach(value=>{if(value&&typeof value==='object')rows.push(value)});
  return rows;
 }
 function summarize(report,previous,now){
  const rows=reportList(report),byId=new Map(rows.filter(row=>row.id!==undefined).map(row=>[row.id,row]));
  const transports=rows.filter(row=>row.type==='transport'&&row.selectedCandidatePairId);
  let selected=null;
  for(const transport of transports){const pair=byId.get(transport.selectedCandidatePairId);if(pair?.type==='candidate-pair'){selected=pair;if(transport.dtlsState==='connected')break}}
  if(!selected)selected=rows.find(row=>row.type==='candidate-pair'&&row.state==='succeeded'&&row.nominated===true)||null;
  const local=selected?byId.get(selected.localCandidateId):null,remote=selected?byId.get(selected.remoteCandidateId):null;
  let connectionType='unknown';
  if(local?.candidateType==='relay'||remote?.candidateType==='relay')connectionType='relay';
  else if(selected&&['host','srflx','prflx'].includes(local?.candidateType)&&['host','srflx','prflx'].includes(remote?.candidateType))connectionType='direct';
  const rtt=number(selected?.currentRoundTripTime);
  const audio=rows.filter(row=>row.type==='inbound-rtp'&&(row.kind||row.mediaType)==='audio'&&!row.isRemote);
  let lostDelta=0,receivedDelta=0,validAudioDeltas=0,jitterMs=null;
  for(const row of audio){
   const jitter=number(row.jitter);if(jitter!==null&&jitter>=0)jitterMs=Math.max(jitterMs??0,jitter*1000);
   const prior=previous.get(row.id),lost=number(row.packetsLost),received=number(row.packetsReceived);
   if(prior&&lost!==null&&received!==null&&number(prior.packetsLost)!==null&&number(prior.packetsReceived)!==null){
    const ld=lost-prior.packetsLost,rd=received-prior.packetsReceived;
    if(ld>=0&&rd>=0){lostDelta+=ld;receivedDelta+=rd;validAudioDeltas++}
   }
  }
  const audioLossPercent=validAudioDeltas&&lostDelta+receivedDelta>0?lostDelta/(lostDelta+receivedDelta)*100:null;
  const inboundVideo=rows.filter(row=>row.type==='inbound-rtp'&&(row.kind||row.mediaType)==='video'&&!row.isRemote);
  const outboundVideo=rows.filter(row=>row.type==='outbound-rtp'&&(row.kind||row.mediaType)==='video'&&!row.isRemote);
  const video=inboundVideo.find(row=>number(row.frameWidth)!==null)||inboundVideo[0]||outboundVideo[0];
  let videoFPS=number(video?.framesPerSecond);
  if(videoFPS===null&&video){
   const prior=previous.get(video.id),frames=number(video.framesDecoded??video.framesEncoded),priorFrames=number(prior?.framesDecoded??prior?.framesEncoded);
   const elapsed=prior?((number(video.timestamp)??now)-(number(prior.timestamp)??prior._sampledAt)):0;
   if(frames!==null&&priorFrames!==null&&frames>=priorFrames&&elapsed>0)videoFPS=(frames-priorFrames)*1000/elapsed;
  }
  let sendVideoBitrateKbps=null;
  for(const row of outboundVideo){
   const prior=previous.get(row.id),bytes=number(row.bytesSent),priorBytes=number(prior?.bytesSent);
   const elapsed=prior?((number(row.timestamp)??now)-(number(prior.timestamp)??prior._sampledAt)):0;
   if(bytes!==null&&priorBytes!==null&&bytes>=priorBytes&&elapsed>0)sendVideoBitrateKbps=(sendVideoBitrateKbps??0)+(bytes-priorBytes)*8/elapsed;
  }
  let qualityLimitationReason=null;
  const reasons=outboundVideo.map(row=>row.qualityLimitationReason);
  if(reasons.includes('cpu'))qualityLimitationReason='cpu';else if(reasons.includes('bandwidth'))qualityLimitationReason='bandwidth';else if(reasons.includes('other'))qualityLimitationReason='other';else if(reasons.includes('none'))qualityLimitationReason='none';
  const snapshots=new Map(rows.filter(row=>row.id!==undefined).map(row=>[row.id,{packetsLost:row.packetsLost,packetsReceived:row.packetsReceived,framesDecoded:row.framesDecoded,framesEncoded:row.framesEncoded,bytesSent:row.bytesSent,timestamp:row.timestamp,_sampledAt:now}]));
  return {metrics:{rttMs:rtt!==null&&rtt>=0?rtt*1000:null,jitterMs,audioLossPercent,connectionType,videoWidth:number(video?.frameWidth),videoHeight:number(video?.frameHeight),videoFPS,sendVideoBitrateKbps,qualityLimitationReason},snapshots};
 }
 function createQualityMonitor(pc,options={}){
  const intervalMs=Math.max(1000,Number(options.intervalMs)||3000),clock=typeof options.now==='function'?options.now:Date.now;
  let running=false,timer=null,generation=0,pending=null,previous=new Map(),level=0,poorCount=0,goodCount=0,lastChange=clock()-12000,warnedPoor=false,warnedStats=false;
  const active=token=>running&&generation===token;
  async function work(token){
   try{
    if(!active(token)||!pc||typeof pc.getStats!=='function'||(pc.connectionState&&pc.connectionState!=='connected'))return null;
    const report=await pc.getStats();if(!active(token))return null;
    const summary=summarize(report,previous,clock());previous=summary.snapshots;const metrics={...summary.metrics,videoPresetLevel:level};
    invoke(options.onMetrics,metrics);if(!active(token))return null;
    const poor=(metrics.audioLossPercent!==null&&metrics.audioLossPercent>8)||(metrics.rttMs!==null&&metrics.rttMs>700)||(metrics.jitterMs!==null&&metrics.jitterMs>80)||['cpu','bandwidth'].includes(metrics.qualityLimitationReason);
    const known=[metrics.audioLossPercent,metrics.rttMs,metrics.jitterMs].some(value=>value!==null);
    const good=known&&!poor&&(metrics.audioLossPercent===null||metrics.audioLossPercent<3)&&(metrics.rttMs===null||metrics.rttMs<400)&&(metrics.jitterMs===null||metrics.jitterMs<40)&&!['cpu','bandwidth','other'].includes(metrics.qualityLimitationReason);
    if(poor){poorCount++;goodCount=0}else if(good){goodCount++;poorCount=0}else{poorCount=0;goodCount=0}
    if(poorCount>=2&&!warnedPoor){warnedPoor=true;invoke(options.onWarning,'網路品質不穩，將優先保留通話音訊。')}
    const now=clock();const nextLevel=poorCount>=2&&level<2?level+1:goodCount>=5&&level>0?level-1:level;
    if(nextLevel!==level&&now-lastChange>=12000){
     const senders=typeof pc.getSenders==='function'?pc.getSenders().filter(sender=>sender.track?.kind==='video'):[];
     if(senders.length){
      const results=[];for(const sender of senders){if(!active(token))return null;results.push(await applyVideoPreset(sender,nextLevel));if(!active(token))return null}
      level=nextLevel;lastChange=now;poorCount=0;goodCount=0;
      invoke(options.onPreset,{level,preset:{...PRESETS[level]},applied:results.some(result=>result.applied),methods:results.map(result=>result.method)});
     }
    }
    if(goodCount>=5&&warnedPoor){warnedPoor=false;invoke(options.onWarning,'網路品質改善，視訊會逐步恢復。')}
    return metrics;
   }catch{if(active(token)&&!warnedStats){warnedStats=true;invoke(options.onWarning,'此瀏覽器暫時無法取得完整通話品質資料。')}return null}
  }
  function sample(){
   if(!running)return Promise.resolve(null);if(pending)return pending;
   const token=generation;const job=work(token);pending=job;
   job.finally(()=>{if(pending===job)pending=null});return job;
  }
  function start(){if(running)return;running=true;generation++;previous=new Map();poorCount=0;goodCount=0;warnedStats=false;timer=setInterval(()=>{void sample()},intervalMs);timer?.unref?.();void sample()}
  function stop(){running=false;generation++;clearInterval(timer);timer=null;previous=new Map()}
  return {start,stop,sample};
 }
 return {fetchRTCConfig,applyVideoPreset,createQualityMonitor};
});
