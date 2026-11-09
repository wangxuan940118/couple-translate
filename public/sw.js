self.addEventListener('install',event=>{self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim())});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{const client=clients.find(c=>new URL(c.url).origin===self.location.origin);return client?client.focus():self.clients.openWindow('/') }))});

self.addEventListener('push',event=>{let data={title:'Our Little World ❤️',body:'你有一則新訊息',url:'/'};try{data={...data,...event.data.json()}}catch{}event.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:'/icon.svg',badge:'/icon.svg',tag:'our-little-world-'+Date.now(),data:{url:data.url||'/'}}))});
