import {createClient} from '@supabase/supabase-js';
let sb,channel,session;const callbacks={};const emit=(n,v)=>(callbacks[n]||[]).forEach(f=>f(v));
window.desktop={widget:async on=>{window.chrome.webview.postMessage({op:'widget',on});return on},notify:(title,body)=>window.chrome.webview.postMessage({op:'notify',title,body}),on:(n,f)=>(callbacks[n]??=[]).push(f),cloud:async(op,p={})=>{try{
if(op==='init'){if(channel&&sb)await sb.removeChannel(channel);sb=createClient(p.url,p.key,{auth:{persistSession:false,autoRefreshToken:true,detectSessionInUrl:false}});session=null;if(p.session){let r=await sb.auth.setSession(p.session);if(r.error)throw r.error;session=r.data.session;}sb.auth.onAuthStateChange((e,s)=>{session=s;emit('session',s?{access_token:s.access_token,refresh_token:s.refresh_token}:null)});return {ok:true,user:session?.user?.id||null};}
if(!sb)throw Error('Configura la conexión primero');let r;
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
else throw Error('Operación inválida');if(r.error)throw r.error;if(op==='signup'||op==='login'){session=r.data.session;return {ok:true,user:session?.user?.id||null,session:session?{access_token:session.access_token,refresh_token:session.refresh_token}:null};}return {ok:true,data:r.data};}catch(e){return {ok:false,error:e.message||String(e)}}}};