import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"GET,POST,OPTIONS"
};
const HOST="https://partner.shopeemobile.com";
const AUTH_PATH="/api/v2/shop/auth_partner";
const TOKEN_PATH="/api/v2/auth/token/get";
const INFO_PATH="/api/v2/shop/get_shop_info";

const out=(x:any,s=200)=>new Response(JSON.stringify(x),{
  status:s,
  headers:{...CORS,"Content-Type":"application/json"}
});
const bearer=(r:Request)=>{
  const h=r.headers.get("Authorization")||"";
  return h.toLowerCase().startsWith("bearer ")?h.slice(7).trim():"";
};
const hex=(b:Uint8Array)=>Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("");
async function digest(s:string){
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))));
}
async function hmac(k:string,m:string){
  const x=await crypto.subtle.importKey("raw",new TextEncoder().encode(k),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC",x,new TextEncoder().encode(m))));
}
const env=(n:string)=>{
  const v=Deno.env.get(n);
  if(v)return v;
  const aliases:any={
    SUPABASE_PUBLISHABLE_KEY:"SUPABASE_ANON_KEY",
    SUPABASE_SECRET_KEY:"SUPABASE_SERVICE_ROLE_KEY"
  };
  const a=aliases[n];
  if(a&&Deno.env.get(a))return Deno.env.get(a)!;
  if(n==="SUPABASE_PUBLISHABLE_KEY"){
    try{
      const x=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}");
      if(x.default)return x.default;
    }catch{}
  }
  if(n==="SUPABASE_SECRET_KEY"){
    try{
      const x=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");
      if(x.default)return x.default;
    }catch{}
  }
  throw Error("CONFIG_MISSING_"+n);
};

async function rest(base:string,key:string,path:string,init:RequestInit={}){
  const h=new Headers(init.headers);
  h.set("apikey",key);
  h.set("Authorization","Bearer "+key);
  h.set("Content-Type","application/json");
  return fetch(base+"/rest/v1/"+path,{...init,headers:h});
}
async function rpc(base:string,key:string,fn:string,body:any){
  return rest(base,key,"rpc/"+fn,{method:"POST",body:JSON.stringify(body)});
}
async function user(base:string,key:string,t:string){
  const r=await fetch(base+"/auth/v1/user",{
    headers:{apikey:key,Authorization:"Bearer "+t}
  });
  return r.ok?r.json():null;
}
async function responseText(r:Response){
  try{return await r.text();}catch{return "";}
}
function safeUpstream(raw:string){
  try{
    const x=JSON.parse(raw);
    return String(x?.message||x?.hint||x?.error_description||x?.error||"");
  }catch{
    return "";
  }
}

