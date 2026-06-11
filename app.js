/**
 * BoekScan – app.js
 * Barcode scanner voor tweedehands boeken (bol.com verkopers)
 *
 * VEREISTEN VOOR CAMERA OP ANDROID:
 * ─────────────────────────────────
 * 1. De pagina MOET via HTTPS worden geserveerd (bv. via GitHub Pages,
 *    Netlify, of een eigen server met SSL-certificaat).
 *    → Op localhost werkt het ook (voor testen via USB-debugging).
 *
 * 2. Bij de eerste keer drukken op "Start Scan" vraagt Android Chrome
 *    automatisch om camera-toestemming. Klik op "Toestaan".
 *
 * 3. Geblokkeerd? Controleer: Chrome-adresbalk > 🔒 > Sitemachtigingen
 *    > Camera > Toestaan. Of: Android Instellingen > Apps > Chrome >
 *    Machtigingen > Camera.
 *
 * 4. Gebruik bij voorkeur de achtercamera (environment). De library
 *    probeert dit automatisch.
 */

'use strict';

/* ═══════════════════════════════════════════════════
   STAAT
═══════════════════════════════════════════════════ */
let html5QrCode = null;       // html5-qrcode instantie
let isScanning  = false;      // bewaakt of de camera loopt
const MAX_HISTORY = 5;        // maximale geschiedenis grootte

/* Haal bestaande geschiedenis op uit localStorage */
let scanHistory = JSON.parse(localStorage.getItem('boekscan_history') || '[]');

/* ═══════════════════════════════════════════════════
   INITIALISATIE
═══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  renderHistory();   // herstel geschiedenis bij het laden
  initBeep();        // laad Web Audio beep
});

/* ═══════════════════════════════════════════════════
   SCANNER – STARTEN
═══════════════════════════════════════════════════ */
async function startScanner() {
  if (isScanning) return;

  /* html5QrCode verwacht een DOM-element ID als container */
  html5QrCode = new Html5Qrcode('reader');

  const config = {
    fps: 15,               // frames per seconde (hoger = sneller maar zwaarder)
    qrbox: { width: 240, height: 120 },  // scan-zone (rechthoek voor barcodes)
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.CODE_128,
      Html5QrcodeSupportedFormats.UPC_A,
    ],
    experimentalFeatures: {
      useBarCodeDetectorIfSupported: true, // sneller op moderne Android
    },
    rememberLastUsedCamera: true,
    aspectRatio: 1.0,      // vierkante viewfinder
  };

  try {
    /*
     * facingMode: 'environment' = achtercamera op Android.
     * De library vraagt zelf camera-toestemming via de browser-API.
     */
    await html5QrCode.start(
      { facingMode: 'environment' },
      config,
      onScanSuccess,
      onScanError
    );

    isScanning = true;
    document.getElementById('idleMsg').style.display = 'none';
    document.getElementById('scanLine').style.display = 'block';
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('stopBtn').style.display = 'inline-flex';

  } catch (err) {
    console.error('Camera kon niet worden gestart:', err);
    showCameraError(err);
  }
}

/* ═══════════════════════════════════════════════════
   SCANNER – STOPPEN
═══════════════════════════════════════════════════ */
async function stopScanner() {
  if (!isScanning || !html5QrCode) return;

  try {
    await html5QrCode.stop();
    html5QrCode.clear();
  } catch (e) {
    console.warn('Stop fout (kan genegeerd worden):', e);
  }

  isScanning = false;
  html5QrCode = null;
  document.getElementById('scanLine').style.display = 'none';
  document.getElementById('idleMsg').style.display = 'flex';
  document.getElementById('startBtn').style.display = 'inline-flex';
  document.getElementById('stopBtn').style.display = 'none';
}

/* ═══════════════════════════════════════════════════
   CALLBACK – SUCCESVOLLE SCAN
═══════════════════════════════════════════════════ */
async function onScanSuccess(decodedText, decodedResult) {
  /* Voorkom dubbele triggers voor dezelfde code */
  if (!isScanning) return;

  const isbn = decodedText.trim();
  console.log('Gescand:', isbn, decodedResult);

  /* Stop de scanner na een succesvolle scan */
  await stopScanner();

  /* Vibreer (Android trilmotor) – 150ms kort trilletje */
  triggerVibration();

  /* Speel beep-geluid */
  playBeep();

  /* Flash-effect op het scherm */
  triggerFlash();

  /* Toon resultaat */
  showResult(isbn);

  /* Voeg toe aan geschiedenis */
  addToHistory(isbn);

  /* Haal API-data op (placeholder – zie functie onderaan) */
  fetchBolData(isbn);
}

