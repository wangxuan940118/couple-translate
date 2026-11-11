const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');
const AUTH_URL='https://example.supabase.co';
const user={id:'11111111-1111-4111-8111-111111111111',email:'private@example.test',email_confirmed_at:'2026-11-10T00:00:00Z'};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture({stored,onFetch}={}){
 const {document}=parseHTML(fs.readFileSync('public/index.html','utf8'));const values=new Map(),requests=[],events=new Map();let now=Date.now();
 if(stored)values.set('olw-auth-session',JSON.stringify(stored));
 let fetcher=onFetch||((url)=>url==='/api/auth/config'?Response.json({configured:true,url:AUTH_URL,anonKey:'public-anon-key'}):url.endsWith('/user')?Response.json(user):Response.json({access_token:'access-one',refresh_token:'refresh-one',expires_in:3600}));
 const window={addEventListener:(event,handler)=>events.set(event,handler)};
 const context=vm.createContext({window,document,localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},URL,AbortController,Date:{now:()=>now},setTimeout,clearTimeout,console,fetch:async(url,options)=>{requests.push({url,options});return fetcher(url,options)}});
 vm.runInContext(fs.readFileSync('public/auth.js','utf8'),context);
 return {auth:window.WorldAuth,document,values,requests,events,setTime:value=>now=value,setFetch:fn=>fetcher=fn};
}
test('missing server configuration keeps private login disabled without sending credentials',async()=>{
 const f=fixture({onFetch:async()=>Response.json({configured:false})});const state=await f.auth.ready();assert.equal(state.status,'not-configured');assert.equal(f.auth.user(),null);assert.equal(f.document.getElementById('authSignIn').disabled,true);
 await assert.rejects(f.auth.signIn('a@example.test','secret'));assert.equal(f.requests.length,1);assert.equal(await f.auth.accessToken(),null);
});
test('email login verifies the account and restores a session without retaining the password',async()=>{
 const f=fixture();await f.auth.ready();await f.auth.signIn('  private@example.test  ','never-store-this-password');assert.equal(f.auth.user().id,user.id);const saved=f.values.get('olw-auth-session');assert(!saved.includes('never-store-this-password'));assert(!saved.includes(user.email));
 const login=f.requests.find(r=>r.url.includes('grant_type=password'));assert.equal(JSON.parse(login.options.body).email,user.email);assert.equal(login.options.headers.apikey,'public-anon-key');assert.equal(f.requests.at(-1).options.headers.Authorization,'Bearer access-one');
 const restored=fixture({stored:JSON.parse(saved)});await restored.auth.ready();assert.equal(restored.auth.user().id,user.id);assert.equal(await restored.auth.accessToken(),'access-one');assert.equal(restored.requests.some(r=>r.url.includes('grant_type=password')),false);
 assert.equal(restored.document.getElementById('authForm').classList.contains('hidden'),true);
});
test('expired sessions share one refresh and expose only the new access token',async()=>{
 const f=fixture();await f.auth.ready();await f.auth.signIn(user.email,'password');f.setTime(Date.now()+3600*1000);const pending=deferred();
 f.setFetch(url=>url.includes('refresh_token')?pending.promise:Promise.resolve(Response.json(user)));
 const one=f.auth.accessToken(),two=f.auth.accessToken();await flush();assert.equal(f.requests.filter(r=>r.url.includes('grant_type=refresh_token')).length,1);
 pending.resolve(Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}));assert.equal(await one,'new-access');assert.equal(await two,'new-access');assert.equal(JSON.parse(f.values.get('olw-auth-session')).refresh_token,'new-refresh');
});
test('revoked restored sessions are removed and cannot authenticate private requests',async()=>{
 const f=fixture({stored:{project:AUTH_URL,access_token:'revoked',refresh_token:'revoked-refresh',expires_at:Date.now()/1000+3600},onFetch:async url=>url==='/api/auth/config'?Response.json({configured:true,url:AUTH_URL,anonKey:'public-anon-key'}):Response.json({message:'revoked'},{status:401})});
 await f.auth.ready();assert.equal(f.auth.user(),null);assert.equal(await f.auth.accessToken(),null);assert.equal(f.values.has('olw-auth-session'),false);
});
test('signout during login prevents the stale response from restoring access',async()=>{
 const f=fixture();await f.auth.ready();const pending=deferred();f.setFetch(()=>pending.promise);const login=f.auth.signIn(user.email,'password');await flush();await f.auth.signOut();pending.resolve(Response.json({access_token:'late-access',refresh_token:'late-refresh',expires_in:3600}));await login;
 assert.equal(f.auth.user(),null);assert.equal(await f.auth.accessToken(),null);assert.equal(f.values.has('olw-auth-session'),false);assert.equal(f.requests.filter(r=>r.url.endsWith('/user')).length,0);
});
test('temporary network failure retains a saved session for verification on retry',async()=>{
 let offline=true;const f=fixture({stored:{project:AUTH_URL,access_token:'saved-access',refresh_token:'saved-refresh',expires_at:Date.now()/1000+3600},onFetch:async url=>{if(url==='/api/auth/config')return Response.json({configured:true,url:AUTH_URL,anonKey:'public-anon-key'});if(offline)throw Error('network');return Response.json(user)}});
 const state=await f.auth.ready();assert.equal(state.status,'network-error');assert.equal(f.auth.user(),null);assert(f.values.has('olw-auth-session'));offline=false;assert.equal(await f.auth.accessToken(),'saved-access');assert.equal(f.auth.user().id,user.id);
});
test('ready retries failed initial configuration and permits login after the network recovers',async()=>{
 const f=fixture({onFetch:async()=>{throw Error('offline')}});const initial=await f.auth.ready();assert.equal(initial.status,'network-error');assert.equal(initial.configured,false);
 f.setFetch(async url=>url==='/api/auth/config'?Response.json({configured:true,url:AUTH_URL,anonKey:'public-anon-key'}):url.endsWith('/user')?Response.json(user):Response.json({access_token:'retry-access',refresh_token:'retry-refresh',expires_in:3600}));
 const next=await f.auth.ready();assert.equal(next.status,'signed-out');assert.equal(next.configured,true);assert.equal(f.requests.filter(r=>r.url==='/api/auth/config').length,2);
 await f.auth.signIn(user.email,'password');assert.equal(await f.auth.accessToken(),'retry-access');assert.equal((await f.auth.ready()).status,'authenticated');
});
test('simultaneous ready retries share a single request and reverify an offline saved session',async()=>{
 let offline=true;const configRetry=deferred();const f=fixture({stored:{project:AUTH_URL,access_token:'restored-access',refresh_token:'restored-refresh',expires_at:Date.now()/1000+3600},onFetch:async()=>{if(offline)throw Error('offline');return configRetry.promise}});
 await f.auth.ready();offline=false;const one=f.auth.ready(),two=f.auth.ready();await flush();assert.equal(f.requests.filter(r=>r.url==='/api/auth/config').length,2);
 f.setFetch(async()=>Response.json(user));configRetry.resolve(Response.json({configured:true,url:AUTH_URL,anonKey:'public-anon-key'}));assert.equal((await one).status,'authenticated');assert.equal((await two).status,'authenticated');assert.equal(f.auth.user().id,user.id);
});
test('a saved session from another Supabase project is never transmitted',async()=>{
 const f=fixture({stored:{project:'https://another.supabase.co',access_token:'wrong-project',refresh_token:'wrong-refresh',expires_at:Date.now()/1000+3600}});await f.auth.ready();assert.equal(f.auth.user(),null);assert.equal(f.values.has('olw-auth-session'),false);assert.equal(f.requests.length,1);
});
test('logout in another tab immediately removes authenticated UI state',async()=>{
 const f=fixture();await f.auth.ready();await f.auth.signIn(user.email,'password');f.values.delete('olw-auth-session');f.events.get('storage')({key:'olw-auth-session'});assert.equal(f.auth.user(),null);assert.equal(f.document.getElementById('authForm').classList.contains('hidden'),false);assert.equal(await f.auth.accessToken(),null);
});


test('email OTP request does not register users and verification restores authenticated session',async()=>{
 const f=fixture();await f.auth.ready();
 await f.auth.sendOtp('  private@example.test  ');
 const sent=f.requests.find(r=>r.url.endsWith('/auth/v1/otp'));
 assert(sent);assert.equal(JSON.parse(sent.options.body).email,user.email);
 assert.equal(JSON.parse(sent.options.body).create_user,false);
 assert.equal(f.auth.user(),null);
 await f.auth.verifyOtp(user.email,'12345678');
 const verified=f.requests.find(r=>r.url.endsWith('/auth/v1/verify'));
 assert.deepEqual(JSON.parse(verified.options.body),{email:user.email,token:'12345678',type:'email'});
 assert.equal(f.auth.user().id,user.id);
 assert.equal(f.document.getElementById('authForm').classList.contains('hidden'),true);
});
test('email OTP rejects non-eight-digit codes before calling verification endpoint',async()=>{
 const f=fixture();await f.auth.ready();
 await assert.rejects(f.auth.verifyOtp(user.email,'123456'),/8 位數/);
 assert.equal(f.requests.some(r=>r.url.endsWith('/auth/v1/verify')),false);
});
