/**
 * BoekScan app.js v2 – Book Laser clone
 * ─────────────────────────────────────
 * Werking:
 *  1. Scan barcode (of handmatig ISBN invoeren)
 *  2. Haal bol.com productpagina op via CORS-proxy
 *  3. Parseer prijs, titel en aantal aanbieders uit de HTML
 *  4. Bereken netto winst op basis van instellingen
 *  5. Geef rood / geel / groen oordeel
 *
 * CORS-PROXY UITLEG:
 *  Browsers blokkeren directe fetch() naar bol.com (CORS-policy).
 *  We gebruiken api.allorigins.win – een gratis openbare proxy die
 *  de pagina namens ons ophaalt en terugstuurt als JSON.
 *  URL-formaat: https://api.allorigins.win/get?url=<encoded-url>
 *  Alternatief: corsproxy.io of je eigen backend (aanbevolen voor
 *  productie omdat openbare proxies soms worden geblokkeerd).
 *
 * BOL.COM SCRAPING OPMERKING:
 *  Bol.com laadt prijzen deels via JavaScript (React). De proxy
 *  geeft de initiële server-side HTML terug. Dat bevat in de meeste
 *  gevallen de laagste prijs en aanbiedersaantal in de <meta> tags
 *  en JSON-LD structured data. Als bol.com hun markup wijzigt kan
 *  de parser aanpassing nodig hebben.
 */

'use strict';

/* ── State ── */
let html5QrCode  = null;
let isScanning   = false;
let currentISBN  = null;
let currentPrices = [];     // [{ label, price, isLowest }]
let selectedPriceIndex = 0;

const MAX_HISTORY = 10;
let scanHistory = JSON.parse(localStorage.getItem('boekscan_history_v2') || '[]');

/* ── Standaard instellingen ── */
const DEFAULT_SETTINGS = {
  costVerpakking: 0.30,
  costVerzending: 3.99,
  commissiePct:   15,
  minWinst:       1.50,
  minAanbieders:  3,
  geenRankRood:   false,
};

let settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('boekscan_settings') || '{}') };

/* ══════════════════════════════════════════════════
   INSTELLINGEN
══════════════════════════════════════════════════ */
function openSettings() {
  document.getElementById('settingsPanel').classList.add('open');
  document.getElementById('settingsOverlay').classList.add('open');
  // Vul velden
  document.getElementById('sCostVerpakking').value = settings.costVerpakking;
  document.getElementById('sCostVerzending').value = settings.costVerzending;
  document.getElementById('sCommissie').value      = settings.commissiePct;
  document.getElementById('sMinWinst').value       = settings.minWinst;
  document.getElementById('sMinAanbieders').value  = settings.minAanbieders;
  document.getElementById('sGeenRankRood').checked = settings.geenRankRood;
}

function closeSettings() {
  document.getElementById('settingsPanel').classList.remove('open');
  document.getElementById('settingsOverlay').classList.remove('open');
}

function saveSettings() {
  settings = {
    costVerpakking: parseFloat(document.getElementById('sCostVerpakking').value) || 0,
    costVerzending: parseFloat(document.getElementById('sCostVerzending').value) || 0,
    commissiePct:   parseFloat(document.getElementById('sCommissie').value)      || 15,
    minWinst:       parseFloat(document.getElementById('sMinWinst').value)        || 1.50,
    minAanbieders:  parseInt(document.getElementById('sMinAanbieders').value)     || 3,
    geenRankRood:   document.getElementById('sGeenRankRood').checked,
  };
  localStorage.setItem('boekscan_settings', JSON.stringify(settings));
  closeSettings();
  // Herbereken als er een resultaat open staat
  if (currentISBN) recalculate();
}

