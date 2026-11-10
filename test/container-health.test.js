const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('scripts/container-health.cjs','utf8');
async function run(data,{env={},fetcher}={}){const lines=[],process={env,exitCode:null};await vm.runInNewContext(source,{process,AbortSignal,fetch:fetcher||(async()=>Response.json(data)),console:{log:value=>lines.push(JSON.parse(value))}});return {exitCode:process.exitCode,output:JSON.parse(JSON.stringify(lines))}}
const health=overrides=>({ok:true,commit:'a'.repeat(40),storageStatus:{mode:'postgres',configured:true,healthy:true},...overrides});
test('readiness reports a verified last DB request without printing extra health secrets',async()=>{const r=await run(health({privateKey:'DO_NOT_LOG'}));assert.equal(r.exitCode,0);assert.equal(r.output[0].privateChat.database,'last-request-succeeded');assert(!JSON.stringify(r.output).includes('DO_NOT_LOG'))});
test('configured but unverified database is explicitly distinguished from persistence verification',async()=>{const r=await run(health({storageStatus:{mode:'postgres',configured:true,healthy:null}}));assert.equal(r.exitCode,0);assert.equal(r.output[0].privateChat.database,'not-yet-verified')});
test('missing config or ephemeral storage never passes private chat readiness',async()=>{for(const storageStatus of [{mode:'postgres',configured:false,healthy:null},{mode:'memory',configured:true,healthy:true}])assert.equal((await run(health({storageStatus}))).exitCode,1)});
test('a failed database request makes the container unhealthy',async()=>{const r=await run(health({storageStatus:{mode:'postgres',configured:true,healthy:false}}));assert.equal(r.exitCode,1);assert.equal(r.output[0].privateChat.database,'last-request-failed')});
test('unreachable, invalid response and invalid ports fail safely',async()=>{for(const opts of [{fetcher:async()=>{throw Error('private diagnostic')}},{fetcher:async()=>Response.json({}, {status:503})},{env:{PORT:'invalid'}}]){const r=await run(null,opts);assert.equal(r.exitCode,1);assert.equal(r.output[0].app,'unreachable-or-invalid-health-response');assert(!JSON.stringify(r.output).includes('private diagnostic'))}});
