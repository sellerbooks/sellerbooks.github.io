import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"GET,POST,OPTIONS"};
const HOST="https://partner.shopeemobile.com";
const AUTH_PATH="/api/v2/shop/auth_partner";
const TOKEN_PATH="/api/v2/auth/token/get";
const INFO_PATH="/api/v2/shop/get_shop_info";
const out=(x:any,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{...CORS,"Content-Type":"application/json"}});
const bearer=(r:Request)=>{const h=r.headers.get("Authorization")||"";return h.toLowerCase().startsWith("bearer ")?h.slice(7).trim():""};
const hex=(b:Uint8Array)=>Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("");
async function digest(s:string){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))))}
async function hmac(k:string,m:string){const x=await crypto.subtle.importKey("raw",new TextEncoder().encode(k),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(new Uint8Array(await crypto.subtle.sign("HMAC",x,new TextEncoder().encode(m))))}
const env=(n:string)=>{const v=Deno.env.get(n);if(v)return v;const aliases:any={SUPABASE_PUBLISHABLE_KEY:"SUPABASE_ANON_KEY",SUPABASE_SECRET_KEY:"SUPABASE_SERVICE_ROLE_KEY"};const a=aliases[n];if(a&&Deno.env.get(a))return Deno.env.get(a)!;if(n==="SUPABASE_PUBLISHABLE_KEY"){try{const x=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}");if(x.default)return x.default}catch{}}if(n==="SUPABASE_SECRET_KEY"){try{const x=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");if(x.default)return x.default}catch{}}throw Error("CONFIG_MISSING_"+n)};
async function rest(base:string,key:string,path:string,init:RequestInit={}){const h=new Headers(init.headers);h.set("apikey",key);h.set("Authorization","Bearer "+key);h.set("Content-Type","application/json");return fetch(base+"/rest/v1/"+path,{...init,headers:h})}
async function rpc(base:string,key:string,fn:string,body:any){return rest(base,key,"rpc/"+fn,{method:"POST",body:JSON.stringify(body)})}
async function user(base:string,key:string,t:string){const r=await fetch(base+"/auth/v1/user",{headers:{apikey:key,Authorization:"Bearer "+t}});return r.ok?r.json():null}
async function init(r:Request){
 const base=env("SUPABASE_URL"),pub=env("SUPABASE_PUBLISHABLE_KEY"),secret=env("SUPABASE_SECRET_KEY"),pid=Number(env("SHOPEE_PARTNER_ID")),pkey=env("SHOPEE_PARTNER_KEY"),redirect=env("SHOPEE_OAUTH_REDIRECT_URI");
 const u=await user(base,pub,bearer(r)); if(!u?.id)return out({ok:false,error:"Sesi SellerBooks tidak valid."},401);
 const b=await r.json().catch(()=>({})); const store=String(b.store_id||"").trim(),mid=String(b.marketplace_id||"").trim(); if(!store||!mid)return out({ok:false,error:"store_id dan marketplace_id wajib."},400);
 const q=await rpc(base,pub,"sellerbooks_api_upsert_connection",{p_store_id:store,p_marketplace_id:mid,p_marketplace:"Shopee"}); const c=await q.json(); if(!q.ok||!c?.id)return out({ok:false,error:"Koneksi Shopee tidak dapat dibuat."},400);
 const raw=crypto.randomUUID()+"."+crypto.randomUUID(),hash=await digest(raw),expires=new Date(Date.now()+600000).toISOString();
 const s=await rpc(base,secret,"sellerbooks_api_create_oauth_state",{p_owner_user_id:u.id,p_store_id:store,p_connection_id:c.id,p_state_hash:hash,p_expires_at:expires}); if(!s.ok)return out({ok:false,error:"OAuth state gagal dibuat."},500);
 const ts=Math.floor(Date.now()/1000),sign=await hmac(pkey,String(pid)+AUTH_PATH+ts),a=new URL(HOST+AUTH_PATH); a.searchParams.set("partner_id",String(pid));a.searchParams.set("timestamp",String(ts));a.searchParams.set("sign",sign);a.searchParams.set("redirect",redirect);a.searchParams.set("state",raw);
 return out({ok:true,connection_id:c.id,authorization_url:a.toString(),expires_at:expires});
}
async function callback(r:Request){
 const base=env("SUPABASE_URL"),secret=env("SUPABASE_SECRET_KEY"),pid=Number(env("SHOPEE_PARTNER_ID")),pkey=env("SHOPEE_PARTNER_KEY"),app=env("SELLERBOOKS_APP_URL").replace(/\/$/,""),u=new URL(r.url),state=String(u.searchParams.get("state")||""),code=String(u.searchParams.get("code")||""),shop=String(u.searchParams.get("shop_id")||"");
 const fail=(x:string)=>{const z=new URL(app);z.searchParams.set("sellerbooks_shopee_oauth","error");z.searchParams.set("reason",x);return Response.redirect(z.toString(),302)};
 if(!state||!code||!shop)return fail("AUTHORIZATION_RESPONSE_INCOMPLETE");
 const c=await rpc(base,secret,"sellerbooks_api_consume_oauth_state",{p_state_hash:await digest(state)}),rows=await c.json(),st=rows?.[0]; if(!c.ok||!st?.connection_id)return fail("STATE_INVALID_OR_EXPIRED");
 try{
  const sid=Number(shop),ts=Math.floor(Date.now()/1000),sign=await hmac(pkey,String(pid)+TOKEN_PATH+ts);
  const tr=await fetch(HOST+TOKEN_PATH,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code,shop_id:sid,partner_id:pid,timestamp:ts,sign})}),td=await tr.json(); if(!tr.ok||td?.error||!td?.access_token)return fail("TOKEN_EXCHANGE_FAILED");
  const its=Math.floor(Date.now()/1000),isign=await hmac(pkey,String(pid)+INFO_PATH+its+td.access_token+sid),iu=new URL(HOST+INFO_PATH);for(const [k,v] of Object.entries({partner_id:pid,timestamp:its,access_token:td.access_token,shop_id:sid,sign:isign}))iu.searchParams.set(k,String(v));
  const ir=await fetch(iu),info=await ir.json();if(!ir.ok||info?.error)return fail("SHOP_VERIFY_FAILED");
  const verified=String(info?.response?.shop_id??sid);if(verified!==String(st.store_id))return fail("SHOP_ID_MISMATCH");
  const credential=JSON.stringify({provider:"shopee",auth_type:"oauth",partner_id:pid,shop_id:sid,access_token:td.access_token,refresh_token:td.refresh_token||"",expire_in:td.expire_in||null,token_received_at:new Date().toISOString(),api_base_url:HOST});
  const done=await rpc(base,secret,"sellerbooks_api_complete_shopee_oauth",{p_connection_id:st.connection_id,p_store_id:st.store_id,p_shop_id:verified,p_credential:credential,p_shop_name:info?.response?.shop_name||null});if(!done.ok)return fail("CONNECTION_FINALIZATION_FAILED");
  const ok=new URL(app);ok.searchParams.set("sellerbooks_shopee_oauth","success");ok.searchParams.set("connection_id",st.connection_id);ok.searchParams.set("shop_id",verified);return Response.redirect(ok.toString(),302);
 }catch(e){console.error(JSON.stringify({service:"sellerbooks-shopee-oauth",event:"callback_failed",connection_id:st.connection_id,error:e instanceof Error?e.message:"UNKNOWN"}));return fail("OAUTH_FAILED")}
}
Deno.serve(async r=>{if(r.method==="OPTIONS")return new Response("ok",{headers:CORS});try{const a=new URL(r.url).searchParams.get("action");if(r.method==="POST"&&a==="init")return await init(r);if(r.method==="GET"&&a==="callback")return await callback(r);return out({ok:false,error:"Invalid OAuth action."},400)}catch(e){return out({ok:false,error:"OAuth service configuration error."},500)}});