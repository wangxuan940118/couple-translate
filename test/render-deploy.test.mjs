import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertDeployContext,validatedHookURL,validatedServiceURL,runDeployment} from '../scripts/render-deploy.mjs';

const sha='a'.repeat(40),secret='never-log-this-secret';
const hook=`https://api.render.com/deploy/srv-example123?key=${secret}`;
const env={GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,RENDER_DEPLOY_MODE:'hook',RENDER_DEPLOY_HOOK_URL:hook,RENDER_SERVICE_URL:'https://couple-translate.onrender.com'};
const health=commit=>Response.json({ok:true,commit});
const ready=()=>Response.json({ready:true,configured:true,schemaVersion:1,dataPathVerified:false});
function fixture(sequence,options={}) {
 let time=0;
 const requests=[],logs=[];
 return {requests,logs,dependencies:{fetch:async(url,request)=>{requests.push({url:String(url),...request});const next=sequence.shift();if(next instanceof Error)throw next;if(typeof next==='function')return next(url,request);assert.ok(next,'Unexpected request');return next;},sleep:async ms=>{time+=ms;},now:()=>time,log:message=>logs.push(message),timeoutMs:30,pollMs:10,...options}};
}

test('deploy hook validates HTTPS Render host, secret and exact tested commit without leaking inputs',()=>{
 const url=validatedHookURL(hook+'&ref=older',sha);assert.equal(url.searchParams.get('ref'),sha);assert.equal(url.searchParams.get('key'),secret);
 for(const value of [undefined,'not a URL','http://api.render.com/deploy/srv-test?key='+secret,'https://api.render.com.evil.test/deploy/srv-test?key='+secret,'https://other.test/deploy/srv-test?key='+secret,'https://name:password@api.render.com/deploy/srv-test?key='+secret,'https://api.render.com:8443/deploy/srv-test?key='+secret,'https://api.render.com/deploy/srv-test?key=','https://api.render.com/deploy/srv-test?key=a&key=b','https://api.render.com/deploy/srv-test?key='+secret+'&imgURL=private','https://api.render.com/deploy/srv-test?key='+secret+'#fragment']) {
  assert.throws(()=>validatedHookURL(value,sha),error=>{assert.ok(error.code.startsWith('DEPLOY_HOOK'));assert.ok(!String(error).includes(secret));assert.ok(!String(error).includes('password@'));return true;});
 }
 assert.throws(()=>validatedHookURL(hook,'main'),{code:'DEPLOY_SHA'});
});

test('service verification is restricted to an HTTPS Render service origin',()=>{
 assert.equal(validatedServiceURL(env.RENDER_SERVICE_URL),env.RENDER_SERVICE_URL);
 for(const value of [undefined,'https://localhost','https://169.254.169.254','http://example.onrender.com','https://user:pass@example.onrender.com','https://example.onrender.com/secret','https://example.onrender.com?key='+secret,'https://example.onrender.com.evil.test','https://example.onrender.com#secret'])assert.throws(()=>validatedServiceURL(value),{code:'DEPLOY_SERVICE_INVALID'});
});

test('PR, fork, manual dispatch and non-main branch contexts cannot trigger any network operation',async()=>{
 for(const changes of [{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_EVENT_NAME:'pull_request_target'},{GITHUB_EVENT_NAME:'workflow_dispatch'},{GITHUB_REF:'refs/heads/feature'},{GITHUB_SHA:'main'}]){
  const f=fixture([]);await assert.rejects(runDeployment({...env,...changes},f.dependencies));assert.equal(f.requests.length,0);
 }
 assert.equal(assertDeployContext(env),sha);
});

test('native mode performs no deployment and never claims Render was configured',async()=>{
 const f=fixture([]);const result=await runDeployment({...env,RENDER_DEPLOY_MODE:undefined,RENDER_DEPLOY_HOOK_URL:undefined},f.dependencies);
 assert.deepEqual(result,{mode:'native',verified:false,reason:'EXTERNAL_CONFIGURATION_UNVERIFIED'});assert.equal(f.requests.length,0);
 assert.ok(f.logs[0].includes('must be verified'));
 await assert.rejects(runDeployment({...env,RENDER_DEPLOY_MODE:'anything'},f.dependencies),{code:'DEPLOY_MODE'});
});

test('opted-in hook mode fails before network access when the secret or service URL is missing',async()=>{
 for(const changes of [{RENDER_DEPLOY_HOOK_URL:''},{RENDER_SERVICE_URL:''}]){const f=fixture([]);await assert.rejects(runDeployment({...env,...changes},f.dependencies));assert.equal(f.requests.length,0);}
});

