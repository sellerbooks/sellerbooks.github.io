# SellerBooks Toco Connector — Staging Setup

This connector is isolated on branch `feature/toco-integration`. It is not live on the production `main` branch yet.

## Added files

- `supabase/functions/sellerbooks-toco/index.ts`: authenticated onboarding init and one-time callback completion.
- `toco-oauth-callback.html`: receives Toco's redirect, removes query values from browser history, and submits the one-time callback payload to the Edge Function.
- `supabase/config.toml`: disables gateway JWT verification for this one callback-capable function; the `init` action validates the SellerBooks user token itself.
- `marketplace-oauth-launcher.html` and the store integration routing in `index.html` now include Toco on this feature branch.

## Required Supabase Edge Function secrets

Configure these on the SellerBooks Supabase project only:

- `TOCO_PARTNER_CLIENT_ID`
- `TOCO_PARTNER_SECRET_KEY`
- `TOCO_ENCRYPTION_KEY` — Base64-encoded AES key that decodes to exactly 32 bytes.
- Existing project variables used by SellerBooks functions: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` (or the aliases already used by existing functions).

Never put the Secret Key or Encryption Key in HTML, GitHub source, browser storage, or an APK.

## Toco configuration

Register the exact HTTPS callback URL with Toco if their partner dashboard requires allowlisting:

`https://sellerbooks.amasaindonesia.com/toco-oauth-callback.html`

The onboarding session expires after about three minutes; generate a fresh session if the seller does not continue promptly.

## Current limitations / pre-production checks

1. Confirm the production custom domain resolves this GitHub Pages repository and the callback URL is accepted by Toco staging.
2. Verify Toco routing in `index.html`, the marketplace launcher, and the callback success message/parent refresh behavior.
3. Deploy the Edge Function and its `verify_jwt = false` setting to the SellerBooks Supabase project.
4. Configure secrets in Supabase; no secret values are committed here.
5. Signature canonicalization now follows the published Toco HMAC guide, including store headers on store-scoped calls and excluding the query string from the signed path. Still validate with a staging request before onboarding real stores.
6. Confirm the existing generic RPCs `sellerbooks_api_upsert_connection`, `sellerbooks_api_create_oauth_state`, `sellerbooks_api_consume_oauth_state_v2`, and `sellerbooks_api_complete_marketplace_oauth` are deployed in the SellerBooks Supabase project.
7. Test successful connection, expired/invalid state, malformed encrypted payload, and duplicate connection behavior.
8. The `action=sync-orders` route now fetches all pages without a date filter and queues raw item rows for the existing SellerBooks import dispatcher. The dispatcher profile uses Toco's invoice/SKU/quantity/discounted-line-total/date headers; the raw pre-discount total is retained separately for audit. If an order item has no SKU, sync intentionally stops instead of importing a transaction with zero/incorrect HPP. Validate the exact SKU fields in a real Toco staging response before merging.

## Security notes

The callback credential is received in the browser URL because that is Toco's documented redirect flow. The callback page immediately removes the query string from browser history and forwards the encrypted payload to the server. Configure HTTPS, avoid sharing callback URLs/screenshots, and keep all decryption and long-term credential storage server-side.


## Latest branch-only audit

- Enforced the 20-second request timeout by passing `AbortController.signal` to the fetch call.
- Timeout/network failures now return explicit, non-secret error messages and status codes.
- The connection upsert RPC receives the validated SellerBooks user's JWT (rather than the public API key as bearer), so user identity/RLS checks can run as the logged-in user.
- The connection upsert uses canonical marketplace ID `toco`; the UI's per-user marketplace row ID is not used as the connector ID.
- GitHub Actions now runs `deno check` for the Toco Edge Function, syntax-checks all 10 inline JavaScript blocks in `index.html`, and checks patch whitespace.
- Production `main` and the live site remain unchanged; do not merge or deploy until the Supabase RPC/table contract and real Toco payload SKU mapping are verified.


## SKU resolution audit

- The published `GET /partner/stores/orders` list sample omits SKU, but the documented `GET /partner/stores/orders/{orderId | invoiceNumber}` detail response includes `productId`, `externalId`, `sku`, `variation`, `unitPrice`, `subTotal`, and `paidAmount`.
- The connector now calls the order-detail endpoint for orders whose list items lack SKU, with five concurrent detail requests and a 20-second timeout per request.
- If any required order-detail lookup fails, the sync stops before queueing anything. If a detail item still has no SKU, the existing missing-SKU guard also stops the sync. Product names are never treated as SKU.
- The raw queue retains Toco's `subTotal` as `Total Harga Produk` and `paidAmount` as `Harga Setelah Diskon`. The existing Import Penjualan adapter now prefers `Harga Setelah Diskon` when calculating the line sales amount and price snapshot, with pre-discount total only as fallback. SellerBooks' existing Import Penjualan remains responsible for deduplication and product-level calculations.
- This resolves the documentation-level SKU lookup path, but it is **not yet staging-verified**. Validate the actual payload, API rate limits, price semantics, queue schema, and financial snapshots before merging or deploying.
