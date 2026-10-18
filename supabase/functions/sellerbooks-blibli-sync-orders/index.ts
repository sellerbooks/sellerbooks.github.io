import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const SUPABASE_URL="https://fysaxpqpqexjnlpkbwap.supabase.co";
const BASE="https://api.blibli.com/v2";
const out=(x:unknown,n=200)=>new Response(JSON.stringify(x),{status:n,headers:{...CORS,"Content-Type":"application/json"}});
const bearer=(r:Request)=>{const h=r.headers.get("Authorization")||"";return h.toLowerCase().startsWith("bearer ")?h.slice(7).trim():"";};
const rest=async(k:string,p:string,i:RequestInit={})=>{const h=new Headers(i.headers);h.set("apikey",k);h.set("Authorization","Bearer "+k);h.set("Content-Type","application/json");return fetch(SUPABASE_URL+"/rest/v1/"+p,{...i,headers:h});};
const text=async(r:Response)=>{try{return await r.text();}catch{return "";}};
const raw=(...v:any[])=>{for(const x of v)if(x!==undefined&&x!==null&&String(x).trim()!=="")return x;return "";};
const iso=(v:any)=>{const n=Number(v);if(Number.isFinite(n)&&n>100000000)return new Date(n).toISOString();const d=new Date(String(v||""));return Number.isNaN(d.getTime())?"":d.toISOString();};
const headers=["Nomor Pesanan","SKU Seller","Total Produk","Jumlah Produk","Nomor Resi/AWB","Harga Produk","Tanggal Pesanan","Status Pesanan","ID Paket"];
function rowFor(pkg:any,item:any){
 const orderNo=raw(item?.orderNo,item?.orderNumber,item?.orderId,item?.orderItemId,pkg?.orderNo,pkg?.orderNumber,pkg?.orderId,pkg?.packageId,pkg?.id);
 const sku=raw(item?.sellerSku,item?.sellerSKU,item?.sellerSkuCode,item?.skuSeller,item?.sku);
 const qty=Math.max(0,Number(raw(item?.qty,item?.quantity,item?.itemQuantity,item?.orderedQuantity,1))||1);
 const price=Number(raw(item?.price?.sellingPrice,item?.sellingPrice,item?.sellingPriceAfterDiscount,item?.price,item?.unitPrice,item?.regularPrice,0))||0;
 const created=iso(raw(item?.createdDate,item?.orderCreatedDate,item?.orderDate,pkg?.createdDate,pkg?.orderCreatedDate,pkg?.orderDate));
 const awb=raw(item?.awbNumber,item?.trackingNumber,item?.shippingLabelNumber,pkg?.awbNumber,pkg?.trackingNumber,pkg?.shippingLabelNumber);
 const status=raw(item?.orderItemStatus,item?.status,pkg?.status);
 const packageId=raw(item?.packageId,pkg?.packageId,pkg?.id);
 return [orderNo,sku,price*qty,qty,awb,price,created,status,packageId];
}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
 if(req.method!=="POST")return out({ok:false,error:"Method not allowed"},405);
 try{
  const pk=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}").default;
  const sk=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default;
  const token=bearer(req);
  if(!pk||!sk||!token)return out({ok:false,error:"Authentication/configuration error"},401);
  const ur=await fetch(SUPABASE_URL+"/auth/v1/user",{headers:{apikey:pk,Authorization:"Bearer "+token}});
  const user=ur.ok?await ur.json():null;
  if(!user?.id)return out({ok:false,error:"Invalid or expired session"},401);
  let b:any={};try{b=await req.json();}catch{}
  const connectionId=String(b.connection_id||"").trim();
  const storeId=String(b.store_id||"").trim();
  if(!connectionId||!storeId)return out({ok:false,error:"connection_id and store_id are required"},400);
  const cr=await rest(sk,"sellerbooks_api_connections?id=eq."+encodeURIComponent(connectionId)+"&owner_user_id=eq."+encodeURIComponent(user.id)+"&select=id,owner_user_id,store_id,marketplace,marketplace_id,connection_status,vault_secret_id");
  if(!cr.ok)return out({ok:false,error:"Gagal memeriksa koneksi Blibli"},500);
  const cs=await cr.json();const c=Array.isArray(cs)?cs[0]:null;
  if(!c)return out({ok:false,error:"API connection not found"},404);
  if(String(c.store_id)!==storeId)return out({ok:false,error:"Store tidak cocok dengan koneksi Blibli"},403);
  if(String(c.marketplace||c.marketplace_id||"").toLowerCase()!=="blibli")return out({ok:false,error:"This function only supports Blibli"},400);
  if(String(c.connection_status||"").toUpperCase()!=="CONNECTED")return out({ok:false,error:"Akun Blibli belum terintegrasi"},400);
  if(!c.vault_secret_id)return out({ok:false,error:"Kredensial Blibli tidak ditemukan di Vault"},400);
  const vr=await rest(sk,"rpc/sellerbooks_get_vault_secret",{method:"POST",body:JSON.stringify({p_secret_id:c.vault_secret_id})});
  if(!vr.ok)return out({ok:false,error:"Gagal membaca kredensial Blibli dari Vault"},500);
  const v=await vr.json();const secretText=Array.isArray(v)?v[0]?.decrypted_secret:null;
  if(!secretText)return out({ok:false,error:"Kredensial Blibli tidak ditemukan di Vault"},400);
  let cred:any;try{cred=JSON.parse(secretText);}catch{return out({ok:false,error:"Format kredensial Blibli tidak valid"},400);}
  const clientId=String(cred.api_client_id||Deno.env.get("BLIBLI_API_CLIENT_ID")||"").trim();
  const clientKey=String(cred.api_client_key||Deno.env.get("BLIBLI_API_CLIENT_KEY")||"").trim();
  const sellerKey=String(cred.api_seller_key||"").trim(),storeCode=String(cred.store_code||"").trim(),username=String(cred.username||"").trim();
  const blibliStoreId=String(cred.store_id||"10001").trim(),channelId=String(cred.channel_id||"SellerBooks MBI").trim();
  if(!clientId||!clientKey||!sellerKey||!storeCode||!username)return out({ok:false,error:"Konfigurasi kredensial Blibli belum lengkap"},400);
  // Blibli-only filter: fetch new orders waiting for seller response (FP).
  // No date range: older orders still in FP remain eligible for manual sync.
  const all:any[]=[];let page=0,totalPages=1;
  while(page<totalPages&&page<90){
   const query=new URLSearchParams({storeCode,username,requestId:"sellerbooks-"+crypto.randomUUID(),storeId:blibliStoreId,channelId});
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);
   let response:Response,bodyText="";
   try{
    response=await fetch(BASE+"/proxy/seller/v1/orders/packages/filter?"+query.toString(),{method:"POST",redirect:"manual",headers:{"Authorization":"Basic "+btoa(clientId+":"+clientKey),"Accept":"application/json","Content-Type":"application/json","Api-Seller-Key":sellerKey},body:JSON.stringify({filter:{orderItemStatuses:["FP"]},sorting:{by:"statusFPUpdatedTimestamp",direction:"ASC"},paging:{page,size:50}}),signal:controller.signal});
    bodyText=await response.text();
   }finally{clearTimeout(timer);}
   let data:any;try{data=JSON.parse(bodyText);}catch{data={raw:bodyText.slice(0,300)};}
   if(!response!.ok||data?.errorMessage||data?.errorCode)throw Error("BLIBLI_API_ERROR HTTP "+response!.status+": "+String(data?.errorMessage||data?.message||data?.raw||data?.errorCode||"Unknown response").slice(0,250));
   const packages=Array.isArray(data?.content)?data.content:[];
   all.push(...packages);
   const p=data?.paging||{};totalPages=Number(p.totalPage??p.totalPages??(packages.length===50?page+2:page+1))||page+1;
   if(!packages.length)break;
   page++;
  }
  const rows:any[]=[];
  const seenItems=new Set<string>();
  const seenOrderIds=new Set<string>();
  for(const pkg of all){
   const items=Array.isArray(pkg?.orderItems)?pkg.orderItems:(Array.isArray(pkg?.items)?pkg.items:[]);
   for(const item of items){
    // Defensive check in case upstream returns statuses outside the requested filter.
    const status=String(raw(item?.orderItemStatus,item?.status,pkg?.status)||"").trim().toUpperCase();
    if(status && status!=="FP")continue;
    const row=rowFor(pkg,item);
    const orderId=String(row[0]||"").trim();
    const sku=String(row[1]||"").trim();
    if(!orderId||!sku)continue;
    seenOrderIds.add(orderId);
    // Deduplicate repeated API results but preserve distinct item rows within one order.
    const itemId=String(raw(item?.id,item?.orderItemId,item?.orderItemNumber,item?.itemId,item?.sellerSku,item?.sellerSKU,sku));
    const uniqueKey=orderId+"|"+itemId;
    if(seenItems.has(uniqueKey))continue;
    seenItems.add(uniqueKey);
    rows.push(row);
   }
  }
  if(!rows.length)return out({ok:true,marketplace:"Blibli",status:"NO_ORDERS",orders_found:seenOrderIds.size,rows_found:0,filter_status:"FP"});
  const fileName="AUTO-SYNC-BLIBLI-"+new Date().toISOString()+".xlsx";
  const qr=await rest(sk,"sellerbooks_api_import_queue",{method:"POST",headers:{"Prefer":"return=representation"},body:JSON.stringify({owner_user_id:String(c.owner_user_id),connection_id:String(c.id),store_id:String(c.store_id),marketplace:"Blibli",file_name:fileName,file_type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",headers,rows,status:"PENDING"})});
  if(!qr.ok)throw Error("API_IMPORT_QUEUE_INSERT_FAILED:"+String(await text(qr)).slice(0,300));
  const queued=await qr.json();const item=Array.isArray(queued)?queued[0]:queued;
  const nowIso=new Date().toISOString();
  await rest(sk,"sellerbooks_api_connections?id=eq."+encodeURIComponent(c.id),{method:"PATCH",body:JSON.stringify({last_sync_at:nowIso,last_success_at:nowIso,last_error:null,updated_at:nowIso})});
  return out({ok:true,marketplace:"Blibli",status:"RAW_FILE_READY",filter_status:"FP",orders_found:seenOrderIds.size,rows_found:rows.length,queue_id:item?.id||null,file_name:fileName,engine:"SELLERBOOKS_IMPORT_PENJUALAN"});
 }catch(e){return out({ok:false,error:e instanceof Error?e.message:"Unexpected server error"},500);}
});