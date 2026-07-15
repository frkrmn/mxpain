#!/usr/bin/env node
/**
 * Deribit Max Pain Scraper (Node.js + Puppeteer)
 * ================================================
 *
 * Her gün 06:30 UTC'de (cron ile) şu sayfalara gider:
 *   https://www.deribit.com/statistics/BTC/Metrics/Options
 *   https://www.deribit.com/statistics/ETH/Metrics/Options
 *   https://www.deribit.com/statistics/SOL/Metrics/Options
 *   https://www.deribit.com/statistics/XRP/Metrics/Options
 *
 * Tarih seçiciden mevcut ayın son gününü seçer (örn. "31 Jul 26"),
 * grafikteki "Max Pain Price $X.XX" yazısını okur ve max_pain_data.json
 * dosyasına ekler.
 *
 * ---------------------------------------------------------------------
 * ÖNEMLİ NOT
 * ---------------------------------------------------------------------
 * Bu script deribit.com'un canlı DOM yapısına erişim OLMADAN yazıldı
 * (bu ortamdan deribit.com'a ağ erişimi yok). Tarih seçici ve Max Pain
 * metni için birden fazla yedek (fallback) selector stratejisi var, ama
 * ilk çalıştırmada SCRAPER_HEADLESS=false ile gözle kontrol etmen ve
 * gerekirse SELECTORS objesini güncellemen gerekebilir. En hızlı yol:
 *
 *   npx puppeteer browsers install chrome  (gerekirse)
 *   node --inspect scraper.js  veya
 *   Chrome DevTools > sayfayı aç > tarih seçiciye tıkla > elementi incele
 *
 * ---------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// --------------------------------------------------------------------
// Config
// --------------------------------------------------------------------

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const BASE_URL = (symbol) => `https://www.deribit.com/statistics/${symbol}/Metrics/Options`;

const OUTPUT_FILE = path.join(__dirname, 'solxprmxpn.json');
const LOG_FILE = path.join(__dirname, 'scraper.log');

const HEADLESS = process.env.SCRAPER_HEADLESS !== 'false';
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const CHART_RENDER_WAIT_MS = 2_500;

// Tarih seçici için selector listesi.
// Site MUI Base (Base UI) kullanıyor -> class isimleri "base-Select-root",
// "base-Option-root", "base-Popup-root" gibi bir kalıp izliyor. Bunları
// önce deniyoruz, tutmazsa daha genel yedeklere düşüyoruz.
const SELECTORS = {
  dateDropdownButton: [
    '.base-Select-root',                 // MUI Base Select kök elemanı
    'button.base-Select-root',
    '[class*="base-Select-root"]',
    // "31 Jul 26" gibi bir metin içeren buton/eleman (yedek)
    'xpath///button[contains(., "Jul") or contains(., "Jan") or contains(., "Feb") or contains(., "Mar") or contains(., "Apr") or contains(., "May") or contains(., "Jun") or contains(., "Aug") or contains(., "Sep") or contains(., "Oct") or contains(., "Nov") or contains(., "Dec")]',
    '[class*="date"] button',
    '[class*="dropdown"] button',
    '[class*="DatePicker"] button',
    '[class*="Select"] button',
  ],
  // Dropdown'ın "açık" olduğunu doğrulamak için (tıklamadan sonra
  // beklenirken kullanılır)
  dateDropdownActiveMarker: [
    '.base-Select-root.base--active',
    '.base--active',
  ],
  dateOptionListItem: [
    '.base-Option-root',                 // MUI Base Option kök elemanı
    'li.base-Option-root',
    '[class*="base-Option-root"]',
    '[role="option"]',
    'li',
    '[class*="option"]',
    '[class*="menu-item"]',
  ],
};

// --------------------------------------------------------------------
// Yardımcı fonksiyonlar
// --------------------------------------------------------------------

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function lastDayOfCurrentMonthUTC(now = new Date()) {
  // Bir sonraki ayın 0. günü = bu ayın son günü (UTC)
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  return new Date(Date.UTC(year, month + 1, 0));
}

function formatPickerLabel(date) {
  // Örn: "31 Jul 26"
  const day = date.getUTCDate();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[date.getUTCMonth()];
  const year = String(date.getUTCFullYear()).slice(-2);
  return `${day} ${month} ${year}`;
}

async function tryClickFirstMatch(page, selectorList, timeout = 4000) {
  for (const sel of selectorList) {
    try {
      let handle;
      if (sel.startsWith('xpath/')) {
        const xp = sel.slice('xpath/'.length);
        await page.waitForSelector(`xpath/${xp}`, { visible: true, timeout });
        const [el] = await page.$$(`xpath/${xp}`);
        handle = el;
      } else {
        await page.waitForSelector(sel, { visible: true, timeout });
        handle = await page.$(sel);
      }
      if (handle) {
        await handle.click();
        return { ok: true, selector: sel };
      }
    } catch (e) {
      continue;
    }
  }
  return { ok: false, selector: null };
}

async function selectLastDayOfMonth(page, targetLabel) {
  const opened = await tryClickFirstMatch(page, SELECTORS.dateDropdownButton);
  if (!opened.ok) {
    log('UYARI: Tarih seçici butonu bulunamadı/açılamadı.');
    return false;
  }
  log(`Tarih seçici açıldı, kullanılan selector: ${opened.selector}`);

  // Panelin gerçekten açıldığını "base--active" class'ı üzerinden doğrula.
  // Bulamazsak yine de devam ederiz (sabit 400ms bekleme fallback).
  let confirmedActive = false;
  for (const activeSel of SELECTORS.dateDropdownActiveMarker) {
    try {
      await page.waitForSelector(activeSel, { visible: true, timeout: 1500 });
      confirmedActive = true;
      log(`Dropdown açık durumu doğrulandı: ${activeSel}`);
      break;
    } catch (e) {
      continue;
    }
  }
  if (!confirmedActive) {
    log('UYARI: "base--active" class\'ı doğrulanamadı, sabit bekleme ile devam ediliyor.');
  }

  await new Promise((r) => setTimeout(r, 400)); // dropdown animasyonu için bekle

  const dayNum = targetLabel.split(' ')[0];

  for (const listSel of SELECTORS.dateOptionListItem) {
    try {
      const items = await page.$$(listSel);
      if (!items.length) continue;

      for (const item of items) {
        const txt = (await page.evaluate((el) => el.textContent, item) || '').trim();
        if (txt === targetLabel || txt.startsWith(dayNum + ' ')) {
          await item.click();
          log(`Tarih seçildi: "${txt}" (selector: ${listSel})`);
          return true;
        }
      }
    } catch (e) {
      continue;
    }
  }

  log(`UYARI: "${targetLabel}" eşleşen bir tarih seçeneği bulunamadı.`);
  return false;
}

async function extractMaxPain(page) {
  const bodyText = await page.evaluate(() => document.body.innerText);
  const match = bodyText.match(/Max Pain Price\s*\$?\s*([\d,]+\.?\d*)/);
  if (match) {
    const rawText = match[0];
    const value = parseFloat(match[1].replace(/,/g, ''));
    return { rawText, value: Number.isNaN(value) ? null : value };
  }
  return { rawText: null, value: null };
}

async function scrapeSymbol(browser, symbol, targetLabel) {
  const url = BASE_URL(symbol);
  log(`[${symbol}] sayfaya gidiliyor: ${url}`);

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const result = {
    symbol,
    url,
    target_expiry_label: targetLabel,
    scraped_at_utc: new Date().toISOString(),
    max_pain_raw_text: null,
    max_pain_value: null,
    date_selection_succeeded: false,
    error: null,
  };

  try {
    await page.goto(url, { timeout: PAGE_LOAD_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 3000)); // ilk render için bekle

    const selected = await selectLastDayOfMonth(page, targetLabel);
    result.date_selection_succeeded = selected;

    await new Promise((r) => setTimeout(r, CHART_RENDER_WAIT_MS));

    const maxPain = await extractMaxPain(page);
    result.max_pain_raw_text = maxPain.rawText;
    result.max_pain_value = maxPain.value;

    if (maxPain.value === null) {
      log(`[${symbol}] UYARI: Max Pain değeri sayfada bulunamadı.`);
    } else {
      log(`[${symbol}] Max Pain = ${maxPain.value} (tarih seçimi başarılı: ${selected})`);
    }
  } catch (e) {
    log(`[${symbol}] HATA: ${e.message}`);
    result.error = e.message;
  } finally {
    await page.close();
  }

  return result;
}

function loadExistingData() {
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    } catch (e) {
      log('UYARI: Mevcut çıktı dosyası okunamadı, sıfırdan başlanıyor.');
    }
  }
  return [];
}

function saveData(records) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2));
  log(`${records.length} toplam kayıt "${OUTPUT_FILE}" dosyasına yazıldı.`);
}

async function run() {
  const targetDate = lastDayOfCurrentMonthUTC();
  const targetLabel = formatPickerLabel(targetDate);
  log(`Bu çalıştırma için hedef vade: ${targetLabel}`);

  const existing = loadExistingData();
  const runBatch = {
    run_timestamp_utc: new Date().toISOString(),
    target_expiry_label: targetLabel,
    results: [],
  };

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    for (const symbol of SYMBOLS) {
      const res = await scrapeSymbol(browser, symbol, targetLabel);
      runBatch.results.push(res);
      await new Promise((r) => setTimeout(r, 1000)); // sayfalar arası nazik bekleme
    }
  } finally {
    await browser.close();
  }

  // existing.push(runBatch); // sadece bugunun verisi yazilsin
  saveData([runBatch]); // sadece bugunun verisi

  return runBatch;
}

if (require.main === module) {
  run().catch((e) => {
    log(`FATAL: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = { run };