/* ═══════════════════════════════════════════════════
   CALLBACK – SCAN FOUT (elke frame zonder resultaat)
   Dit wordt continu aangeroepen als er geen barcode is.
   Stille fout – we loggen alleen echte fouten.
═══════════════════════════════════════════════════ */
function onScanError(err) {
  // Negeer 'NotFoundException' – dat is normaal (geen barcode in beeld)
  // Logica: als de fout geen 'NotFoundException' is, log dan wél.
  if (!err || !err.includes('NotFoundException')) {
    // console.warn('Scan-fout:', err);
  }
}

/* ═══════════════════════════════════════════════════
   RESULTAAT TONEN
═══════════════════════════════════════════════════ */
function showResult(isbn) {
  const section = document.getElementById('resultSection');
  const isbnEl  = document.getElementById('resultISBN');
  const bolLink = document.getElementById('bolLink');

  isbnEl.textContent = formatISBN(isbn);

  /*
   * Bol.com zoek-URL: https://www.bol.com/nl/nl/s/?searchtext=<ISBN>
   * Opent de bol.com zoekresultaten direct gefilterd op het ISBN.
   */
  bolLink.href = `https://www.bol.com/nl/nl/s/?searchtext=${encodeURIComponent(isbn)}`;

  /* Reset API-velden naar laadstatus */
  setApiField('apiPrijs',     '⏳', true);
  setApiField('apiCommissie', '⏳', true);
  setApiField('apiRank',      '⏳', true);

  section.style.display = 'block';

  /* Scroll naar het resultaat */
  setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

/* Verberg resultaat en herstel de scanpositie */
function resetResult() {
  document.getElementById('resultSection').style.display = 'none';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ═══════════════════════════════════════════════════
   BOL.COM RETAILER API – PLACEHOLDERS
   ───────────────────────────────────────────────────
   Vervang deze functies zodra je een bol.com Retailer-
   account hebt en een API-sleutel hebt aangemaakt via:
   https://partnerplatform.bol.com/
   
   De Retailer API gebruikt OAuth 2.0 client_credentials.
   Stap 1: POST https://login.bol.com/token → access_token
   Stap 2: GET  https://api.bol.com/retailer/products/{ean}/offers
   Stap 3: Verwerk de JSON-response voor prijs, commissie, rank.
   
   LET OP: API-calls mogen NIET vanuit de browser worden
   gedaan (CORS + geheime sleutels). Gebruik een eigen
   backend (Node.js / PHP / Python) als tussenpersoon.
═══════════════════════════════════════════════════ */
async function fetchBolData(isbn) {
  try {
    /* 
     * PLACEHOLDER – vervang dit door een echte API-aanroep.
     * Simuleer een netwerk-vertraging van 1.5 seconden voor demo.
     */
    await simulateApiDelay(1500);

    /* Simuleer een response (vervang door echte data) */
    const mockData = getMockBolData(isbn);

    setApiField('apiPrijs',     mockData.prijs     || '—');
    setApiField('apiCommissie', mockData.commissie || '—');
    setApiField('apiRank',      mockData.salesRank || '—');

  } catch (error) {
    console.error('Bol.com API fout:', error);
    setApiField('apiPrijs',     'Fout');
    setApiField('apiCommissie', 'Fout');
    setApiField('apiRank',      'Fout');
  }
}

/**
 * fetchBolAccessToken()
 * PLACEHOLDER – haal OAuth2 token op via jouw backend.
 *
 * @returns {Promise<string>} access token
 *
 * Voorbeeld backend-aanroep (jij implementeert dit):
 *   const res = await fetch('https://jouw-server.nl/api/bol-token');
 *   const { access_token } = await res.json();
 *   return access_token;
 */
async function fetchBolAccessToken() {
  throw new Error('Implementeer fetchBolAccessToken() via jouw backend.');
}

/**
 * fetchBolProductData(isbn, accessToken)
 * PLACEHOLDER – haal product/offers data op via jouw backend.
 *
 * @param {string} isbn        - het gescande EAN/ISBN
 * @param {string} accessToken - OAuth2 token van fetchBolAccessToken()
 * @returns {Promise<object>}  - ruwe API-response
 *
 * Documentatie: https://api.bol.com/retailer/public/redoc/v10/retailer.html
 */
async function fetchBolProductData(isbn, accessToken) {
  throw new Error('Implementeer fetchBolProductData() via jouw backend.');
}

/* ─── Hulpfuncties voor placeholder ─── */
function simulateApiDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMockBolData(isbn) {
  /* Dummy data – vervang door echte API-response parsing */
  return {
    prijs:     '€ 9,99 (bol.com)',
    commissie: '15% ≈ € 1,50',
    salesRank: '#342 in Boeken',
  };
}

/* ═══════════════════════════════════════════════════
   GESCHIEDENIS
═══════════════════════════════════════════════════ */
function addToHistory(isbn) {
  /* Verwijder duplicaat als dat al bestaat */
  scanHistory = scanHistory.filter(item => item.isbn !== isbn);

  /* Voeg vooraan toe */
  scanHistory.unshift({
    isbn,
    timestamp: new Date().toISOString(),
  });

  /* Behoud maximaal MAX_HISTORY items */
  if (scanHistory.length > MAX_HISTORY) {
    scanHistory = scanHistory.slice(0, MAX_HISTORY);
  }

  /* Sla op in localStorage zodat de data bewaard blijft */
  localStorage.setItem('boekscan_history', JSON.stringify(scanHistory));

  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('historyList');

  if (scanHistory.length === 0) {
    list.innerHTML = '<li class="history-empty">Nog geen scans — begin met scannen!</li>';
    return;
  }

  list.innerHTML = scanHistory.map(item => {
    const bolUrl = `https://www.bol.com/nl/nl/s/?searchtext=${encodeURIComponent(item.isbn)}`;
    const time   = formatRelativeTime(item.timestamp);

    return `
      <li class="history-item">
        <div>
          <div class="history-isbn">${formatISBN(item.isbn)}</div>
          <div class="history-time">${time}</div>
        </div>
        <a class="history-bol-btn" href="${bolUrl}" target="_blank" rel="noopener">
          bol.com ↗
        </a>
      </li>
    `;
  }).join('');
}

/* ═══════════════════════════════════════════════════
   TRILLEN (Vibration API)
═══════════════════════════════════════════════════ */
function triggerVibration() {
  /* 
   * De Vibration API werkt op Android Chrome.
   * Patroon: [150] = 150ms trillen.
   * Op iOS Safari is deze API niet beschikbaar (wordt stilletjes genegeerd).
   */
  if ('vibrate' in navigator) {
    navigator.vibrate(150);
  }
}

/* ═══════════════════════════════════════════════════
   BEEP GELUID (Web Audio API)
   Genereert een kort 880Hz beep zonder externe audio-bestanden.
═══════════════════════════════════════════════════ */
let audioCtx = null;

function initBeep() {
  /* AudioContext wordt aangemaakt bij user-interactie (autoplay-policy) */
}

function playBeep() {
  try {
    /* Maak AudioContext aan (of hergebruik bestaande) */
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    const oscillator = audioCtx.createOscillator();
    const gainNode   = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.type      = 'sine';
    oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);  // A5 toon

    /* Zachte envelope: snel aanzetten, snel uitzetten */
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.4, audioCtx.currentTime + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.18);

    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 0.2);

  } catch (e) {
    console.warn('Beep kon niet worden afgespeeld:', e);
  }
}

