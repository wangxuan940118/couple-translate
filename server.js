const http=require('http');
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');
const PORT=process.env.PORT||3000;
const rooms=new Map();
const hits=new Map();
function limited(req){const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();const now=Date.now();const arr=(hits.get(ip)||[]).filter(t=>now-t<60000);arr.push(now);hits.set(ip,arr);return arr.length>30}
setInterval(()=>{const now=Date.now();for(const[k,v]of hits)if(!v.some(t=>now-t<60000))hits.delete(k)},60000).unref();
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname==='/api/translate'){
  if(req.method!=='POST'){res.writeHead(405);return res.end();}
  if(limited(req)){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'Too many requests'}));}
  let body='';req.on('data',c=>{body+=c;if(body.length>5000)req.destroy()});req.on('end',async()=>{
   try{const {text,from,to}=JSON.parse(body);if(typeof text!=='string'||text.length>500||!['en','zh-TW'].includes(from)||!['en','zh-TW'].includes(to))throw Error('Invalid translation request');
    const q=new URL('https://api.mymemory.translated.net/get');q.searchParams.set('q',text);q.searchParams.set('langpair',`${from}|${to}`);
    const r=await fetch(q,{signal:AbortSignal.timeout(12000)});const d=await r.json();if(!r.ok||d.responseStatus!==200||!d.responseData?.translatedText)throw Error(d.responseDetails||'Translation unavailable');
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({translation:d.responseData.translatedText}));
   }catch(e){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(e.message||e)}));}
  });return;
 }
 let p=u.pathname==='/'?'/index.html':u.pathname;const full=path.resolve(__dirname,'public','.'+p);if(!full.startsWith(path.resolve(__dirname,'public')+path.sep)){res.writeHead(403);return res.end()};fs.readFile(full,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}res.writeHead(200,{'Content-Type':mime[path.extname(full)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data)});
});
const wss=new WebSocket.Server({server});
function send(ws,data){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data))}
wss.on('connection',ws=>{
 ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}
  if(m.type==='join'){
   if(ws.room)return send(ws,{type:'error',message:'Already joined a room'});
   const room=String(m.room||'').trim().toUpperCase();if(!/^[A-Z0-9]{6,20}$/.test(room))return send(ws,{type:'error',message:'Invalid room code'});
   let peers=rooms.get(room)||new Set();if(peers.size>=2)return send(ws,{type:'error',message:'Room is full'});
   ws.room=room;peers.add(ws);rooms.set(room,peers);send(ws,{type:'joined',count:peers.size});for(const peer of peers)if(peer!==ws)send(peer,{type:'peer-joined'});return;
  }
  if(!ws.room)return;const peers=rooms.get(ws.room)||new Set();if(!['offer','answer','ice','caption','call-invite','call-accept','call-decline','call-end'].includes(m.type))return;
  if(m.type==='call-invite'&&!['audio','video'].includes(m.mode))return;
  if(['offer','answer'].includes(m.type)&&(!m.sdp||typeof m.sdp!=='object'))return;
  if(m.type==='ice'&&(!m.candidate||typeof m.candidate!=='object'))return;
  if(m.type==='caption'&&(typeof m.text!=='string'||m.text.length>1000||!['en','zh-TW'].includes(m.lang)))return;
  for(const peer of peers)if(peer!==ws)send(peer,m);
 });
 ws.on('close',()=>{if(!ws.room)return;const peers=rooms.get(ws.room);if(!peers)return;peers.delete(ws);for(const peer of peers)send(peer,{type:'peer-left'});if(!peers.size)rooms.delete(ws.room)});
});
server.listen(PORT,()=>console.log(`Couple Translate listening on ${PORT}`));