async function init(r:Request){
  const base=env("SUPABASE_URL");
  const pub=env("SUPABASE_PUBLISHABLE_KEY");
  const secret=env("SUPABASE_SECRET_KEY");
  const pid=Number(env("SHOPEE_PARTNER_ID"));
  const pkey=env("SHOPEE_PARTNER_KEY");
  const redirect=env("SHOPEE_OAUTH_REDIRECT_URI");

  if(!Number.isFinite(pid)||pid<=0) return out({ok:false,error:"SHOPEE_PARTNER_ID belum valid.",stage:"config"},500);
  if(!pkey) return out({ok:false,error:"SHOPEE_PARTNER_KEY belum tersedia.",stage:"config"},500);
  if(!redirect) return out({ok:false,error:"SHOPEE_OAUTH_REDIRECT_URI belum tersedia.",stage:"config"},500);

  const token=bearer(r);
  const u=await user(base,pub,token);
  if(!u?.id){
    return out({ok:false,error:"Sesi SellerBooks tidak valid. Silakan login kembali.",stage:"session"},401);
  }

  const b=await r.json().catch(()=>({}));
  const store=String(b.store_id||"").trim();
  const mid=String(b.marketplace_id||"").trim();

  if(!store||!mid){
    return out({ok:false,error:"store_id dan marketplace_id wajib.",stage:"request"},400);
  }

  const q=await rpc(base,pub,"sellerbooks_api_upsert_connection",{
    p_store_id:store,
    p_marketplace_id:mid,
    p_marketplace:"Shopee"
  });
  const qraw=await responseText(q);
  let c:any=null;
  try{c=JSON.parse(qraw);}catch{}
  if(!q.ok||!c?.id){
    const detail=safeUpstream(qraw);
    console.error(JSON.stringify({
      service:"sellerbooks-shopee-oauth",
      event:"init_upsert_failed",
      user_id:u.id,
      store_id:store,
      marketplace_id:mid,
      status:q.status,
      detail
    }));
    return out({
      ok:false,
      error:detail||"Koneksi Shopee tidak dapat dibuat.",
      stage:"upsert_connection",
      status:q.status
    },400);
  }

  const raw=crypto.randomUUID()+"."+crypto.randomUUID();
  const hash=await digest(raw);
  const expires=new Date(Date.now()+600000).toISOString();

  const s=await rpc(base,secret,"sellerbooks_api_create_oauth_state",{
    p_owner_user_id:u.id,
    p_store_id:store,
    p_connection_id:c.id,
    p_state_hash:hash,
    p_expires_at:expires
  });
  const sraw=await responseText(s);

  if(!s.ok){
    const detail=safeUpstream(sraw);
    console.error(JSON.stringify({
      service:"sellerbooks-shopee-oauth",
      event:"init_state_failed",
      user_id:u.id,
      store_id:store,
      connection_id:c.id,
      status:s.status,
      detail
    }));
    return out({
      ok:false,
      error:detail||"OAuth state gagal dibuat.",
      stage:"create_oauth_state",
      status:s.status
    },500);
  }

  const ts=Math.floor(Date.now()/1000);
  const sign=await hmac(pkey,String(pid)+AUTH_PATH+ts);
  const a=new URL(HOST+AUTH_PATH);
  a.searchParams.set("partner_id",String(pid));
  a.searchParams.set("timestamp",String(ts));
  a.searchParams.set("sign",sign);
  a.searchParams.set("redirect",redirect);
  a.searchParams.set("state",raw);

  console.log(JSON.stringify({
    service:"sellerbooks-shopee-oauth",
    event:"authorization_url_created",
    user_id:u.id,
    store_id:store,
    connection_id:c.id
  }));

  return out({
    ok:true,
    connection_id:c.id,
    authorization_url:a.toString(),
    expires_at:expires
  });
}

async function findPendingState(base:string,secret:string,storeId:string){
  const path="sellerbooks_api_oauth_states?store_id=eq."+encodeURIComponent(storeId)+
    "&consumed_at=is.null&select=owner_user_id,store_id,connection_id,state_hash,expires_at,created_at"+
    "&order=created_at.desc&limit=10";
  const r=await rest(base,secret,path);
  const raw=await responseText(r);
  if(!r.ok)return null;

  let rows:any[]=[];
  try{rows=JSON.parse(raw);}catch{return null;}

  const now=Date.now();
  return rows.find((x:any)=>{
    const exp=Date.parse(String(x.expires_at||""));
    return Number.isFinite(exp)&&exp>now;
  })||null;
}