/* ══════════════════════════════════════════════════
   SCANNER
══════════════════════════════════════════════════ */
async function startScanner() {
  if (isScanning) return;
  html5QrCode = new Html5Qrcode('reader');

  const config = {
    fps: 15,
    qrbox: { width: 240, height: 120 },
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.CODE_128,
      Html5QrcodeSupportedFormats.UPC_A,
    ],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    aspectRatio: 1.0,
  };

  try {
    await html5QrCode.start({ facingMode: 'environment' }, config, onScanSuccess, () => {});
    isScanning = true;
    document.getElementById('idleMsg').style.display  = 'none';
    document.getElementById('scanLine').style.display = 'block';
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('stopBtn').style.display  = 'inline-flex';
  } catch (err) {
    console.error('Camera fout:', err);
    const msg = document.getElementById('idleMsg');
    msg.style.display = 'flex';
    msg.innerHTML = `<span>&#9888;</span><p style="color:#FF4444;font-size:.82rem">Camera niet beschikbaar.<br/><small>${err?.message || err}</small></p>`;
  }
}

async function stopScanner() {
  if (!isScanning || !html5QrCode) return;
  try { await html5QrCode.stop(); html5QrCode.clear(); } catch(e) {}
  isScanning = false;
  html5QrCode = null;
  document.getElementById('scanLine').style.display = 'none';
  document.getElementById('idleMsg').style.display  = 'flex';
  document.getElementById('startBtn').style.display = 'inline-flex';
  document.getElementById('stopBtn').style.display  = 'none';
}

async function onScanSuccess(decodedText) {
  if (!isScanning) return;
  await stopScanner();
  triggerVibration();
  playBeep();
  triggerFlash();
  lookupISBN(decodedText.trim());
}

function manualLookup() {
  const val = document.getElementById('manualISBN').value.trim();
  if (!val) return;
  lookupISBN(val);
}

/* ══════════════════════════════════════════════════
   BOL.COM OPHALEN
══════════════════════════════════════════════════ */
async function lookupISBN(isbn) {
  currentISBN = isbn;
  currentPrices = [];
  selectedPriceIndex = 0;

  showLoading('Bol.com ophalen...');
  hideResult();

  try {
    const data = await fetchBolPage(isbn);
    hideLoading();
    processResult(isbn, data);
  } catch (err) {
    console.error('Ophalen mislukt:', err);
    hideLoading();
    showError(isbn, err.message);
  }
}

/**
 * Haal bol.com zoekpagina op via CORS-proxy.
 * We zoeken op ISBN zodat we ook boeken vinden die we zelf niet aanbieden.
 */
