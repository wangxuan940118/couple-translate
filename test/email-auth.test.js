const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const SOURCE=fs.readFileSync('public/email-auth.js','utf8');
const STORE='olw-email-auth-session',URL_BASE='https://example.supabase.co';
const USER={id:'11111111-1111-4111-8111-111111111111',email:'private@example.test',email_confirmed_at:'2026-11-11T00:00:00Z'};
const NOW=1800000000000;
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject}}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function stored(overrides={}){return {project:URL_BASE,user_id:USER.id,access_token:'access-original',refresh_token:'refresh-original',expires_at:NOW/1000+3600,...overrides}}
function fixture({saved,onFetch,storageBlocked=false}={}){
 const storage=new Map(),requests=[],states=[],events=new Map(),timers=new Map(),logs=[];let now=NOW,timerSequence=0;
 if(saved)storage.set(STORE,JSON.stringify(saved));
 const classes=(...initial)=>{const items=new Set(initial);return {add:x=>items.add(x),remove:x=>items.delete(x),contains:x=>items.has(x),toggle(x,force){if(force===undefined)force=!items.has(x);if(force)items.add(x);else items.delete(x)}}};
 const ids=['emailAuth','emailAuthRequest','emailAuthVerify','emailAuthNotice','emailAuthAddress','emailAuthCode','emailAuthLogout','emailAuthBack','cover'];
 const elements=Object.fromEntries(ids.map(id=>[id,{id,value:'',textContent:'',classList:classes(...(['emailAuth','emailAuthVerify','emailAuthLogout'].includes(id)?['hidden']:[])),events:new Map(),button:{disabled:false},querySelector(){return this.button},addEventListener(type,callback){this.events.set(type,callback)}}]));
 const defaultFetch=async(url)=>{
  if(url==='/api/auth-config')return Response.json({enabled:true,url:URL_BASE,publishableKey:'sb_publishable_example_public',otpLength:8});
  if(url.endsWith('/otp'))return Response.json({});
  if(url.endsWith('/verify')||url.includes('grant_type=refresh_token'))return Response.json({access_token:'access-new',refresh_token:'refresh-new',expires_at:now/1000+3600,user:USER});
  if(url.endsWith('/user'))return Response.json(USER);
  if(url==='/api/session')return Response.json({user:{id:USER.id,email:USER.email},expiresAt:now/1000+3600});
  if(url.includes('/logout'))return new Response(null,{status:204});
  throw Error('Unexpected URL');
 };
 let fetcher=onFetch||defaultFetch;class ClockDate extends Date{static now(){return now}}
 const window={addEventListener:(type,callback)=>events.set(type,callback)};
 const context=vm.createContext({window,document:{getElementById:id=>elements[id]||null},navigator:{},localStorage:{getItem:key=>{if(storageBlocked)throw Error('Storage blocked');return storage.get(key)||null},setItem:(key,value)=>{if(storageBlocked)throw Error('Storage blocked');storage.set(key,value)},removeItem:key=>{if(storageBlocked)throw Error('Storage blocked');storage.delete(key)}},URL,AbortController,Date:ClockDate,console:{error:(...args)=>logs.push(args),warn:(...args)=>logs.push(args),log:(...args)=>logs.push(args)},atob:value=>Buffer.from(value,'base64').toString('binary'),setTimeout:(fn,ms)=>{const id=++timerSequence;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),fetch:async(url,options={})=>{requests.push({url,options});return fetcher(url,options)}});
 vm.runInContext(SOURCE,context);window.WorldAuth.subscribe(value=>states.push(value));
 return {auth:window.WorldAuth,elements,storage,requests,states,events,timers,logs,defaultFetch,setFetch:fn=>fetcher=fn,setTime:value=>now=value,now:()=>now};
}
async function login(f){await f.auth.ready();await f.auth.requestCode(USER.email);await f.auth.verifyCode(USER.email,'01234567')}

