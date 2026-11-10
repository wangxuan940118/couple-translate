const {test}=require('node:test');
const assert=require('node:assert/strict');
const CallTools=require('../public/call-quality.js');

function report(t,{rtt=.15,lost=0,received=100,jitter=.01,relay=false,quality='none'}={}){
 const rows=[
  {id:'selected-transport',type:'transport',dtlsState:'connected',selectedCandidatePairId:'selected-pair'},
  {id:'irrelevant-pair',type:'candidate-pair',state:'succeeded',nominated:true,currentRoundTripTime:9},
  {id:'selected-pair',type:'candidate-pair',state:'succeeded',nominated:true,currentRoundTripTime:rtt,localCandidateId:'secret-local',remoteCandidateId:'secret-remote'},
  {id:'secret-local',type:'local-candidate',candidateType:relay?'relay':'host',address:'192.168.10.20',port:50000,url:'turn:private-relay.example:443'},
  {id:'secret-remote',type:'remote-candidate',candidateType:'srflx',ip:'203.0.113.4'},
  {id:'audio',type:'inbound-rtp',kind:'audio',timestamp:t,packetsLost:lost,packetsReceived:received,jitter},
  {id:'incoming-video',type:'inbound-rtp',kind:'video',timestamp:t,frameWidth:640,frameHeight:360,framesDecoded:t/1000*15},
  {id:'outgoing-video',type:'outbound-rtp',kind:'video',timestamp:t,bytesSent:t*40,qualityLimitationReason:quality}
 ];
 return new Map(rows.map(row=>[row.id,row]));
}
function videoSender(){
 const calls=[];let constraints=[];
 return {calls,constraints,track:{kind:'video',applyConstraints:async value=>constraints.push(value)},getParameters(){return {transactionId:'fresh-'+calls.length,encodings:[{rid:'f'}]}},async setParameters(value){calls.push(value)}};
}

test('RTC configuration uses the joined room token and never invents TURN credentials',async()=>{
 let captured;
 const config=await CallTools.fetchRTCConfig({token:'room-token',fetcher:async(url,options)=>{captured={url,options};return {ok:true,json:async()=>({iceServers:[{urls:'turns:relay.example:443',username:'temporary-user',credential:'temporary-pass'}],turnConfigured:true})}}});
 assert.equal(captured.url,'/api/rtc-config');assert.equal(captured.options.headers['X-Room-Token'],'room-token');assert.equal(config.turnConfigured,true);assert.equal(config.configurationError,null);
 assert.equal(config.iceServers[0].credential,'temporary-pass');
 const fallback=await CallTools.fetchRTCConfig({fetcher:async()=>{throw Error('secret-provider-password')}});
 assert.equal(fallback.turnConfigured,false);assert.ok(fallback.configurationError);assert.ok(fallback.iceServers.every(server=>server.urls.startsWith('stun:')));assert.ok(!JSON.stringify(fallback).includes('secret-provider-password'));
 const unsafe=await CallTools.fetchRTCConfig({fetcher:async()=>({ok:true,json:async()=>({iceServers:[{urls:'https://not-a-turn-server.example'}]})})});
 assert.equal(unsafe.turnConfigured,false);
});

test('Safari retry fetches fresh RTP parameters and omits unsupported resolution scaling',async()=>{
 const sender=videoSender();let reads=0;sender.getParameters=()=>({transactionId:'read-'+(++reads),encodings:[{rid:'camera'}]});
 sender.setParameters=async value=>{sender.calls.push(value);if('scaleResolutionDownBy'in value.encodings[0])throw Error('Safari does not support scaling')};
 const applied=await CallTools.applyVideoPreset(sender,1);
 assert.equal(applied.applied,true);assert.equal(applied.method,'rtp-no-scale');assert.equal(reads,2);assert.equal(sender.calls[0].transactionId,'read-1');assert.equal(sender.calls[1].transactionId,'read-2');
 assert.equal(sender.calls[1].encodings[0].maxBitrate,220000);assert.equal(sender.calls[1].encodings[0].maxFramerate,12);assert.equal(sender.calls[1].encodings[0].rid,'camera');assert.equal(sender.calls[1].encodings[0].scaleResolutionDownBy,undefined);
});

test('missing encodings and unsupported RTP parameters safely fall back to video frame-rate constraints',async()=>{
 const sender=videoSender();sender.getParameters=()=>({transactionId:'no-encoding-yet'});sender.setParameters=async()=>{throw Error('InvalidModificationError')};
 const applied=await CallTools.applyVideoPreset(sender,2);assert.equal(applied.method,'track-framerate');assert.equal(sender.constraints[0].frameRate.max,8);
 const impossible=await CallTools.applyVideoPreset({track:{kind:'video',applyConstraints:async()=>{throw Error('Unsupported')}},getParameters(){throw Error('Unsupported')},setParameters:async()=>{}},1);assert.equal(impossible.applied,false);assert.equal(impossible.method,'unsupported');
 let audioTouched=false;const audio=await CallTools.applyVideoPreset({track:{kind:'audio',applyConstraints:async()=>{audioTouched=true}},getParameters(){audioTouched=true},setParameters:async()=>{audioTouched=true}},2);assert.equal(audio.applied,false);assert.equal(audioTouched,false);
});

