const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,Notification}=require('electron');
const path=require('path');let win,tray;const {createClient}=require('@supabase/supabase-js');let sb,channel,session;
function emit(name,data){if(win&&!win.isDestroyed())win.webContents.send(name,data)}
function make(){win=new BrowserWindow({width:1220,height:820,minWidth:340,minHeight:420,title:'NOSOTROS.',backgroundColor:'#141413',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});win.loadFile('index.html');win.on('close',e=>{if(!app.quitting){e.preventDefault();win.hide()}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());}
if(!app.requestSingleInstanceLock())app.quit();else{app.on('second-instance',()=>{win.show();win.focus()});app.whenReady().then(()=>{make();const svg='<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="15" fill="#c86d51"/><path d="M32 48L13 29Q5 10 25 16L32 22L39 16Q59 10 51 29Z" fill="#f2efe9"/></svg>';tray=new Tray(nativeImage.createFromDataURL('data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')));tray.setToolTip('NOSOTROS.');tray.setContextMenu(Menu.buildFromTemplate([{label:'Abrir',click:()=>win.show()},{label:'Salir',click:()=>{app.quitting=true;app.quit()}}]));tray.on('click',()=>win.show());});}
ipcMain.handle('widget',(_,on)=>{win.setAlwaysOnTop(on);win.setSize(on?390:1220,on?660:820);win.center();return on});
ipcMain.handle('notify',(_,title,body)=>{if(Notification.isSupported())new Notification({title:String(title).slice(0,100),body:String(body).slice(0,200)}).show()});
ipcMain.handle('cloud',async(_,op,p={})=>{try{
if(op==='init'){if(channel&&sb)await sb.removeChannel(channel);sb=createClient(p.url,p.key,{auth:{persistSession:false,autoRefreshToken:true,detectSessionInUrl:false}});session=null;if(p.session){const r=await sb.auth.setSession(p.session);if(r.error)throw r.error;session=r.data.session;}sb.auth.onAuthStateChange((e,s)=>{session=s;emit('session',s?{access_token:s.access_token,refresh_token:s.refresh_token}:null)});return {ok:true,user:session?.user?.id||null};}
if(!sb)throw Error('Configura la conexión primero');
let r;
if(op==='signup')r=await sb.auth.signUp({email:p.email,password:p.password});
else if(op==='login')r=await sb.auth.signInWithPassword({email:p.email,password:p.password});
else if(op==='logout'){await sb.auth.signOut();return {ok:true};}
else if(op==='status')r=await sb.rpc('my_space');
else if(op==='create')r=await sb.rpc('create_space',{display:p.name});
else if(op==='invite')r=await sb.rpc('make_invite');
else if(op==='join')r=await sb.rpc('join_space',{invite_code:p.code,display:p.name});
else if(op==='approve')r=await sb.rpc('approve_member',{member_id:p.id});
else if(op==='list')r=await sb.from('items').select('*').eq('space_id',p.space);
else if(op==='save')r=await sb.from('items').upsert(p.item);
else if(op==='sub'){if(channel)await sb.removeChannel(channel);channel=sb.channel('space:'+p.space).on('postgres_changes',{event:'*',schema:'public',table:'items',filter:'space_id=eq.'+p.space},()=>emit('changed',{})).subscribe(s=>emit('sync',s));return {ok:true};}
else throw Error('Operación inválida');
if(r.error)throw r.error;if(op==='signup'||op==='login'){session=r.data.session;return {ok:true,user:session?.user?.id||null,session:session?{access_token:session.access_token,refresh_token:session.refresh_token}:null};}return {ok:true,data:r.data};
}catch(e){return {ok:false,error:e.message||String(e)}}});