/* ═══════════════════════════════════════════════════
   VISUELE FEEDBACK – scherm-flash
═══════════════════════════════════════════════════ */
function triggerFlash() {
  const flash = document.createElement('div');
  flash.className = 'success-flash';
  document.body.appendChild(flash);
  /* CSS-animatie ruimt zichzelf op na 0.5s */
  setTimeout(() => flash.remove(), 500);
}

/* ═══════════════════════════════════════════════════
   CAMERA FOUTMELDING
═══════════════════════════════════════════════════ */
function showCameraError(err) {
  const msg = document.getElementById('idleMsg');
  msg.style.display = 'flex';
  msg.innerHTML = `
    <span>⚠️</span>
    <p style="color:#FF4444; font-size:0.85rem">
      Camera niet beschikbaar.<br/>
      Controleer rechten in browser-instellingen.<br/>
      <small style="color:#666">${err?.message || err}</small>
    </p>
  `;
}

/* ═══════════════════════════════════════════════════
   HULPFUNCTIES
═══════════════════════════════════════════════════ */

/** Zet een API-veld op een waarde, optioneel met loading-stijl */
function setApiField(id, value, isLoading = false) {
  const el = document.getElementById(id);
  el.textContent = value;
  el.className   = 'api-val' + (isLoading ? ' loading' : '');
}

/**
 * Formatteer een ISBN-13 als groepen: 978-90-1234-567-8
 * Voor andere lengtes: geef ongewijzigd terug.
 */
function formatISBN(isbn) {
  if (isbn.length === 13) {
    return `${isbn.slice(0,3)}-${isbn.slice(3,5)}-${isbn.slice(5,9)}-${isbn.slice(9,12)}-${isbn.slice(12)}`;
  }
  return isbn;
}

/** Toon een relatieve tijdstempel zoals "2 min geleden" */
function formatRelativeTime(isoString) {
  const diffMs  = Date.now() - new Date(isoString).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffH   = Math.floor(diffMin / 60);

  if (diffMin < 1)  return 'Zojuist';
  if (diffMin < 60) return `${diffMin} min geleden`;
  if (diffH < 24)   return `${diffH} uur geleden`;
  return new Date(isoString).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}
