const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const css = fs.readFileSync(path.join(root,'public/style.css'),'utf8');
const baseline = {"ids": ["accept", "audioBackdrop", "audioCall", "call", "callCaption", "callSend", "callStatus", "callText", "camera", "cameraExtras", "chatlog", "closePhoto", "cover", "coverNext", "decline", "enableNotifications", "filterSelect", "flip", "hangup", "home", "incomingCall", "incomingMode", "incomingTitle", "join", "languageSelect", "leave", "littleNest", "local", "manual", "message", "mic", "mute", "nestAnniversaryLabel", "nestCallLabel", "nestChatLabel", "nestDate", "nestDateHint", "nestDateLabel", "nestDays", "nestLeave", "nestNav", "nestNavCall", "nestNavChat", "nestNavHome", "nestSwedenDate", "nestSwedenLabel", "nestSwedenTime", "nestTabCall", "nestTabChat", "nestTabHome", "nestTagline", "nestTaiwanDate", "nestTaiwanLabel", "nestTaiwanTime", "nestTitle", "nestToCall", "nestToChat", "notificationStatus", "openingSplash", "photoHint", "photoImage", "photoPreview", "random", "remote", "resumeAudio", "room", "savePhoto", "searchMessages", "setup", "setupNotice", "siteHeader", "snapshot", "speechStatus", "splashNote", "splashStyles", "status", "swedenDate", "swedenTime", "taiwanDate", "taiwanTime", "testPhrase", "testResult", "testTargetSelect", "testTranslate", "typingStatus", "videoCall"], "images": ["/C086FD38-3250-4591-891E-8B5024BCE2D0.png", "/public/0432BDF0-48D5-4477-AFA7-20533B57C4D0.png"], "scripts": ["/app.js"], "options": ["zh-TW", "en", "sv", "sr", "fr", "es", "ja", "ko", "de", "tr", "zh-TW", "en", "sv", "sr", "fr", "es", "ja", "ko", "de", "tr", "none", "mono", "soft", "bright", "vintage"], "events": [["onerror", "this.hidden=true"], ["onerror", "this.hidden=true;this.nextElementSibling.hidden=false"]]};
const values = (regex, value = html) => [...value.matchAll(regex)].map(m=>m[1]);
test('cream UI preserves all existing DOM ids, images, language choices and scripts',()=>{
 const actualIds = new Set(values(/\bid="([^"]+)"/g));
 for(const id of baseline.ids) assert.ok(actualIds.has(id), 'removed id '+id);
 assert.deepEqual(values(/<img\b[^>]*src="([^"]+)"/g),baseline.images);
 assert.deepEqual(values(/<script\b[^>]*src="([^"]+)"/g),baseline.scripts);
 assert.deepEqual(values(/<option\b[^>]*value="([^"]*)"/g),baseline.options);
 assert.deepEqual([...html.matchAll(/\b(on\w+)="([^"]*)"/g)].map(m=>[m[1],m[2]]),baseline.events);
});
test('caption permission and partner states have distinct accessible controls',()=>{
 for(const id of ['speechStatus','speechPeerStatus','speechRetry']) assert.equal(values(new RegExp('\\bid="('+id+')"','g')).length,1);
 assert.match(html,/<button id="speechRetry"[^>]*type="button"/);
 assert.match(html,/<span id="speechStatus"[^>]*aria-live="polite"/);
 assert.match(html,/<span id="speechPeerStatus"[^>]*aria-live="polite"/);
});
test('light cream theme and responsive call layout are declared without image replacement',()=>{
 assert.match(html,/<meta name="theme-color" content="#faf8f5">/);
 assert.match(html,/<meta name="color-scheme" content="light">/);
 assert.match(css,/:root\{color-scheme:light;--paper:#faf8f5;/);
 assert.match(css,/height:100dvh/);
 assert.match(css,/env\(safe-area-inset-bottom\)/);
 assert.match(css,/grid-template-rows:auto minmax\(0,1fr\) auto auto auto auto/);
 assert.match(css,/min-height:44px/);
 assert.doesNotMatch(css,/#home \.chatlog\[data-wallpaper\],#home \.chatlog\[data-wallpaper\]::before\{background-image:none/);
 assert.ok(css.includes("/84B8007E-4986-4129-B91F-D8780E7A44C2.png"));
 assert.ok(css.includes('#home .chatlog[data-wallpaper="her"],#home .chatlog[data-wallpaper="her"]::before{background-image:none!important;background-color:#faf8f5!important}'), 'legacy girl SVG must remain hidden until approved art exists');
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
});
test('body text and call translation colors meet AA against their solid cream surfaces',()=>{
 function luminance(hex){const rgb=hex.match(/\w\w/g).map(c=>parseInt(c,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722}
 for(const [foreground,background] of [['24211f','faf8f5'],['655f59','fffdf9'],['211f1c','ffffff'],['5d5650','ffffff'],['ffffff','765b68'],['ffffff','b73540']]){
 const a=luminance(foreground),b=luminance(background);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,foreground+'/'+background);
 }
});
