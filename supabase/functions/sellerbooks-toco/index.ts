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
  if (value) return value;
  const aliases: Record<string, string> = {
    SUPABASE_PUBLISHABLE_KEY: "SUPABASE_ANON_KEY",
    SUPABASE_SECRET_KEY: "SUPABASE_SERVICE_ROLE_KEY",
  };
  const alias = aliases[name];
  if (alias && Deno.env.get(alias)) return Deno.env.get(alias)!;
  if (name === "SUPABASE_PUBLISHABLE_KEY") {
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
      if (keys.default) return keys.default;
    } catch {}
  }
  if (name === "SUPABASE_SECRET_KEY") {
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      if (keys.default) return keys.default;
    } catch {}
  }
  throw new Error("CONFIG_MISSING_" + name);
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
async function signToco(
  method: string, path: string, timestamp: string, bodyText = "",
  storeClientId = "", storeToken = "",
) {
  const partnerId = env("TOCO_PARTNER_CLIENT_ID");
  const secret = env("TOCO_PARTNER_SECRET_KEY");
  const bodyHash = await sha256(bodyText);
  const canonicalHeaders: Record<string, string> = {
    "x-partner-client-id": partnerId,
    "x-timestamp": timestamp,
  };
  if (storeClientId) canonicalHeaders["x-store-client-id"] = storeClientId;
  if (storeToken) canonicalHeaders["x-store-token"] = storeToken;
  const lines = [
    method.toUpperCase(),
    path.split("?")[0],
    ...Object.keys(canonicalHeaders).sort().map(name => name + ":" + canonicalHeaders[name]),
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
async function tocoStoreGet(path: string, storeClientId: string, storeToken: string, signal?: AbortSignal) {
  const timestamp = String(Date.now());
  const signed = await signToco("GET", path, timestamp, "", storeClientId, storeToken);
  return fetch(TOCO_API + path, {
    method: "GET",
    signal,
    headers: {
      "x-partner-client-id": signed.partnerId,
      "x-store-client-id": storeClientId,
      "x-store-token": storeToken,
      "x-timestamp": timestamp,
      "x-signature": signed.signature,
      "Accept": "application/json",
    },
  });
}
async function syncOrders(r: Request) {
  const base = env("SUPABASE_URL");
  const pub = env("SUPABASE_PUBLISHABLE_KEY");
  const service = env("SUPABASE_SECRET_KEY");
  const user = await getUser(base, pub, bearer(r));
  if (!user?.id) return out({ ok: false, error: "Sesi SellerBooks tidak valid. Silakan login kembali." }, 401);

  const body = await r.json().catch(() => ({}));
  const connectionId = String(body.connection_id || "").trim();
  const storeId = String(body.store_id || "").trim();
  if (!connectionId || !storeId) return out({ ok: false, error: "connection_id dan store_id wajib." }, 400);

  const connRes = await rest(base, service,
    "sellerbooks_api_connections?id=eq." + encodeURIComponent(connectionId) +
    "&owner_user_id=eq." + encodeURIComponent(user.id) +
    "&select=id,owner_user_id,store_id,marketplace,marketplace_id,connection_status,vault_secret_id");
  if (!connRes.ok) return out({ ok: false, error: "Gagal memeriksa koneksi Toco." }, 500);
  const connRows = await connRes.json().catch(() => []);
  const conn = Array.isArray(connRows) ? connRows[0] : null;
  if (!conn) return out({ ok: false, error: "Koneksi Toco tidak ditemukan." }, 404);
  if (String(conn.store_id) !== storeId) return out({ ok: false, error: "Toko tidak cocok dengan koneksi Toco." }, 403);
  if (String(conn.marketplace || "").toLowerCase() !== "toco") return out({ ok: false, error: "Koneksi ini bukan Toco." }, 400);
  if (String(conn.connection_status || "").toUpperCase() !== "CONNECTED") return out({ ok: false, error: "Akun Toco belum terintegrasi." }, 400);
  if (!conn.vault_secret_id) return out({ ok: false, error: "Kredensial Toco tidak ditemukan di Vault." }, 400);

  const vaultRes = await rpc(base, service, "sellerbooks_get_vault_secret", { p_secret_id: conn.vault_secret_id });
  if (!vaultRes.ok) return out({ ok: false, error: "Gagal membaca kredensial Toco dari Vault." }, 500);
  const vaultValue = await vaultRes.json().catch(() => null);
  const secretText = Array.isArray(vaultValue) ? vaultValue[0]?.decrypted_secret : vaultValue?.decrypted_secret;
  if (!secretText) return out({ ok: false, error: "Kredensial Toco tidak tersedia di Vault." }, 400);
  let credential: any;
  try { credential = JSON.parse(secretText); } catch { return out({ ok: false, error: "Format kredensial Toco tidak valid." }, 400); }
  const storeClientId = String(credential.store_client_id || "").trim();
  const storeToken = String(credential.store_token || "").trim();
  if (!storeClientId || !storeToken) return out({ ok: false, error: "Kredensial akses toko Toco belum lengkap." }, 400);

  const allOrders: any[] = [];
  let page = 1;
  let totalPages = 1;
  const limit = 100;
  while (page <= totalPages && page <= 100) {
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    const path = "/partner/stores/orders?" + query.toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let response: Response;
    let raw = "";
    try {
      response = await tocoStoreGet(path, storeClientId, storeToken, controller.signal);
      raw = await response.text();
    } catch (error) {
      const timedOut = controller.signal.aborted;
      console.error(JSON.stringify({
        service: "sellerbooks-toco", event: "orders_fetch_network_error",
        user_id: user.id, store_id: storeId, page, timed_out: timedOut,
        error: error instanceof Error ? error.name : "UNKNOWN",
      }));
      return out({
        ok: false,
        error: timedOut
          ? "Permintaan pesanan Toco melewati batas waktu 20 detik. Silakan coba lagi."
          : "Tidak dapat terhubung ke API Toco. Periksa koneksi lalu coba lagi.",
        stage: "orders_fetch",
        timed_out: timedOut,
      }, timedOut ? 504 : 502);
    } finally { clearTimeout(timer); }
    let payload: any;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!response!.ok || payload?.success === false || !Array.isArray(payload?.data)) {
      const detail = upstreamMessage(raw);
      console.error(JSON.stringify({ service: "sellerbooks-toco", event: "orders_fetch_failed", user_id: user.id, store_id: storeId, status: response!.status, page, request_id: payload?.requestId || null, detail }));
      return out({ ok: false, error: detail || "Gagal mengambil pesanan Toco.", stage: "orders_fetch", status: response!.status, request_id: payload?.requestId || null }, 502);
    }
    allOrders.push(...payload.data);
    const pagination = payload.pagination || {};
    totalPages = Math.max(1, Number(pagination.totalPages || (payload.data.length < limit ? page : page + 1)) || 1);
    if (!payload.data.length) break;
    page++;
  }
  if (page <= totalPages && page > 100) {
    return out({ ok: false, error: "Sinkronisasi dihentikan karena pesanan Toco melebihi batas aman 100 halaman (maksimal 10.000 pesanan). Belum ada pesanan yang dimasukkan ke antrean; dukungan sinkronisasi bertahap diperlukan untuk akun sebesar ini." }, 413);
  }

  // The list endpoint's published sample omits SKU. Resolve missing SKU via the
  // documented order-detail endpoint, which includes productId/externalId/sku.
  const skuFromItem = (item: any) => String(item?.sellerSku || item?.sellerSKU || item?.sku || item?.productSku || item?.product?.sku || item?.variant?.sku || "").trim();
  const detailByOrder = new Map<string, any>();
  const detailFailures: string[] = [];
  const ordersNeedingDetail = allOrders.filter((order) =>
    !Array.isArray(order?.items) ||
    order.items.length === 0 ||
    order.items.some((item: any) =>
      !skuFromItem(item) ||
      item?.paidAmount === null ||
      item?.paidAmount === undefined ||
      item?.subTotal === null ||
      item?.subTotal === undefined
    )
  );
  for (let offset = 0; offset < ordersNeedingDetail.length; offset += 5) {
    const batch = ordersNeedingDetail.slice(offset, offset + 5);
    await Promise.all(batch.map(async (order: any) => {
      const orderKey = String(order?.id || order?.invoiceNumber || "").trim();
      const lookupId = String(order?.id || order?.invoiceNumber || "").trim();
      if (!lookupId) { detailFailures.push(orderKey || "unknown"); return; }
      const path = "/partner/stores/orders/" + encodeURIComponent(lookupId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await tocoStoreGet(path, storeClientId, storeToken, controller.signal);
        const raw = await response.text();
        let payload: any;
        try { payload = JSON.parse(raw); } catch { payload = null; }
        if (!response.ok || payload?.success === false || !Array.isArray(payload?.data?.items)) {
          detailFailures.push(orderKey);
          console.error(JSON.stringify({
            service: "sellerbooks-toco", event: "order_detail_failed",
            user_id: user.id, store_id: storeId, status: response.status,
            order_id: orderKey, request_id: payload?.requestId || null,
          }));
          return;
        }
        detailByOrder.set(orderKey, payload.data);
      } catch (error) {
        detailFailures.push(orderKey);
        console.error(JSON.stringify({
          service: "sellerbooks-toco", event: "order_detail_network_error",
          user_id: user.id, store_id: storeId, order_id: orderKey,
          timed_out: controller.signal.aborted,
          error: error instanceof Error ? error.name : "UNKNOWN",
        }));
      } finally { clearTimeout(timer); }
    }));
  }
  if (detailFailures.length) {
    return out({
      ok: false, status: "ORDER_DETAIL_LOOKUP_FAILED",
      error: "Detail " + detailFailures.length + " pesanan Toco gagal dibaca. Tidak ada data yang dimasukkan ke antrean; silakan coba lagi.",
      orders_found: new Set(allOrders.map((order: any) => String(order?.invoiceNumber || order?.id || "").trim()).filter(Boolean)).size,
      details_failed: detailFailures.length,
    }, 502);
  }

  const headers = ["Invoice Number", "SKU", "Total Harga Produk", "Jumlah Produk", "No. Resi Pesanan", "Harga Setelah Diskon", "Waktu Pesanan Dibuat", "Status Pesanan", "ID Paket"];
  const rows: any[][] = [];
  const seenOrderIds = new Set<string>();
  let missingSkuCount = 0;
  let canceledOrdersSkipped = 0;
  for (const order of allOrders) {
    const orderId = String(order?.invoiceNumber || order?.id || "").trim();
    if (!orderId) continue;
    seenOrderIds.add(orderId);
    const orderDetail = detailByOrder.get(String(order?.id || order?.invoiceNumber || "").trim()) || order;
    // Toco's list/detail API includes canceled orders; never queue these as sales.
    const orderStatus = String(orderDetail?.status || order?.status || "").trim().toLowerCase();
    if (orderStatus === "canceled" || orderStatus === "cancelled") {
      canceledOrdersSkipped++;
      continue;
    }
    const items = Array.isArray(orderDetail?.items) ? orderDetail.items : [];
    for (const item of items) {
      const quantity = Math.max(1, Number(item?.quantity) || 1);
      const unitPrice = Number(item?.unitPrice ?? item?.price) || 0;
      const totalPrice = Number(item?.subTotal ?? item?.totalPrice ?? (unitPrice * quantity)) || 0;
      // Do not relabel pre-discount subTotal as a discounted amount. Keep missing paidAmount blank so Import Penjualan can apply its documented fallback safely.
      const discountedPrice = item?.paidAmount === null || item?.paidAmount === undefined ? "" : (Number(item.paidAmount) || 0);
      const sku = skuFromItem(item);
      if (!sku) { missingSkuCount++; continue; }
      const tracking = String(orderDetail?.delivery?.tracking?.airWaybill || orderDetail?.delivery?.tracking?.trackingNumber || orderDetail?.delivery?.tracking?.number || orderDetail?.trackingNumber || "");
      rows.push([
        orderId, sku, totalPrice, quantity, tracking, discountedPrice,
        String(orderDetail?.orderDatetime || order?.orderDatetime || order?.createdAt || ""),
        String(orderDetail?.substatus || order?.substatus || orderDetail?.status || order?.status || ""), String(order?.id || ""),
      ]);
    }
  }

  if (missingSkuCount > 0) {
    return out({
      ok: false, status: "SKU_MAPPING_REQUIRED",
      error: "Toco mengembalikan " + missingSkuCount + " baris item tanpa SKU. Sinkronisasi dihentikan agar transaksi tidak masuk dengan HPP/laba yang salah.",
      orders_found: seenOrderIds.size, rows_found: rows.length, rows_missing_sku: missingSkuCount,
    }, 422);
  }
  if (!rows.length) return out({ ok: true, marketplace: "Toco", status: "NO_ORDER_ITEMS", orders_found: seenOrderIds.size, rows_found: 0, canceled_orders_skipped: canceledOrdersSkipped });

  const fileName = "AUTO-SYNC-TOCO-" + new Date().toISOString() + ".xlsx";
  const queueRes = await rest(base, service, "sellerbooks_api_import_queue", {
    method: "POST",
    headers: { "Prefer": "return=representation" },
    body: JSON.stringify({
      owner_user_id: String(conn.owner_user_id), connection_id: String(conn.id), store_id: String(conn.store_id),
      marketplace: "Toco", file_name: fileName,
      file_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      headers, rows, status: "PENDING",
    }),
  });
  if (!queueRes.ok) {
    const detail = (await readText(queueRes)).slice(0, 250);
    console.error(JSON.stringify({ service: "sellerbooks-toco", event: "import_queue_failed", user_id: user.id, store_id: storeId, detail }));
    return out({ ok: false, error: "Data pesanan berhasil diambil tetapi gagal masuk antrean impor." }, 500);
  }
  const queued = await queueRes.json().catch(() => null);
  const queue = Array.isArray(queued) ? queued[0] : queued;
  const now = new Date().toISOString();
  await rest(base, service, "sellerbooks_api_connections?id=eq." + encodeURIComponent(conn.id), {
    method: "PATCH", body: JSON.stringify({ last_sync_at: now, last_success_at: now, last_error: null, updated_at: now }),
  });
  return out({
    ok: true, marketplace: "Toco", status: "RAW_FILE_READY", orders_found: seenOrderIds.size,
    rows_found: rows.length, canceled_orders_skipped: canceledOrdersSkipped, queue_id: queue?.id || null, file_name: fileName,
    engine: "SELLERBOOKS_IMPORT_PENJUALAN",
  });
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
async function rpcAsUser(base: string, key: string, accessToken: string, name: string, body: unknown) {
  return fetch(base + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

  // sellerbooks_api_connections uses canonical connector IDs (e.g. "toco"),
  // while the browser's store.marketplaceId is a per-user marketplace row ID.
  const connRes = await rpcAsUser(base, pub, bearer(r), "sellerbooks_api_upsert_connection", {
    p_store_id: storeId, p_marketplace_id: "toco", p_marketplace: "Toco",
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
    // Store the provider's actual external store ID for duplicate-account protection.
    p_external_store_id: String(store.clientId),
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
    if (action === "sync-orders") {
      if (r.method !== "POST") return out({ ok: false, error: "Method not allowed." }, 405);
      return await syncOrders(r);
    }
    return out({ ok: false, error: "Invalid Toco action." }, 400);
  } catch (e) {
    console.error(JSON.stringify({ service: "sellerbooks-toco", event: "request_failed", error: e instanceof Error ? e.message : "UNKNOWN" }));
    return out({ ok: false, error: "Layanan integrasi Toco mengalami kesalahan konfigurasi." }, 500);
  }
});