test('native OTP sends no signup flag, accepts exactly eight digits and waits for server permission',async()=>{
 const f=fixture();await f.auth.ready();await f.auth.requestCode('  PRIVATE@example.test ');
 const otp=f.requests.find(x=>x.url.endsWith('/otp'));assert.deepEqual(JSON.parse(otp.options.body),{email:USER.email,create_user:false});assert.equal(otp.options.headers.Authorization,undefined);assert.equal(otp.options.headers.apikey,'sb_publishable_example_public');
 for(const code of ['1234567','123456789','abcd5678'])await assert.rejects(f.auth.verifyCode(USER.email,code));
 const allow=deferred();f.setFetch((url,options)=>url==='/api/session'?allow.promise:f.defaultFetch(url,options));const verify=f.auth.verifyCode(USER.email,'01234567');await flush();assert.equal(f.auth.user(),null);assert.equal(f.states.some(x=>x.status==='authenticated'),false);
 allow.resolve(Response.json({user:{id:USER.id,email:USER.email},expiresAt:NOW/1000+3600}));assert.equal((await verify).id,USER.id);assert.equal(f.auth.user().id,USER.id);assert.equal(f.requests.find(x=>x.url.endsWith('/verify')).options.headers.Authorization,undefined);
 assert.equal(JSON.parse(f.requests.find(x=>x.url.endsWith('/verify')).options.body).token,'01234567');assert.equal(f.elements.emailAuth.classList.contains('hidden'),true);assert.equal(f.elements.cover.classList.contains('hidden'),false);
});
test('server rejection prevents an otherwise valid Supabase user from being logged in',async()=>{
 const f=fixture();await f.auth.ready();f.setFetch((url,options)=>url==='/api/session'?Response.json({error:'provider detail must not leak access-new'},{status:403}):f.defaultFetch(url,options));
 await assert.rejects(f.auth.verifyCode(USER.email,'01234567'));assert.equal(f.auth.user(),null);assert.equal(f.storage.has(STORE),false);assert.equal(f.states.at(-1).status,'signed-out');assert(!f.states.at(-1).message.includes('access-new'));assert.equal(f.logs.length,0);
});
test('a saved session is restored only after provider and server revalidation',async()=>{
 const allow=deferred(),f=fixture({saved:stored(),onFetch:(url)=>url==='/api/auth-config'?Response.json({enabled:true,url:URL_BASE,publishableKey:'sb_publishable_example_public',otpLength:8}):url.endsWith('/user')?Response.json(USER):allow.promise});
 await flush();assert.equal(f.auth.user(),null);allow.resolve(Response.json({user:USER,expiresAt:NOW/1000+3600}));await f.auth.ready();assert.equal(f.auth.user().id,USER.id);assert.equal(await f.auth.accessToken(),'access-original');assert.equal(f.requests.some(x=>x.url.endsWith('/otp')),false);
});
test('revoked sessions clear local credentials and cannot read private rooms',async()=>{
 const f=fixture({saved:stored(),onFetch:async url=>url==='/api/auth-config'?Response.json({enabled:true,url:URL_BASE,publishableKey:'sb_publishable_example_public',otpLength:8}):Response.json({error:'revoked'},{status:401})});
 await f.auth.ready();assert.equal(f.auth.user(),null);assert.equal(await f.auth.accessToken(),null);assert.equal(f.storage.has(STORE),false);assert.equal(f.requests.some(x=>x.url==='/api/session'),false);
});
test('parallel token refreshes share one request and keep a valid active user while pending',async()=>{
 const f=fixture({saved:stored()});await f.auth.ready();f.setTime(NOW+3570000);const renew=deferred();f.setFetch((url,options)=>url.includes('grant_type=refresh_token')?renew.promise:f.defaultFetch(url,options));
 const first=f.auth.accessToken(),second=f.auth.accessToken();await flush();assert.equal(f.requests.filter(x=>x.url.includes('grant_type=refresh_token')).length,1);assert.equal(f.auth.user().id,USER.id);
 renew.resolve(Response.json({access_token:'access-renewed',refresh_token:'refresh-renewed',expires_at:f.now()/1000+3600,user:USER}));assert.equal(await first,'access-renewed');assert.equal(await second,'access-renewed');assert.equal(JSON.parse(f.storage.get(STORE)).refresh_token,'refresh-renewed');
});
test('refresh outages keep a healthy session and preserve rotated refresh tokens for retry',async()=>{
 const f=fixture({saved:stored()});await f.auth.ready();f.setTime(NOW+3570000);let offline=true,refreshes=0;
 f.setFetch((url,options)=>{if(url.includes('grant_type=refresh_token')){refreshes++;return Response.json({access_token:'candidate-'+refreshes,refresh_token:'rotated-'+refreshes,expires_at:f.now()/1000+3600,user:USER})}if(url==='/api/session'&&offline)return Response.json({error:'offline'},{status:503});return f.defaultFetch(url,options)});
 await assert.rejects(f.auth.accessToken());assert.equal(f.auth.user().id,USER.id);assert.equal(f.states.at(-1).status,'network-error');const held=JSON.parse(f.storage.get(STORE));assert.equal(held.refresh_token,'rotated-1');assert.equal(held.expires_at,NOW/1000+3600);
 offline=false;assert.equal(await f.auth.accessToken(),'candidate-2');const sends=f.requests.filter(x=>x.url.includes('grant_type=refresh_token'));assert.equal(JSON.parse(sends[1].options.body).refresh_token,'rotated-1');assert.equal(f.auth.user().id,USER.id);
});
test('an expired token cannot retain an authenticated UI after failed renewal',async()=>{
 const f=fixture({saved:stored()});await f.auth.ready();f.setTime(NOW+3601000);f.setFetch(async()=>Response.json({error:'offline'},{status:503}));await assert.rejects(f.auth.accessToken());assert.equal(f.auth.user(),null);assert.equal(f.states.at(-1).status,'session-expired');assert(f.storage.has(STORE));
});
test('failed initial configuration is retried when the network returns',async()=>{
 const f=fixture({onFetch:async()=>{throw Error('network')}});assert.equal((await f.auth.ready()).status,'network-error');f.setFetch(f.defaultFetch);assert.equal((await f.auth.ready()).status,'signed-out');await f.auth.requestCode(USER.email);assert.equal(f.states.at(-1).status,'code-sent');
});
test('saved sessions survive temporary startup outages and recover without a new OTP',async()=>{
 let offline=true;const f=fixture({saved:stored(),onFetch:(url)=>url==='/api/auth-config'?Response.json({enabled:true,url:URL_BASE,publishableKey:'sb_publishable_example_public',otpLength:8}):offline?Promise.reject(Error('network')):url.endsWith('/user')?Response.json(USER):Response.json({user:USER,expiresAt:NOW/1000+3600})});
 assert.equal((await f.auth.ready()).status,'network-error');assert(f.storage.has(STORE));offline=false;await f.auth.ready();assert.equal(f.auth.user().id,USER.id);assert.equal(f.requests.some(x=>x.url.endsWith('/otp')),false);
});
test('signout clears local access immediately and reports unsuccessful server revocation honestly',async()=>{
 const f=fixture();await login(f);const revoke=deferred();f.setFetch(()=>revoke.promise);const done=f.auth.signOut();assert.equal(f.auth.user(),null);assert.equal(f.storage.has(STORE),false);assert.equal(f.states.at(-1).status,'signed-out');revoke.resolve(Response.json({error:'network'},{status:503}));assert.equal((await done).revoked,false);assert(f.states.at(-1).message.includes('未能確認'));
});
test('a verify response received after Back cannot resurrect authentication or overwrite the notice',async()=>{
 const f=fixture();await f.auth.ready();await f.auth.requestCode(USER.email);const pending=deferred();f.setFetch(()=>pending.promise);const verify=f.auth.verifyCode(USER.email,'01234567');await flush();f.elements.emailAuthBack.events.get('click')();const notice=f.states.at(-1).message;pending.resolve(Response.json({access_token:'late-token',refresh_token:'late-refresh',expires_at:NOW/1000+3600,user:USER}));assert.equal(await verify,null);assert.equal(f.auth.user(),null);assert.equal(f.storage.has(STORE),false);assert.equal(f.states.at(-1).message,notice);
});
test('signout during pending verification prevents late authorization and provider requests',async()=>{
 const f=fixture();await f.auth.ready();const pending=deferred();f.setFetch(()=>pending.promise);const verify=f.auth.verifyCode(USER.email,'01234567');await flush();await f.auth.signOut();pending.resolve(Response.json({access_token:'late-token',refresh_token:'late-refresh',expires_at:NOW/1000+3600,user:USER}));assert.equal(await verify,null);assert.equal(f.auth.user(),null);assert.equal(f.requests.some(x=>x.url==='/api/session'),false);
});
test('OTP resend cooldown is enforced without creating another user or sending another request',async()=>{
 const f=fixture();await f.auth.ready();await f.auth.requestCode(USER.email);await assert.rejects(f.auth.requestCode(USER.email),error=>error.status===429);assert.equal(f.requests.filter(x=>x.url.endsWith('/otp')).length,1);f.setTime(NOW+60001);await f.auth.requestCode(USER.email);assert.equal(f.requests.filter(x=>x.url.endsWith('/otp')).length,2);
});
test('public configuration rejects secret keys, wrong project sessions, and unexpected OTP lengths',async()=>{
 for(const bad of [{publishableKey:'sb_secret_do_not_publish'},{publishableKey:'eyJ.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.signature'},{otpLength:6}]){
  const f=fixture({onFetch:async()=>Response.json({enabled:true,url:URL_BASE,publishableKey:'sb_publishable_example_public',otpLength:8,...bad})});assert.equal((await f.auth.ready()).configured,false);assert.equal(f.auth.user(),null);assert.equal(f.requests.some(x=>x.url.startsWith(URL_BASE)),false);
 }
 const other=fixture({saved:stored({project:'https://another.supabase.co'})});await other.auth.ready();assert.equal(other.auth.user(),null);assert.equal(other.storage.has(STORE),false);assert.equal(other.requests.length,1);
});
test('legacy anon public keys use apikey while user JWTs alone use Bearer',async()=>{
 const anon='eyJ.'+Buffer.from(JSON.stringify({role:'anon'})).toString('base64url')+'.signature';const f=fixture();await f.auth.ready();const g=fixture({onFetch:(url,options)=>url==='/api/auth-config'?Response.json({enabled:true,url:URL_BASE,publishableKey:anon,otpLength:8}):f.defaultFetch(url,options)});await login(g);
 for(const req of g.requests){if(req.url.startsWith(URL_BASE)){assert.equal(req.options.headers.apikey,anon);assert.notEqual(req.options.headers.Authorization,'Bearer '+anon)}}assert.equal(g.requests.find(x=>x.url.endsWith('/user')).options.headers.Authorization,'Bearer access-new');assert.equal(g.requests.find(x=>x.url==='/api/session').options.headers.Authorization,'Bearer access-new');
});
test('cross-tab logout removes access, while same-user token sync preserves healthy media identity',async()=>{
 const f=fixture({saved:stored()});await f.auth.ready();const pending=deferred();f.setFetch(()=>pending.promise);f.storage.set(STORE,JSON.stringify(stored({access_token:'other-tab-new'})));f.events.get('storage')({key:STORE});assert.equal(f.auth.user().id,USER.id);assert.equal(f.states.at(-1).status,'loading');
 f.storage.delete(STORE);f.events.get('storage')({key:STORE});assert.equal(f.auth.user(),null);pending.resolve(Response.json(USER));await flush();assert.equal(f.auth.user(),null);assert.equal(f.states.at(-1).status,'signed-out');
});
test('login can work without localStorage and unsubscribe detaches observers',async()=>{
 const f=fixture({storageBlocked:true});await f.auth.ready();let seen=0;const unsubscribe=f.auth.subscribe(()=>seen++);const once=seen;unsubscribe();await login(f);assert.equal(f.auth.user().id,USER.id);assert.equal(seen,once);assert.equal(f.storage.size,0);assert.equal(f.logs.length,0);
});