async function callback(r:Request){
  const base=env("SUPABASE_URL");
  const secret=env("SUPABASE_SECRET_KEY");
  const pid=Number(env("SHOPEE_PARTNER_ID"));
  const pkey=env("SHOPEE_PARTNER_KEY");
  const app=env("SELLERBOOKS_APP_URL").replace(/\/$/,"");
  const u=new URL(r.url);

  const state=String(u.searchParams.get("state")||"");
  const code=String(u.searchParams.get("code")||"");
  const shop=String(u.searchParams.get("shop_id")||"");

  const fail=(x:string)=>{
    const z=new URL(app);
    z.searchParams.set("sellerbooks_shopee_oauth","error");
    z.searchParams.set("reason",x);
    return Response.redirect(z.toString(),302);
  };

  if(!code||!shop)return fail("AUTHORIZATION_RESPONSE_INCOMPLETE");

  try{
    const sid=Number(shop);
    if(!Number.isFinite(sid)||sid<=0)return fail("INVALID_SHOP_ID");

    const ts=Math.floor(Date.now()/1000);
    const sign=await hmac(pkey,String(pid)+TOKEN_PATH+ts);

    const tr=await fetch(HOST+TOKEN_PATH,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        code,
        shop_id:sid,
        partner_id:pid,
        timestamp:ts,
        sign
      })
    });
    const traw=await responseText(tr);
    let td:any=null;
    try{td=JSON.parse(traw);}catch{}

    if(!tr.ok||td?.error||!td?.access_token){
      console.error(JSON.stringify({
        service:"sellerbooks-shopee-oauth",
        event:"token_exchange_failed",
        shop_id:sid,
        status:tr.status,
        detail:safeUpstream(traw)
      }));
      return fail("TOKEN_EXCHANGE_FAILED");
    }

    const its=Math.floor(Date.now()/1000);
    const isign=await hmac(pkey,String(pid)+INFO_PATH+its+td.access_token+sid);
    const iu=new URL(HOST+INFO_PATH);
    for(const [k,v] of Object.entries({
      partner_id:pid,
      timestamp:its,
      access_token:td.access_token,
      shop_id:sid,
      sign:isign
    }))iu.searchParams.set(k,String(v));

    const ir=await fetch(iu);
    const iraw=await responseText(ir);
    let info:any=null;
    try{info=JSON.parse(iraw);}catch{}

    if(!ir.ok||info?.error){
      console.error(JSON.stringify({
        service:"sellerbooks-shopee-oauth",
        event:"shop_verify_failed",
        shop_id:sid,
        status:ir.status,
        detail:safeUpstream(iraw)
      }));
      return fail("SHOP_VERIFY_FAILED");
    }

    const verified=String(info?.response?.shop_id??sid);
    if(verified!==String(sid))return fail("SHOP_ID_VERIFY_MISMATCH");

    let st:any=null;

    if(state){
      const c=await rpc(base,secret,"sellerbooks_api_consume_oauth_state",{
        p_state_hash:await digest(state)
      });
      const craw=await responseText(c);
      let rows:any[]=[];
      try{rows=JSON.parse(craw);}catch{}
      st=rows?.[0]||null;
    }

    /*
      Shopee's documented callback examples return code + shop_id.
      If state is not echoed back by the authorization page, fall back
      to the newest unconsumed state for this shop. The state is still
      one-time and expires after 10 minutes.
    */
    if(!st){
      st=await findPendingState(base,secret,verified);
      if(st){
        const c=await rpc(base,secret,"sellerbooks_api_consume_oauth_state",{
          p_state_hash:st.state_hash
        });
        const craw=await responseText(c);
        let rows:any[]=[];
        try{rows=JSON.parse(craw);}catch{}
        st=rows?.[0]||null;
      }
    }

    if(!st?.connection_id){
      console.error(JSON.stringify({
        service:"sellerbooks-shopee-oauth",
        event:"state_resolution_failed",
        shop_id:verified
      }));
      return fail("STATE_INVALID_OR_EXPIRED");
    }

    if(String(st.store_id)!==verified)return fail("SHOP_ID_MISMATCH");

    const credential=JSON.stringify({
      provider:"shopee",
      auth_type:"oauth",
      partner_id:pid,
      shop_id:sid,
      access_token:td.access_token,
      refresh_token:td.refresh_token||"",
      expire_in:td.expire_in||null,
      token_received_at:new Date().toISOString(),
      api_base_url:HOST
    });

    const done=await rpc(base,secret,"sellerbooks_api_complete_shopee_oauth",{
      p_connection_id:st.connection_id,
      p_store_id:st.store_id,
      p_shop_id:verified,
      p_credential:credential,
      p_shop_name:info?.response?.shop_name||null
    });

    if(!done.ok){
      const draw=await responseText(done);
      console.error(JSON.stringify({
        service:"sellerbooks-shopee-oauth",
        event:"connection_finalization_failed",
        connection_id:st.connection_id,
        shop_id:verified,
        status:done.status,
        detail:safeUpstream(draw)
      }));
      return fail("CONNECTION_FINALIZATION_FAILED");
    }

    const ok=new URL(app);
    ok.searchParams.set("sellerbooks_shopee_oauth","success");
    ok.searchParams.set("connection_id",st.connection_id);
    ok.searchParams.set("shop_id",verified);
    return Response.redirect(ok.toString(),302);
  }catch(e){
    console.error(JSON.stringify({
      service:"sellerbooks-shopee-oauth",
      event:"callback_failed",
      error:e instanceof Error?e.message:"UNKNOWN"
    }));
    return fail("OAUTH_FAILED");
  }
}

Deno.serve(async r=>{
  if(r.method==="OPTIONS")return new Response("ok",{headers:CORS});
  try{
    const a=new URL(r.url).searchParams.get("action");
    if(r.method==="POST"&&(a==="init"||!a))return await init(r);
    if(r.method==="GET"&&a==="callback")return await callback(r);
    return out({ok:false,error:"Invalid OAuth action."},400);
  }catch(e){
    console.error(JSON.stringify({
      service:"sellerbooks-shopee-oauth",
      event:"request_failed",
      error:e instanceof Error?e.message:"UNKNOWN"
    }));
    return out({ok:false,error:"OAuth service configuration error.",stage:"request"},500);
  }
});
