#!/usr/bin/env node
/**
 * SellerBooks EN/ID release gate.
 *
 * Fails the release when:
 * 1. EN/ID dictionary keys are missing or empty.
 * 2. A translation value contains obvious opposite-language UI tokens.
 * 3. A user-facing static HTML string is hard-coded instead of represented
 *    by the translation dictionary.
 *
 * This is intentionally strict: a non-zero exit code blocks the release.
 */

import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("index.html", "utf8");
const failures = [];

function fail(type, detail){
  failures.push({type, detail});
}

function extractBalancedObject(text, start){
  let depth = 0;
  let quote = null;
  let escaped = false;

  for(let i = start; i < text.length; i++){
    const ch = text[i];

    if(quote){
      if(escaped) escaped = false;
      else if(ch === "\\") escaped = true;
      else if(ch === quote) quote = null;
      continue;
    }

    if(ch === '"' || ch === "'" || ch === "\`"){
      quote = ch;
      continue;
    }

    if(ch === "{"){
      depth++;
    }else if(ch === "}" && depth > 0){
      depth--;
      if(depth === 0) return text.slice(start, i + 1);
    }
  }

  throw new Error("Could not parse SELLERBOOKS_I18N object.");
}

const marker = "const SELLERBOOKS_I18N =";
const markerPos = source.indexOf(marker);

if(markerPos < 0){
  fail("missing-i18n-object", "SELLERBOOKS_I18N was not found.");
}else{
  try{
    const objectStart = source.indexOf("{", markerPos);
    const objectText = extractBalancedObject(source, objectStart);
    const i18n = vm.runInNewContext("(" + objectText + ")");

    const id = i18n.id || {};
    const en = i18n.en || {};
    const idKeys = new Set(Object.keys(id));
    const enKeys = new Set(Object.keys(en));

    for(const key of idKeys){
      if(!enKeys.has(key)) fail("missing-en-key", key);
      if(String(id[key] ?? "").trim() === "") fail("empty-id-translation", key);
      if(enKeys.has(key) && String(en[key] ?? "").trim() === ""){
        fail("empty-en-translation", key);
      }
    }

    for(const key of enKeys){
      if(!idKeys.has(key)) fail("missing-id-key", key);
    }

    const idWords = [
      "tambah","pilih","nama","akun","toko","produk","kategori","harga",
      "jual","modal","stok","aktif","tidak aktif","simpan","hapus","batal",
      "tutup","kelola","biaya","keterangan","nominal","tanggal","deskripsi",
      "contoh","masukkan","wajib","harus","belum","sudah","gagal","berhasil",
      "kesalahan","perubahan","pengaturan","bahasa","semua","tidak ada",
      "penjualan","pesanan","pengiriman","pengambilan","integrasikan",
      "terintegrasi","copot","tarik order","laporan","rincian","piutang",
      "pembayaran","sisa","dibayar","dipilih","menunggu","segera hadir",
      "kembali","lanjutkan","konfirmasi","persetujuan"
    ];

    const enWords = [
      "add","select","name","store","product","category","selling","price",
      "cost","stock","active","inactive","save","delete","cancel","close",
      "manage","description","amount","date","enter","required","must",
      "not yet","already","failed","success","error","changes","settings",
      "language","all","no data","sales","orders","shipment","pickup",
      "integrate","integrated","disconnect","pull orders","reports",
      "details","receivable","payment","remaining","paid","selected",
      "waiting","coming soon","back","continue","confirm","approval"
    ];

    function hasToken(value, words){
      const lower = String(value).toLowerCase();
      return words.some(word => {
        const escaped = word.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
        return new RegExp("(^|[^a-z0-9])" + escaped + "([^a-z0-9]|$)", "i").test(lower);
      });
    }

    for(const [key,value] of Object.entries(en)){
      if(hasToken(value,idWords)){
        fail("mixed-language-en", key + " => " + value);
      }
    }

    for(const [key,value] of Object.entries(id)){
      if(hasToken(value,enWords)){
        fail("mixed-language-id", key + " => " + value);
      }
    }

    const dictionaryKeys = new Set([...idKeys, ...enKeys]);
    const dictionaryValues = new Set(
      [...Object.values(id), ...Object.values(en)]
        .map(value => String(value).trim())
        .filter(Boolean)
    );

    // Remove non-user-facing code before checking static HTML text.
    const html = source
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "");

    const ignored = new Set([
      "SellerBooks","SB","Marketplace","SKU","QTY","Excel","CSV","API",
      "OAuth","IDR","USD","SGD","MYR","Rp","ID","EN","Main Menu"
    ]);

    function clean(value){
      return String(value)
        .replace(/&nbsp;/gi," ")
        .replace(/&amp;/gi,"&")
        .replace(/\s+/g," ")
        .trim();
    }

    function looksLikeUiText(value){
      if(!value || value.length < 2) return false;
      if(!/[A-Za-zÀ-ÿ]/.test(value)) return false;
      if(/^[A-Za-z0-9_.$:/#%+\-]+$/.test(value)) return false;
      if(/^https?:\/\//i.test(value)) return false;
      if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
      if(/^©\s*\d{4}\s+All Rights Reserved by$/i.test(value)) return false;
      if(/^PT\s+Adiimasa Distribusi Indonesia$/i.test(value)) return false;
      if(/^Contoh:\s*PT\s+Adiimasa Distribusi Indonesia$/i.test(value)) return false;
      if(ignored.has(value)) return false;
      return true;
    }

    const visibleText = [];
    const textRe = />([^<>]+)</g;
    let match;

    while((match = textRe.exec(html))){
      const value = clean(match[1]);
      if(looksLikeUiText(value)) visibleText.push(value);
    }

    const attrRe = /\b(?:placeholder|title|aria-label|data-tooltip)\s*=\s*["']([^"']+)["']/gi;

    while((match = attrRe.exec(html))){
      const value = clean(match[1]);
      if(looksLikeUiText(value)) visibleText.push(value);
    }

    for(const value of new Set(visibleText)){
      if(dictionaryKeys.has(value) || dictionaryValues.has(value)) continue;
      if(/^\$?\{?[A-Za-z0-9_.()[\]-]+\}?$/.test(value)) continue;
      if(/^(?:true|false|null|undefined)$/i.test(value)) continue;

      fail("hard-coded-ui-string", value);
    }
  }catch(error){
    fail("i18n-parse-error", error.message);
  }
}

if(failures.length){
  console.error("\nSellerBooks EN/ID RELEASE CHECK: FAIL");
  console.error("Release is blocked because " + failures.length + " issue(s) were found.\n");

  for(const [index,item] of failures.entries()){
    console.error((index + 1) + ". [" + item.type + "] " + item.detail);
  }

  process.exit(1);
}

console.log("SellerBooks EN/ID RELEASE CHECK: PASS");
console.log("No missing translation keys, mixed-language translations, or hard-coded static UI strings were found.");