async function fetchBolPage(isbn) {
  const bolUrl   = `https://www.bol.com/nl/nl/s/?searchtext=${encodeURIComponent(isbn)}`;
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(bolUrl)}`;

  const res = await fetch(proxyUrl);
  if (!res.ok) throw new Error(`Proxy fout: ${res.status}`);

  const json = await res.json();
  if (!json.contents) throw new Error('Lege reactie van proxy');

  return parseBolHTML(json.contents, isbn);
}

/**
 * Parseer de bol.com HTML op zoek naar:
 * - Producttitel
 * - Prijs(zen) van aanbieders
 * - Aantal aanbieders
 *
 * Bol.com serveert gestructureerde data als JSON-LD (<script type="application/ld+json">)
 * én als OpenGraph meta-tags. We proberen beide methoden.
 */
function parseBolHTML(html, isbn) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(html, 'text/html');

  let title       = null;
  let prices      = [];      // array van getallen (euro)
  let aanbieders  = null;    // getal of null

  /* ── Methode 1: JSON-LD structured data ── */
  const jsonldTags = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const tag of jsonldTags) {
    try {
      const data = JSON.parse(tag.textContent);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        // Product schema
        if (item['@type'] === 'Product' || item['@type'] === 'Book') {
          if (!title && item.name) title = item.name;
          // Offers
          const offers = item.offers;
          if (offers) {
            const offerList = Array.isArray(offers) ? offers
              : offers['@type'] === 'AggregateOffer' ? [offers]
              : [offers];
            for (const o of offerList) {
              if (o.price)     prices.push(parseFloat(o.price));
              if (o.lowPrice)  prices.push(parseFloat(o.lowPrice));
              if (o.highPrice) prices.push(parseFloat(o.highPrice));
              if (o.offerCount) aanbieders = parseInt(o.offerCount);
            }
          }
        }
        // ItemList (zoekresultaten)
        if (item['@type'] === 'ItemList' && item.itemListElement) {
          for (const el of item.itemListElement) {
            const prod = el.item || el;
            if (prod.name && !title) title = prod.name;
            if (prod.offers?.price) prices.push(parseFloat(prod.offers.price));
            if (prod.offers?.lowPrice) prices.push(parseFloat(prod.offers.lowPrice));
          }
        }
      }
    } catch(e) { /* ongeldige JSON, overslaan */ }
  }

  /* ── Methode 2: OpenGraph / meta tags ── */
  if (!title) {
    const ogTitle = doc.querySelector('meta[property="og:title"]');
    if (ogTitle) title = ogTitle.getAttribute('content');
  }

  /* ── Methode 3: CSS-selectors op productkaarten ── */
  if (prices.length === 0) {
    // Bol.com prijzen staan vaak in elementen met data-test of class "promo-price"
    const priceEls = doc.querySelectorAll('[data-test="price"], .promo-price, .price--amount, [class*="price"]');
    for (const el of priceEls) {
      const txt = el.textContent.replace(',', '.').replace(/[^0-9.]/g, '');
      const val = parseFloat(txt);
      if (val > 0.5 && val < 500) prices.push(val);
    }
  }

  /* ── Aanbieders tellen ── */
  if (aanbieders === null) {
    // Zoek naar tekst als "14 aanbieders" of "nieuwe & gebruikt (8)"
    const bodyText = doc.body?.textContent || '';
    const match = bodyText.match(/(\d+)\s+aanbieder/i)
                || bodyText.match(/(\d+)\s+verkoper/i);
    if (match) aanbieders = parseInt(match[1]);
  }

  /* ── Dedupliceer & sorteer prijzen ── */
  prices = [...new Set(prices.filter(p => !isNaN(p) && p > 0.01 && p < 1000))].sort((a,b) => a - b);

  /* ── Niet gevonden check ── */
  const notFound = html.includes('geen resultaten') || html.includes('0 resultaten')
    || html.includes('Geen resultaten') || prices.length === 0;

  return { title, prices, aanbieders, notFound };
}

/* ══════════════════════════════════════════════════
   RESULTAAT VERWERKEN
══════════════════════════════════════════════════ */
function processResult(isbn, data) {
  if (data.notFound && data.prices.length === 0) {
    showError(isbn, 'Niet gevonden op bol.com');
    return;
  }

  currentPrices = data.prices.map((p, i) => ({
    price: p,
    label: i === 0 ? 'Laagste prijs' : `Aanbieder ${i + 1}`,
    isLowest: i === 0,
  }));

  // Toon resultaat
  document.getElementById('resultISBN').textContent  = formatISBN(isbn);
  document.getElementById('bookTitle').textContent   = data.title || `ISBN ${isbn}`;
  document.getElementById('bolLink').href = `https://www.bol.com/nl/nl/s/?searchtext=${encodeURIComponent(isbn)}`;

  // Prijzen weergeven
  renderPrices(data.aanbieders);

  // Bereken met huidige instellingen
  recalculate(data.aanbieders);

  document.getElementById('resultSection').style.display = 'block';
  setTimeout(() => document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);

  // Sla op in geschiedenis (na berekening)
  const winst = calcWinst(currentPrices[0]?.price || 0);
  const verdict = getVerdict(winst, data.aanbieders);
  addToHistory(isbn, data.title, winst, verdict);
}

function renderPrices(aanbieders) {
  const list = document.getElementById('pricesList');
  const count = document.getElementById('pricesCount');

  if (aanbieders !== null) {
    count.textContent = `(${aanbieders})`;
  }

  if (currentPrices.length === 0) {
    list.innerHTML = '<div style="font-size:.82rem;color:var(--muted)">Geen prijzen gevonden</div>';
    return;
  }

  list.innerHTML = currentPrices.map((p, i) => `
    <div class="price-item ${i === selectedPriceIndex ? 'selected' : ''}" onclick="selectPrice(${i})">
      <div>
        <div class="price-item-label">${p.label}</div>
        <div class="price-item-hint">${i === 0 ? 'Jij verkoopt voor dit bedrag' : 'Klik om te rekenen met dit bedrag'}</div>
      </div>
      <div class="price-item-amount">€ ${p.price.toFixed(2)}</div>
    </div>
  `).join('');
}

