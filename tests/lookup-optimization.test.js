/**
 * Regression checks for the lookup optimizations in index.html.
 *
 * These tests compare the indexed lookup strategy with the former Array.find()
 * semantics, including duplicate keys and cross-field ID/SKU collisions.
 * Run with: node --test tests/lookup-optimization.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const normalizeSku = value => String(value || "").trim().toLowerCase();

function legacySkuFind(products, sku) {
  return products.find(item =>
    String(item && item.sku || "").trim().toLowerCase() === sku
  ) || null;
}

function indexedSkuFind(products, sku) {
  const bySku = new Map();
  products.forEach(item => {
    const key = normalizeSku(item && item.sku);
    if (key && !bySku.has(key)) bySku.set(key, item);
  });
  return bySku.get(sku) || null;
}

function legacyRestoreFind(products, info) {
  return products.find(item => {
    const sameId = info.productId &&
      String(item && item.id || "") === String(info.productId);
    const sameSku = normalizeSku(item && item.sku) === normalizeSku(info.sku);
    return sameId || sameSku;
  }) || null;
}

function indexedRestoreFind(products, info) {
  const byId = new Map();
  const bySku = new Map();
  products.forEach((item, index) => {
    if (!item) return;
    const id = String(item.id || "");
    const sku = normalizeSku(item.sku);
    if (id && !byId.has(id)) byId.set(id, { item, index });
    if (sku && !bySku.has(sku)) bySku.set(sku, { item, index });
  });

  const idMatch = info.productId ? byId.get(String(info.productId)) : null;
  const skuKey = normalizeSku(info.sku);
  const skuMatch = skuKey ? bySku.get(skuKey) : null;
  const match = idMatch && skuMatch
    ? (idMatch.index <= skuMatch.index ? idMatch : skuMatch)
    : (idMatch || skuMatch);
  return match ? match.item : null;
}

test("SKU index preserves Array.find first-match behavior", () => {
  const products = [
    { id: "a", sku: "  SKU-1 ", price: 10 },
    { id: "b", sku: "sku-1", price: 20 },
    null,
    { id: "c", sku: "SKU-2", price: 30 },
  ];

  for (const sku of ["sku-1", "sku-2", "missing"]) {
    assert.equal(indexedSkuFind(products, sku), legacySkuFind(products, sku));
  }
});

test("restore index preserves first array match across ID and SKU", () => {
  const cases = [
    {
      products: [
        { id: "same-id", sku: "other" },
        { id: "different", sku: "wanted" },
      ],
      info: { productId: "same-id", sku: "wanted" },
    },
    {
      products: [
        { id: "different", sku: "wanted" },
        { id: "same-id", sku: "other" },
      ],
      info: { productId: "same-id", sku: "wanted" },
    },
    {
      products: [
        { id: "same-id", sku: "same" },
        { id: "same-id", sku: "same" },
      ],
      info: { productId: "same-id", sku: "same" },
    },
    {
      products: [null, { id: "x", sku: "sku-x" }],
      info: { productId: "missing", sku: "sku-x" },
    },
    {
      products: [{ id: "x", sku: "sku-x" }],
      info: { productId: "", sku: "" },
    },
  ];

  for (const { products, info } of cases) {
    assert.equal(indexedRestoreFind(products, info), legacyRestoreFind(products, info));
  }
});
