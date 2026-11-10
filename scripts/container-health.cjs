'use strict';
// Local app readiness. This does not authenticate, read messages or expose secrets.
(async()=>{
 try{
  const port=Number(process.env.PORT||3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error();
  const response=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw Error();
  const data=await response.json(),storage=data.storageStatus;
  const configured=storage?.mode==='postgres'&&storage.configured===true;
  const database=storage?.healthy===true?'last-request-succeeded':storage?.healthy===false?'last-request-failed':'not-yet-verified';
  console.log(JSON.stringify({app:data.ok===true?'responding':'not-ready',privateChat:{configured,database},commit:typeof data.commit==='string'&&/^[a-f0-9]{7,64}$/i.test(data.commit)?data.commit:null}));
  // A configured app can start before its first authenticated database request.
  // "healthy" here must not be presented as proof of durable chat or media tests.
  process.exitCode=data.ok===true&&configured&&storage.healthy!==false?0:1;
 }catch{
  console.log(JSON.stringify({app:'unreachable-or-invalid-health-response'}));
  process.exitCode=1;
 }
})();