test('selected-pair diagnostics use interval loss and never expose addresses or candidate identifiers',async t=>{
 let now=0,current=report(0,{lost:100,received:900,relay:true});const metrics=[];
 const monitor=CallTools.createQualityMonitor({connectionState:'connected',getStats:async()=>current,getSenders:()=>[]},{now:()=>now,onMetrics:value=>metrics.push(value)});t.after(()=>monitor.stop());
 monitor.start();const first=await monitor.sample();assert.equal(first.rttMs,150);assert.equal(first.audioLossPercent,null);assert.equal(first.connectionType,'relay');assert.equal(first.jitterMs,10);assert.equal(first.videoFPS,null);
 now=3000;current=report(now,{lost:110,received:990,relay:true});const second=await monitor.sample();assert.equal(second.audioLossPercent,10);assert.equal(second.videoFPS,15);assert.equal(second.videoWidth,640);assert.equal(second.videoHeight,360);assert.equal(second.sendVideoBitrateKbps,320);
 const safe=JSON.stringify(metrics);for(const secret of ['192.168.10.20','203.0.113.4','private-relay','secret-local','selected-pair','50000'])assert.ok(!safe.includes(secret));
 now=6000;current=report(now,{lost:1,received:5});assert.equal((await monitor.sample()).audioLossPercent,null,'counter reset is not enormous loss');
 now=9000;current=report(now,{lost:2,received:14});assert.equal((await monitor.sample()).audioLossPercent,10);
});

test('fallback selected candidate is nominated and absent metrics remain unknown',async t=>{
 const raw=new Map([['pair',{id:'pair',type:'candidate-pair',state:'succeeded',nominated:true,currentRoundTripTime:.2,localCandidateId:'local'}],['local',{id:'local',type:'local-candidate',candidateType:'host'}]]);
 const monitor=CallTools.createQualityMonitor({connectionState:'connected',getStats:async()=>raw,getSenders:()=>[]});t.after(()=>monitor.stop());monitor.start();const metrics=await monitor.sample();assert.equal(metrics.connectionType,'unknown');assert.equal(metrics.rttMs,200);assert.equal(metrics.jitterMs,null);assert.equal(metrics.audioLossPercent,null);assert.equal(metrics.videoFPS,null);
});

test('overlapping samples share one getStats call and stopping suppresses late callbacks',async()=>{
 let resolveStats,reads=0,emitted=0,adapted=0;
 const monitor=CallTools.createQualityMonitor({connectionState:'connected',getStats:()=>{reads++;return new Promise(resolve=>{resolveStats=resolve})},getSenders:()=>[videoSender()]},{onMetrics:()=>emitted++,onPreset:()=>adapted++});
 monitor.start();const a=monitor.sample(),b=monitor.sample();assert.equal(reads,1);assert.equal(a,b);monitor.stop();resolveStats(report(0,{rtt:1}));assert.equal(await a,null);assert.equal(emitted,0);assert.equal(adapted,0);assert.equal(await monitor.sample(),null);
});

test('sustained poor quality reduces only video and recovers gradually with cooldown',async t=>{
 let now=0,current=report(0,{rtt:.9});const video=videoSender(),presets=[],warnings=[];let audioTouched=0;
 const audio={track:{kind:'audio'},getParameters(){audioTouched++},setParameters:async()=>audioTouched++};
 const monitor=CallTools.createQualityMonitor({connectionState:'connected',getStats:async()=>current,getSenders:()=>[audio,video]},{now:()=>now,onPreset:value=>presets.push(value),onWarning:value=>warnings.push(value)});t.after(()=>monitor.stop());monitor.start();await monitor.sample();
 async function tick(time,rtt=.9){now=time;current=report(now,{rtt,received:100+now/10});return monitor.sample()}
 await tick(3000);assert.deepEqual(presets.map(value=>value.level),[1]);assert.equal(video.calls.at(-1).encodings[0].maxBitrate,220000);
 await tick(6000);await tick(9000);assert.equal(presets.length,1,'cooldown prevents rapid cycling');await tick(15000);assert.deepEqual(presets.map(value=>value.level),[1,2]);assert.equal(video.calls.at(-1).encodings[0].maxBitrate,100000);
 for(const time of [18000,21000,24000,27000,30000])await tick(time,.1);assert.deepEqual(presets.map(value=>value.level),[1,2,1]);
 for(const time of [33000,36000,39000,42000,45000])await tick(time,.1);assert.deepEqual(presets.map(value=>value.level),[1,2,1,0]);assert.equal(video.calls.at(-1).encodings[0].maxBitrate,450000);
 for(const time of [48000,51000,54000,57000,60000])await tick(time,.1);assert.equal(presets.at(-1).level,0);assert.equal(audioTouched,0);assert.ok(warnings.some(message=>message.includes('保留通話音訊')));
});