test('200 means accepted, not success: one POST deploys the exact SHA and both live checks must pass',async()=>{
 const f=fixture([Response.json({deploy:{id:'hidden-deploy-id'}},{status:200}),health('b'.repeat(40)),health(sha),ready()]);
 const result=await runDeployment(env,f.dependencies);assert.equal(result.verified,true);assert.equal(result.queued,false);assert.equal(result.commit,sha);
 assert.equal(f.requests[0].method,'POST');assert.equal(f.requests[0].redirect,'error');assert.equal(new URL(f.requests[0].url).searchParams.get('ref'),sha);assert.equal(f.requests.filter(request=>request.method==='POST').length,1);
 assert.deepEqual(f.requests.slice(1).map(request=>new URL(request.url).pathname),['/api/health','/api/health','/api/ready']);
 assert.ok(f.logs[0].includes('not yet verified'));assert.ok(f.logs.at(-1).includes('Durable storage'));assert.ok(!JSON.stringify(f.logs).includes(secret));assert.ok(!JSON.stringify(f.logs).includes('hidden-deploy-id'));
});

test('202 queued deploy waits for exact live commit and never repeats the hook request',async()=>{
 const f=fixture([new Response(null,{status:202}),new Response(null,{status:503}),health(sha),ready()]);
 const result=await runDeployment(env,f.dependencies);assert.equal(result.verified,true);assert.equal(result.queued,true);assert.equal(f.requests.filter(request=>request.method==='POST').length,1);assert.ok(f.logs[0].includes('queued'));
});

test('provider response bodies and fetch exceptions containing the secret are never logged',async()=>{
 for(const rejected of [Response.json({error:hook},{status:401}),new Response(hook,{status:302}),Error('Failed to fetch '+hook)]) {
  const f=fixture([rejected]);await assert.rejects(runDeployment(env,f.dependencies),error=>{assert.ok(!String(error).includes(secret));assert.ok(!String(error).includes('api.render.com'));assert.ok(['DEPLOY_TRIGGER_REJECTED','DEPLOY_TRIGGER_UNKNOWN'].includes(error.code));return true;});
  assert.equal(f.requests.length,1);assert.ok(!JSON.stringify(f.logs).includes(secret));
 }
});

test('old health commit remains unverified despite HTTP 200 and any ready-looking payload',async()=>{
 const f=fixture([new Response(null,{status:200}),health('b'.repeat(40)),health('b'.repeat(40)),health('b'.repeat(40))]);
 await assert.rejects(runDeployment(env,f.dependencies),{code:'DEPLOY_NOT_VERIFIED'});assert.equal(f.requests.length,4);assert.equal(f.requests.filter(request=>request.method==='POST').length,1);assert.ok(!f.logs.some(log=>log.startsWith('Verified:')));
});

test('matching commit with unready private backend is not declared successful',async()=>{
 const f=fixture([new Response(null,{status:200}),health(sha),new Response(null,{status:503}),health(sha),Response.json({ok:true}),health(sha),Response.json({ready:true,configured:false})]);
 await assert.rejects(runDeployment(env,f.dependencies),{code:'DEPLOY_NOT_READY'});assert.equal(f.requests.filter(request=>request.method==='POST').length,1);assert.ok(!f.logs.some(log=>log.startsWith('Verified:')));
});

test('CI runs all checks on PR and main; only a successful push to main can access the hook job',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 assert.match(workflow,/pull_request:\s+branches: \[main\]/);assert.match(workflow,/push:\s+branches: \[main\]/);
 assert.ok(!workflow.includes('pull_request_target'));assert.match(workflow,/permissions:\s+contents: read/);assert.match(workflow,/node-version: '24'/);
 for(const command of ['npm ci','npm run check','npm test'])assert.ok(workflow.includes('run: '+command));
 const deployment=workflow.slice(workflow.indexOf('\n  deploy:'));
 assert.ok(deployment.includes('needs: checks'));assert.ok(deployment.includes("github.event_name == 'push'"));assert.ok(deployment.includes("github.ref == 'refs/heads/main'"));assert.ok(deployment.includes("vars.RENDER_DEPLOY_MODE == 'hook'"));
 assert.ok(deployment.includes('secrets.RENDER_DEPLOY_HOOK_URL'));assert.ok(!workflow.slice(0,workflow.indexOf('\n  deploy:')).includes('secrets.'));assert.ok(!workflow.includes('workflow_dispatch:'));
});
