import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const TOCO_API = "https://partners-api.tocobagus.net/api/v1";
const encoder = new TextEncoder();
const out = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error("CONFIG_MISSING_" + name);
  return value;
};
const bearer = (r: Request) => {
  const h = r.headers.get("Authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
};
const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
async function sha256(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
function base64UrlBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
async function signToco(method: string, path: string, timestamp: string, bodyText = "") {
  const partnerId = env("TOCO_PARTNER_CLIENT_ID");
  const secret = env("TOCO_PARTNER_SECRET_KEY");
  const bodyHash = await sha256(bodyText);
  const lines = [
    method.toUpperCase(),
    path,
    "x-partner-client-id:" + partnerId,
    "x-timestamp:" + timestamp,
    bodyHash,
  ];
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(lines.join("\n")))));
  return { partnerId, signature: "sha256=" + signature };
}
async function tocoRequest(method: string, path: string, bodyText = "") {
  const timestamp = String(Date.now());
  const signed = await signToco(method, path, timestamp, bodyText);
  const headers: Record<string, string> = {
    "x-partner-client-id": signed.partnerId,
    "x-timestamp": timestamp,
    "x-signature": signed.signature,
    "Content-Type": "application/json",
  };
  return fetch(TOCO_API + path, { method, headers, ...(method === "GET" ? {} : { body: bodyText }) });
}
async function rest(base: string, key: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("Authorization", "Bearer " + key);
  headers.set("Content-Type", "application/json");
  return fetch(base + "/rest/v1/" + path, { ...init, headers });
}
async function rpc(base: string, key: string, name: string, body: unknown) {
  return rest(base, key, "rpc/" + name, { method: "POST", body: JSON.stringify(body) });
}
async function getUser(base: string, key: string, token: string) {
  if (!token) return null;
  const r = await fetch(base + "/auth/v1/user", { headers: { apikey: key, Authorization: "Bearer " + token } });
  return r.ok ? await r.json() : null;
}
async function readText(r: Response) { try { return await r.text(); } catch { return ""; } }
function upstreamMessage(raw: string) {
  try { const x = JSON.parse(raw); return String(x?.error?.message || x?.error?.code || x?.message || x?.error || ""); }
  catch { return ""; }
}
async function decryptStoreAccess(value: string) {
  if (!value.startsWith("ENCRYPTED:")) throw new Error("TOCO_CREDENTIAL_ENVELOPE_INVALID");
  const encoded = value.slice("ENCRYPTED:".length);
  const envelope = JSON.parse(new TextDecoder().decode(base64UrlBytes(encoded)));
  if (envelope?.v !== 1 || envelope?.alg !== "A256GCM") throw new Error("TOCO_ENVELOPE_UNSUPPORTED");
  const rawKey = Uint8Array.from(atob(env("TOCO_ENCRYPTION_KEY")), c => c.charCodeAt(0));
  if (rawKey.length !== 32) throw new Error("TOCO_ENCRYPTION_KEY_MUST_DECODE_TO_32_BYTES");
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = base64UrlBytes(envelope.iv);
  const tag = base64UrlBytes(envelope.tag);
  const ciphertext = base64UrlBytes(envelope.data);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, combined);
  return JSON.parse(new TextDecoder().decode(plain));
}
async function init(r: Request) {
  const base = env("SUPABASE_URL");
  const pub = env("SUPABASE_PUBLISHABLE_KEY");
  const service = env("SUPABASE_SECRET_KEY");
  const user = await getUser(base, pub, bearer(r));
  if (!user?.id) return out({ ok: false, error: "Sesi SellerBooks tidak valid. Silakan login kembali.", stage: "session" }, 401);

  const body = await r.json().catch(() => ({}));
  const storeId = String(body.store_id || "").trim();
  const marketplaceId = String(body.marketplace_id || "").trim();
  if (!storeId || !marketplaceId) return out({ ok: false, error: "store_id dan marketplace_id wajib.", stage: "request" }, 400);

  const connRes = await rpc(base, pub, "sellerbooks_api_upsert_connection", {
    p_store_id: storeId, p_marketplace_id: marketplaceId, p_marketplace: "Toco",
  });
  const connRaw = await readText(connRes);
  let connection: any = null;
  try { connection = JSON.parse(connRaw); } catch {}
  if (!connRes.ok || !connection?.id) {
    console.error(JSON.stringify({ service: "sellerbooks-toco", event: "connection_init_failed", user_id: user.id, status: connRes.status, detail: upstreamMessage(connRaw) }));
    return out({ ok: false, error: upstreamMessage(connRaw) || "Koneksi Toco tidak dapat dibuat.", stage: "upsert_connection" }, 400);
  }

  const state = crypto.randomUUID() + "." + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const stateRes = await rpc(base, service, "sellerbooks_api_create_oauth_state", {
    p_owner_user_id: user.id, p_store_id: storeId, p_connection_id: connection.id,
    p_state_hash: await sha256(state), p_expires_at: expiresAt,
  });
  const stateRaw = await readText(stateRes);
  if (!stateRes.ok) {
    console.error(JSON.stringify({ service: "sellerbooks-toco", event: "state_create_failed", user_id: user.id, status: stateRes.status, detail: upstreamMessage(stateRaw) }));
    return out({ ok: false, error: "Gagal menyiapkan sesi aman integrasi Toco.", stage: "create_state" }, 500);
  }

  const redirect = new URL("https://sellerbooks.amasaindonesia.com/toco-oauth-callback.html");
  redirect.searchParams.set("store_id", storeId);
  redirect.searchParams.set("marketplace_id", marketplaceId);
  redirect.searchParams.set("state", state);
  const requestBody = JSON.stringify({ redirectUri: redirect.toString() });
  const response = await tocoRequest("POST", "/partner/onboard/sessions", requestBody);
  const raw = await readText(response);
  let data: any = null;
  try { data = JSON.parse(raw); } catch {}
  if (!response.ok || !data?.onboardUrl || !data?.sid) {
    console.error(JSON.stringify({ service: "sellerbooks-toco", event: "onboard_session_failed", user_id: user.id, status: response.status, request_id: data?.requestId || null, detail: upstreamMessage(raw) }));
    return out({ ok: false, error: upstreamMessage(raw) || "Toco gagal membuat sesi onboarding.", stage: "toco_onboard", status: response.status, request_id: data?.requestId || null }, 502);
  }
  return out({ ok: true, authorization_url: data.onboardUrl, expires_at: expiresAt });
}
async function complete(r: Request) {
  const base = env("SUPABASE_URL");
  const service = env("SUPABASE_SECRET_KEY");
  const body = await r.json().catch(() => ({}));
  const state = String(body.state || "");
  const sid = String(body.sid || "");
  const encrypted = String(body.storeAccess || "");
  if (!state || !sid || !encrypted) return out({ ok: false, error: "Data callback Toco tidak lengkap." }, 400);

  const stateRes = await rpc(base, service, "sellerbooks_api_consume_oauth_state_v2", { p_state_hash: await sha256(state) });
  const stateRaw = await readText(stateRes);
  let rows: any = null;
  try { rows = JSON.parse(stateRaw); } catch {}
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!stateRes.ok || !row?.connection_id) {
    return out({ ok: false, error: "Sesi integrasi Toco tidak valid atau sudah kedaluwarsa." }, 400);
  }

  let store: any;
  try { store = await decryptStoreAccess(encrypted); }
  catch (e) {
    console.error(JSON.stringify({ service: "sellerbooks-toco", event: "credential_decryption_failed", sid, error: e instanceof Error ? e.message : "UNKNOWN" }));
    return out({ ok: false, error: "Kredensial Toco tidak dapat diverifikasi. Periksa Encryption Key di secret server." }, 400);
  }
  if (!store?.clientId || !store?.token) return out({ ok: false, error: "Kredensial toko Toco tidak memiliki clientId/token." }, 400);

  const credential = JSON.stringify({
    provider: "Toco", store_client_id: String(store.clientId), store_token: String(store.token),
    store_name: String(store.name || ""), store_url: String(store.storeUrl || ""),
    expires_at: store.expiresAt || null, onboard_session_id: sid,
    connected_at: new Date().toISOString(), api_base_url: TOCO_API,
  });
  const done = await rpc(base, service, "sellerbooks_api_complete_marketplace_oauth", {
    p_connection_id: row.connection_id,
    p_store_id: row.store_id,
    p_marketplace: "Toco",
    p_external_store_id: row.store_id,
    p_credential: credential,
  });
  const doneRaw = await readText(done);
  if (!done.ok) {
    console.error(JSON.stringify({ service: "sellerbooks-toco", event: "connection_finalization_failed", sid, status: done.status, detail: upstreamMessage(doneRaw) }));
    return out({ ok: false, error: "Kredensial diterima, tetapi penyimpanan koneksi SellerBooks gagal." }, 500);
  }
  return out({ ok: true, store_name: String(store.name || "Toco"), store_url: String(store.storeUrl || "") });
}
Deno.serve(async (r: Request) => {
  if (r.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const action = new URL(r.url).searchParams.get("action") || (r.method === "GET" ? "health" : "init");
    if (action === "health") return out({ ok: true, service: "sellerbooks-toco", message: "Toco connector endpoint is reachable." });
    if (r.method !== "POST") return out({ ok: false, error: "Method not allowed." }, 405);
    if (action === "init") return await init(r);
    if (action === "complete") return await complete(r);
    return out({ ok: false, error: "Invalid Toco action." }, 400);
  } catch (e) {
    console.error(JSON.stringify({ service: "sellerbooks-toco", event: "request_failed", error: e instanceof Error ? e.message : "UNKNOWN" }));
    return out({ ok: false, error: "Layanan integrasi Toco mengalami kesalahan konfigurasi." }, 500);
  }
});