function selectPrice(index) {
  selectedPriceIndex = index;
  renderPrices(null);
  recalculate();
}

function recalculate(aanbieders) {
  const verkoopprijs = currentPrices[selectedPriceIndex]?.price;
  if (!verkoopprijs) return;

  const inkoop = parseFloat(document.getElementById('inkoopPrijs').value) || 0;
  const winst  = calcWinst(verkoopprijs, inkoop);

  // Vul berekening in
  document.getElementById('calcVerkoopprijs').textContent = `€ ${verkoopprijs.toFixed(2)}`;
  document.getElementById('calcCommissiePct').textContent = settings.commissiePct;
  document.getElementById('calcCommissieAmt').textContent = `− € ${(verkoopprijs * settings.commissiePct / 100).toFixed(2)}`;
  document.getElementById('calcVerzending').textContent   = `− € ${settings.costVerzending.toFixed(2)}`;
  document.getElementById('calcVerpakking').textContent   = `− € ${settings.costVerpakking.toFixed(2)}`;
  document.getElementById('calcInkoop').textContent       = `− € ${inkoop.toFixed(2)}`;

  const winstEl = document.getElementById('calcWinst');
  winstEl.textContent = `€ ${winst.toFixed(2)}`;
  winstEl.className   = 'calc-val ' + (winst >= settings.minWinst ? 'profit-pos' : 'profit-neg');

  // Gebruik opgeslagen aanbieders als niet meegegeven
  const knownAanbieders = aanbieders ?? currentPrices.length;
  const verdict = getVerdict(winst, knownAanbieders);
  renderVerdict(verdict, winst);
}

function calcWinst(verkoopprijs, inkoop) {
  const inkoopVal = inkoop ?? parseFloat(document.getElementById('inkoopPrijs').value) || 0;
  const commissie = verkoopprijs * settings.commissiePct / 100;
  return verkoopprijs - commissie - settings.costVerzending - settings.costVerpakking - inkoopVal;
}

/* ══════════════════════════════════════════════════
   OORDEEL LOGICA (rood / geel / groen)
══════════════════════════════════════════════════ */
function getVerdict(winst, aanbieders) {
  const winstgevend = winst >= settings.minWinst;
  const heeftRanking = aanbieders !== null && aanbieders > 0;
  const goedRanking  = heeftRanking && aanbieders >= settings.minAanbieders;

  if (!winstgevend) {
    return { color: 'red', emoji: '🔴', title: 'Niet winstgevend', sub: `Winst te laag (min. € ${settings.minWinst.toFixed(2)})` };
  }
  if (settings.geenRankRood && !heeftRanking) {
    return { color: 'red', emoji: '🔴', title: 'Geen ranking', sub: 'Instelling: geen ranking = Rood' };
  }
  if (!heeftRanking) {
    return { color: 'yellow', emoji: '🟡', title: 'Winstgevend', sub: 'Geen rankingdata beschikbaar' };
  }
  if (!goedRanking) {
    return { color: 'yellow', emoji: '🟡', title: 'Matige ranking', sub: `Slechts ${aanbieders} aanbieder(s) gevonden` };
  }
  return { color: 'green', emoji: '🟢', title: 'Goede koop!', sub: `Winstgevend & ${aanbieders} aanbieders` };
}

function renderVerdict(verdict, winst) {
  const card  = document.getElementById('verdictCard');
  const light = document.getElementById('verdictLight');

  card.className  = `verdict-card ${verdict.color}`;
  light.textContent = verdict.emoji;
  document.getElementById('verdictTitle').textContent = verdict.title;
  document.getElementById('verdictSub').textContent   = verdict.sub;
}

