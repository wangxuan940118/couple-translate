import {pathToFileURL} from 'node:url';

export class DeployError extends Error {
  constructor(code, message) {super(message); this.name='DeployError'; this.code=code;}
}
const fail=(code,message)=>{throw new DeployError(code,message)};
const shaPattern=/^[a-f0-9]{40}$/;

export function assertDeployContext(env) {
  if(env.GITHUB_EVENT_NAME!=='push'||env.GITHUB_REF!=='refs/heads/main') {
    fail('DEPLOY_CONTEXT','Deployment is permitted only for a push to main after CI passes.');
  }
  if(!shaPattern.test(env.GITHUB_SHA||''))fail('DEPLOY_SHA','A complete tested GitHub commit SHA is required.');
  return env.GITHUB_SHA;
}

export function validatedHookURL(value,sha) {
  if(!shaPattern.test(sha||''))fail('DEPLOY_SHA','A complete tested GitHub commit SHA is required.');
  if(typeof value!=='string'||!value.trim())fail('DEPLOY_HOOK_MISSING','Hook mode requires the repository secret RENDER_DEPLOY_HOOK_URL.');
  let url;
  try {url=new URL(value);} catch {fail('DEPLOY_HOOK_INVALID','The Render deploy hook format is invalid.');}
  if(url.protocol!=='https:'||url.hostname!=='api.render.com'||url.port||url.username||url.password||url.hash||!/^\/deploy\/srv-[a-z0-9-]+$/.test(url.pathname)) {
    fail('DEPLOY_HOOK_INVALID','Use the HTTPS deploy hook copied from this service’s Render settings.');
  }
  const keys=url.searchParams.getAll('key');
  if(keys.length!==1||!keys[0].trim()||[...url.searchParams.keys()].some(key=>!['key','ref'].includes(key))) {
    fail('DEPLOY_HOOK_INVALID','The Render deploy hook must contain exactly one nonempty key.');
  }
  url.searchParams.set('ref',sha);
  return url;
}

export function validatedServiceURL(value) {
  let url;
  try {url=new URL(value);} catch {fail('DEPLOY_SERVICE_INVALID','Set the repository variable RENDER_SERVICE_URL to this service’s HTTPS onrender.com origin.');}
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.onrender\.com$/.test(url.hostname)) {
    fail('DEPLOY_SERVICE_INVALID','Set the repository variable RENDER_SERVICE_URL to this service’s HTTPS onrender.com origin.');
  }
  return url.origin;
}

async function readJSON(response) {
  try {return await response.json();} catch {return null;}
}

/** Trigger once, then observe. Never retry the secret hook after a timeout. */
export async function runDeployment(env=process.env,dependencies={}) {
  const sha=assertDeployContext(env);
  const mode=env.RENDER_DEPLOY_MODE||'native';
  const fetcher=dependencies.fetch||globalThis.fetch;
  const sleep=dependencies.sleep||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const now=dependencies.now||Date.now;
  const log=dependencies.log||console.log;
  if(mode==='native') {
    log('Native Render mode: CI only. Render Auto-Deploy settings must be verified by the service owner.');
    return {mode:'native',verified:false,reason:'EXTERNAL_CONFIGURATION_UNVERIFIED'};
  }
  if(mode!=='hook')fail('DEPLOY_MODE','RENDER_DEPLOY_MODE must be native or hook.');
  const hook=validatedHookURL(env.RENDER_DEPLOY_HOOK_URL,sha);
  const origin=validatedServiceURL(env.RENDER_SERVICE_URL);
  const timeoutMs=dependencies.timeoutMs??600000,pollMs=dependencies.pollMs??10000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000||!Number.isSafeInteger(pollMs)||pollMs<1||pollMs>30000) {
    fail('DEPLOY_TIMING','Deployment verification timing is invalid.');
  }
  const deadline=now()+timeoutMs;
  let response;
  try {response=await fetcher(hook,{method:'POST',redirect:'error',signal:AbortSignal.timeout(Math.min(15000,timeoutMs))});}
  catch {fail('DEPLOY_TRIGGER_UNKNOWN','The deploy request could not be confirmed. Inspect Render Deploys before retrying; no second request was sent.');}
  // Official hook success states: 200 starts now, 202 waits behind another deploy.
  if(![200,202].includes(response.status))fail('DEPLOY_TRIGGER_REJECTED','Render rejected the deploy request. Check the service and secret in Render; no retry was sent.');
  const queued=response.status===202;
  log(queued?'Render queued the deploy; deployment is not yet verified.':'Render accepted the deploy; deployment is not yet verified.');
  let matched=false;
  while(now()<deadline) {
    const remaining=deadline-now();
    try {
      const health=await fetcher(origin+'/api/health',{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(Math.min(10000,remaining))});
      const data=health.status===200?await readJSON(health):null;
      if(data?.ok===true&&data.commit===sha) {
        matched=true;
        const ready=await fetcher(origin+'/api/ready',{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(Math.max(1,Math.min(10000,deadline-now())))});
        const readiness=ready.status===200?await readJSON(ready):null;
        if(readiness?.ready===true&&readiness?.configured===true) {
          log('Verified: the tested commit is live and the private-service readiness check passed. Durable storage, backups and two-phone calls still need their own verification.');
          return {mode:'hook',verified:true,commit:sha,queued};
        }
      }
    } catch {/* Cold starts and transient checks are observations, never new deploy requests. */}
    const delay=Math.min(pollMs,deadline-now());
    if(delay>0)await sleep(delay);
  }
  fail(matched?'DEPLOY_NOT_READY':'DEPLOY_NOT_VERIFIED',matched?'The tested commit is live, but private-service readiness was not verified before timeout. Inspect Render; no new deploy was triggered.':'The tested commit was not observed before timeout. Inspect Render Deploys and the health commit; no new deploy was triggered.');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  runDeployment().catch(error=>{
    // Never print native fetch exceptions, causes, hook URLs, keys or provider bodies.
    const safe=error instanceof DeployError?error:new DeployError('DEPLOY_FAILED','Deployment verification failed. Inspect Render and GitHub configuration; secret details were suppressed.');
    console.error(`${safe.code}: ${safe.message}`);
    process.exitCode=1;
  });
}
