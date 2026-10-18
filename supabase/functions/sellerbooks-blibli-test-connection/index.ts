import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BASE = "https://api.blibli.com/v2";
const out = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const tokenOf = (req: Request) => {
  const h = req.headers.get("Authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
};
async function rest(url: string, key: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("Authorization", "Bearer " + key);
  headers.set("Content-Type", "application/json");
  return fetch(url + "/rest/v1/" + path, { ...init, headers });
}
async function getUser(url: string, key: string, token: string) {
  const r = await fetch(url + "/auth/v1/user", { headers: { apikey: key, Authorization: "Bearer " + token } });
  return r.ok ? await r.json() : null;
}
Deno.serve(async (req) => {
  const correlationId = crypto.randomUUID();
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return out({ ok: false, error: "Method not allowed", correlation_id: correlationId }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const publishableKey = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}").default;
    const secretKey = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default;
    const token = tokenOf(req);
    if (!supabaseUrl || !publishableKey || !secretKey || !token) {
      return out({ ok: false, error: "Authentication/configuration error", correlation_id: correlationId }, 401);
    }
    const user = await getUser(supabaseUrl, publishableKey, token);
    if (!user?.id) return out({ ok: false, error: "Invalid or expired session", correlation_id: correlationId }, 401);

    let body: any = {};
    try { body = await req.json(); } catch {}
    const connectionId = String(body.connection_id || "").trim();
    if (!connectionId) return out({ ok: false, error: "connection_id is required", correlation_id: correlationId }, 400);

    const cr = await rest(supabaseUrl, secretKey,
      "sellerbooks_api_connections?id=eq." + encodeURIComponent(connectionId) +
      "&owner_user_id=eq." + encodeURIComponent(user.id) + "&select=id,owner_user_id,store_id,marketplace_id,marketplace,vault_secret_id");
    const rows = await cr.json();
    const connection = Array.isArray(rows) ? rows[0] : null;
    if (!connection) return out({ ok: false, error: "API connection not found", correlation_id: correlationId }, 404);
    if (String(connection.marketplace_id || "").toLowerCase() !== "blibli" &&
        String(connection.marketplace || "").toLowerCase() !== "blibli") {
      return out({ ok: false, error: "This function only supports Blibli", correlation_id: correlationId }, 400);
    }
    if (!connection.vault_secret_id) {
      return out({ ok: false, error: "Kredensial Blibli belum tersimpan di Vault", correlation_id: correlationId }, 400);
    }

    
    // Read the secret through a restricted server-side RPC.
    const vaultResponse = await rest(
      supabaseUrl,
      secretKey,
      "rpc/sellerbooks_get_vault_secret",
      {
        method: "POST",
        body: JSON.stringify({
          p_secret_id: connection.vault_secret_id,
        }),
      },
    );

    if (!vaultResponse.ok) {
      return out({
        ok: false,
        error: "Gagal membaca kredensial Blibli dari Vault",
        correlation_id: correlationId,
      }, 500);
    }

    const vaultRows = await vaultResponse.json();
    const secretText = Array.isArray(vaultRows)
      ? vaultRows[0]?.decrypted_secret
      : null;

    if (!secretText) {
      return out({
        ok: false,
        error: "Kredensial Blibli tidak ditemukan di Vault",
        correlation_id: correlationId,
      }, 400);
    }


    let c: any;
    try { c = JSON.parse(secretText); } catch {
      return out({ ok: false, error: "Format kredensial Blibli tidak valid", correlation_id: correlationId }, 400);
    }
    const clientId = String(c.api_client_id || Deno.env.get("BLIBLI_API_CLIENT_ID") || "").trim();
    const clientKey = String(c.api_client_key || Deno.env.get("BLIBLI_API_CLIENT_KEY") || "").trim();
    const sellerKey = String(c.api_seller_key || "").trim();
    const storeCode = String(c.store_code || "").trim();
    const username = String(c.username || "").trim();
    const storeId = String(c.store_id || "10001").trim();
    const channelId = String(c.channel_id || "SellerBooks MBI").trim();
    if (!clientId || !clientKey) {
      return out({ ok: false, error: "Kredensial platform Blibli SellerBooks belum dikonfigurasi di Supabase Edge Function Secrets.", correlation_id: correlationId }, 500);
    }
    if (!sellerKey || !storeCode || !username || !storeId || !channelId) {
      return out({ ok: false, error: "Lengkapi API Seller Key, kode toko, username, Store ID, dan Channel ID.", correlation_id: correlationId }, 400);
    }

    const requestId = "sellerbooks-" + crypto.randomUUID();
    const query = new URLSearchParams({ storeCode, username, requestId, storeId, channelId });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    let raw = "";
    try {
      response = await fetch(BASE + "/proxy/seller/v1/orders/packages/filter?" + query.toString(), {
        redirect: "manual",
        method: "POST",
        headers: {
          "Authorization": "Basic " + btoa(clientId + ":" + clientKey),
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Api-Seller-Key": sellerKey,
        },
        body: JSON.stringify({
          filter: {},
          sorting: { by: "statusFPUpdatedTimestamp", direction: "ASC" },
          paging: { page: 0, size: 1 },
        }),
        signal: controller.signal,
      });
      raw = await response.text();
    } catch (e) {
      const msg = e instanceof Error && e.name === "AbortError" ? "Permintaan ke Blibli timeout (15 detik)" : "Tidak dapat menghubungi Blibli Seller API";
      return out({ ok: false, error: msg, correlation_id: correlationId }, 502);
    } finally {
      clearTimeout(timer);
    }

    let payload: any = null;
    try { payload = JSON.parse(raw); } catch { payload = { raw: raw.slice(0, 500) }; }
    if (!response.ok) {
      
const safeMessage = String(
  payload?.message ||
  payload?.errorMessage ||
  payload?.error ||
  payload?.raw ||
  ("Blibli HTTP " + response.status)
).slice(0, 250) + " [server=" + (response.headers.get("server") || "n/a") + "; location=" + (response.headers.get("location") || "none") + "]";

      await rest(supabaseUrl, secretKey, "sellerbooks_api_connections?id=eq." + encodeURIComponent(connectionId), {
        method: "PATCH", body: JSON.stringify({ connection_status: "ERROR", last_error: safeMessage, updated_at: new Date().toISOString() }),
      });
      return out({
        ok: false,
        status: "ERROR",
        http_status: response.status,
        error: safeMessage,
        redirect_location: response.headers.get("location"),
        response_server: response.headers.get("server"),
        response_content_type: response.headers.get("content-type"),
        correlation_id: correlationId
      }, 400);
    }

    const now = new Date().toISOString();
    await rest(supabaseUrl, secretKey, "sellerbooks_api_connections?id=eq." + encodeURIComponent(connectionId), {
      method: "PATCH", body: JSON.stringify({ connection_status: "CONNECTED", last_success_at: now, last_error: null, updated_at: now }),
    });
    const content = Array.isArray(payload?.content) ? payload.content : [];
    return out({
      ok: true, status: "CONNECTED", marketplace: "Blibli", connection_id: connectionId,
      correlation_id: correlationId, store_code: storeCode, sample_packages: content.length,
      message: "Autentikasi Blibli berhasil. Data pesanan belum diimpor.",
    });
  } catch (e) {
    return out({ ok: false, error: e instanceof Error ? e.message : "Unexpected server error", correlation_id: correlationId }, 500);
  }
});