/* ══════════════════════════════════════════════════
   GESCHIEDENIS
══════════════════════════════════════════════════ */
function addToHistory(isbn, title, winst, verdict) {
  scanHistory = scanHistory.filter(i => i.isbn !== isbn);
  scanHistory.unshift({ isbn, title: title || isbn, winst, verdict: verdict.color, timestamp: new Date().toISOString() });
  if (scanHistory.length > MAX_HISTORY) scanHistory = scanHistory.slice(0, MAX_HISTORY);
  localStorage.setItem('boekscan_history_v2', JSON.stringify(scanHistory));
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (scanHistory.length === 0) {
    list.innerHTML = '<li class="history-empty">Nog geen scans</li>';
    return;
  }
  list.innerHTML = scanHistory.map(item => {
    const winstStr = item.winst !== undefined ? `€ ${parseFloat(item.winst).toFixed(2)}` : '—';
    const winstClass = item.winst >= settings.minWinst ? 'pos' : (item.winst < 0 ? 'neg' : 'neu');
    const histClass  = item.verdict === 'green' ? 'green-hist' : item.verdict === 'yellow' ? 'yellow-hist' : 'red-hist';
    const shortTitle = (item.title || item.isbn).length > 32 ? (item.title || item.isbn).slice(0,32) + '…' : (item.title || item.isbn);
    return `
      <li class="history-item ${histClass}" onclick="lookupISBN('${item.isbn}')">
        <div class="history-info">
          <div class="history-isbn">${formatISBN(item.isbn)}</div>
          <div class="history-meta">${shortTitle}</div>
        </div>
        <div class="history-winst ${winstClass}">${winstStr}</div>
      </li>
    `;
  }).join('');
}

function clearHistory() {
  if (!confirm('Alle scangeschiedenis wissen?')) return;
  scanHistory = [];
  localStorage.removeItem('boekscan_history_v2');
  renderHistory();
}

/* ══════════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════════ */
function showLoading(msg) {
  document.getElementById('loadingMsg').textContent = msg;
  document.getElementById('loadingCard').style.display  = 'flex';
  document.getElementById('resultSection').style.display = 'none';
}
function hideLoading() {
  document.getElementById('loadingCard').style.display = 'none';
}
function hideResult() {
  document.getElementById('resultSection').style.display = 'none';
}

function showError(isbn, msg) {
  document.getElementById('resultISBN').textContent = formatISBN(isbn);
  document.getElementById('bookTitle').textContent  = 'Niet gevonden op bol.com';
  document.getElementById('pricesList').innerHTML   = `<div style="font-size:.82rem;color:var(--muted)">${msg}</div>`;
  document.getElementById('pricesCount').textContent = '';
  document.getElementById('bolLink').href = `https://www.bol.com/nl/nl/s/?searchtext=${encodeURIComponent(isbn)}`;

  const card = document.getElementById('verdictCard');
  card.className = 'verdict-card red';
  document.getElementById('verdictLight').textContent = '🔴';
  document.getElementById('verdictTitle').textContent = 'Niet gevonden';
  document.getElementById('verdictSub').textContent   = msg;

  ['calcVerkoopprijs','calcCommissieAmt','calcVerzending','calcVerpakking','calcInkoop','calcWinst'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });

  document.getElementById('resultSection').style.display = 'block';
}

function resetResult() {
  hideResult();
  hideLoading();
  currentISBN = null;
  currentPrices = [];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ══════════════════════════════════════════════════
   FEEDBACK
══════════════════════════════════════════════════ */
function triggerVibration() {
  if ('vibrate' in navigator) navigator.vibrate(150);
}

let audioCtx = null;
function playBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.4, audioCtx.currentTime + 0.01);
    gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.18);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.2);
  } catch(e) {}
}

function triggerFlash() {
  const f = document.createElement('div');
  f.className = 'success-flash';
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 500);
}

/* ══════════════════════════════════════════════════
   HULPFUNCTIES
══════════════════════════════════════════════════ */
function formatISBN(isbn) {
  if (String(isbn).length === 13) {
    const s = String(isbn);
    return `${s.slice(0,3)}-${s.slice(3,5)}-${s.slice(5,9)}-${s.slice(9,12)}-${s.slice(12)}`;
  }
  return String(isbn);
}

/* ══════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  renderHistory();
  // Laad instellingen in velden zodat ze kloppen met opgeslagen waarden
  document.getElementById('calcCommissiePct').textContent = settings.commissiePct;
});
