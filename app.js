// Scrabble Camera - stap 1: live camera, zelf het speelveld zoeken, vragen "is dit het bord?" en rechtzetten.
// Alles gebeurt op het toestel zelf; er wordt niets verstuurd.
"use strict";

const N = 15;                 // 15 x 15 vakjes
const WERK = 800;             // breedte waarop we rekenen (kleiner = sneller)
const RECHT = 450;            // grootte van het rechtgezette bord
const ZOEK_MS = 250;          // zo vaak zoeken naar het bord

const $ = id => document.getElementById(id);
const video = $("video"), over = $("over"), recht = $("recht");
const werk = document.createElement("canvas");
const STABIEL_NODIG = 4;      // zoveel keer na elkaar op dezelfde plek gevonden: dan pas vragen
const st = {
  cvKlaar: false, loopt: false, vast: false, hand: false,
  vraagt: false,         // de vraag "Is dit het bord?" staat open
  afgewezen: [],         // kaders waarop "Nee" gezegd werd: niet opnieuw voorstellen
  hoek: null,            // 4 hoeken van het speelveld in videopixels [[x,y] x4]: lb, rb, ro, lo
  geschiedenis: [], stabiel: 0, laatstGezocht: 0, handPunten: [],
};

function zetStatus(tekst, soort) {
  const s = $("status");
  s.textContent = tekst;
  s.className = soort || "";
}
function toonFout(tekst) { const f = $("fout"); f.textContent = tekst; f.hidden = !tekst; }

// ---------------------------------------------------------------- OpenCV laden
function laadCv() {
  return new Promise((klaar, mis) => {
    if (window.cv && window.cv.Mat) return klaar();
    const s = document.createElement("script");
    s.src = "opencv.js";
    s.async = true;
    s.onerror = () => mis(new Error("opencv.js kon niet geladen worden"));
    s.onload = () => {
      const kijk = () => {
        const c = window.cv;
        if (c && c.Mat) return klaar();
        if (c && typeof c.then === "function") { c.then(m => { window.cv = m; klaar(); }); return; }
        if (c && !c._wacht) { c._wacht = true; c.onRuntimeInitialized = () => klaar(); }
        setTimeout(kijk, 100);
      };
      kijk();
    };
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------- camera
async function start() {
  toonFout("");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toonFout("Deze browser geeft geen toegang tot de camera. Open de pagina via https in Chrome of Safari.");
    return;
  }
  zetStatus("Camera starten…", "zoek");
  try {
    const stroom = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stroom;
    await video.play();
  } catch (e) {
    zetStatus("Camera uit");
    toonFout(e && e.name === "NotAllowedError"
      ? "Je hebt de camera niet toegestaan. Sta de camera toe via het slotje naast het adres en probeer opnieuw."
      : "De camera start niet: " + (e && e.message ? e.message : e));
    return;
  }
  $("startvak").hidden = true;
  over.width = video.videoWidth; over.height = video.videoHeight;
  $("camera").style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
  $("opnieuw").disabled = false; $("hand").disabled = false;
  if (!st.cvKlaar) {
    zetStatus("Rekenhulp laden…", "zoek");
    try { await laadCv(); st.cvKlaar = true; }
    catch (e) { toonFout("De rekenhulp (OpenCV) laadt niet. Ververs de pagina en probeer opnieuw."); return; }
  }
  zetStatus("Bord zoeken…", "zoek");
  st.loopt = true;
  requestAnimationFrame(lus);
}

// ---------------------------------------------------------------- hoofdlus
function lus(t) {
  if (!st.loopt) return;
  if (!st.vast && !st.hand && !st.vraagt && t - st.laatstGezocht > ZOEK_MS) {
    st.laatstGezocht = t;
    try { zoekBord(); } catch (e) { console.error(e); }
  }
  teken();
  requestAnimationFrame(lus);
}

function werkbeeld() {
  const s = WERK / video.videoWidth;
  werk.width = WERK; werk.height = Math.round(video.videoHeight * s);
  const ctx = werk.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, werk.width, werk.height);
  return s;
}

// ---------------------------------------------------------------- het speelveld zoeken
function ordenHoeken(p) {
  // lb = kleinste x+y, ro = grootste x+y, rb = grootste x-y, lo = kleinste x-y
  const som = p.map(([x, y]) => x + y), ver = p.map(([x, y]) => x - y);
  const i = a => a.indexOf(Math.min(...a)), j = a => a.indexOf(Math.max(...a));
  return [p[i(som)], p[j(ver)], p[j(som)], p[i(ver)]];
}

function rasterScore(grijs, hoeken) {
  // Zet de kandidaat recht naar 300 x 300 en kijkt of er op de 14 binnenlijnen randen liggen
  // en ertussen niet. Het speelveld scoort hoog, de buitenrand van het bord of iets anders laag.
  const M = 300, v = M / N;
  const bron = cv.matFromArray(4, 1, cv.CV_32FC2, hoeken.flat());
  const doel = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, M, 0, M, M, 0, M]);
  const T = cv.getPerspectiveTransform(bron, doel);
  const w = new cv.Mat(), gx = new cv.Mat(), gy = new cv.Mat();
  cv.warpPerspective(grijs, w, T, new cv.Size(M, M));
  cv.Sobel(w, gx, cv.CV_32F, 1, 0, 3); cv.Sobel(w, gy, cv.CV_32F, 0, 1, 3);
  const kol = new Float32Array(M), rij = new Float32Array(M);
  const dx = gx.data32F, dy = gy.data32F;
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    kol[x] += Math.abs(dx[y * M + x]); rij[y] += Math.abs(dy[y * M + x]);
  }
  const verhouding = prof => {
    let op = 0, tussen = 0;
    for (let k = 1; k < N; k++) {
      const p = Math.round(k * v);
      op += Math.max(prof[p - 1], prof[p], prof[p + 1]);
      tussen += prof[Math.round((k - 0.5) * v)];
    }
    return op / (tussen + 1);
  };
  const score = (verhouding(kol) + verhouding(rij)) / 2;
  [bron, doel, T, w, gx, gy].forEach(m => m.delete());
  return score;
}

function zoekBord() {
  const s = werkbeeld();
  const src = cv.imread(werk);
  const grijs = new cv.Mat(), rand = new cv.Mat(), contouren = new cv.MatVector(), hier = new cv.Mat();
  cv.cvtColor(src, grijs, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(grijs, grijs, new cv.Size(5, 5), 0);
  cv.Canny(grijs, rand, 40, 120);
  const kern = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(rand, rand, kern);
  cv.findContours(rand, contouren, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const opp = werk.width * werk.height;
  const kandidaten = [];
  for (let i = 0; i < contouren.size(); i++) {
    const c = contouren.get(i);
    const a = cv.contourArea(c);
    if (a > 0.06 * opp && a < 0.98 * opp) {
      const benadering = new cv.Mat();
      cv.approxPolyDP(c, benadering, 0.02 * cv.arcLength(c, true), true);
      if (benadering.rows === 4 && cv.isContourConvex(benadering)) {
        const p = [];
        for (let k = 0; k < 4; k++) p.push([benadering.data32S[2 * k], benadering.data32S[2 * k + 1]]);
        const h = ordenHoeken(p);
        kandidaten.push({ h, sc: rasterScore(grijs, h) });
      }
      benadering.delete();
    }
    c.delete();
  }
  [src, grijs, rand, contouren, hier, kern].forEach(m => m.delete());
  kandidaten.sort((a, b) => b.sc - a.sc);
  const goed = kandidaten.find(k => !isAfgewezen(k.h.map(([x, y]) => [x / s, y / s])));
  const beste = goed ? goed.h : null, besteScore = goed ? goed.sc : 0;

  if (!beste || besteScore < 1.6) {
    st.stabiel = 0; st.geschiedenis = [];
    if (!st.hoek) zetStatus("Bord zoeken…", "zoek");
    else zetStatus("Bord kwijt…", "zoek");
    st.hoek = null;
    return;
  }
  const nieuw = beste.map(([x, y]) => [x / s, y / s]);       // terug naar videopixels
  st.geschiedenis.push(nieuw);
  if (st.geschiedenis.length > 5) st.geschiedenis.shift();
  // gemiddelde van de laatste metingen = rustig kader
  const gem = [0, 1, 2, 3].map(k => [0, 1].map(d =>
    st.geschiedenis.reduce((t, h) => t + h[k][d], 0) / st.geschiedenis.length));
  const maat = Math.hypot(gem[2][0] - gem[0][0], gem[2][1] - gem[0][1]);
  const sprong = Math.max(...nieuw.map((p, k) => Math.hypot(p[0] - gem[k][0], p[1] - gem[k][1])));
  st.stabiel = sprong < 0.02 * maat ? st.stabiel + 1 : 0;
  st.hoek = gem;
  st.score = besteScore;
  if (st.stabiel >= STABIEL_NODIG) vraag();
  else zetStatus("Mogelijk bord… even stil houden", "zoek");
}

function isAfgewezen(h) {
  // hetzelfde kader als een eerder afgewezen kader (hoeken binnen 6% van de grootte)?
  return st.afgewezen.some(a => {
    const maat = Math.hypot(a[2][0] - a[0][0], a[2][1] - a[0][1]);
    return h.every((p, k) => Math.hypot(p[0] - a[k][0], p[1] - a[k][1]) < 0.06 * maat);
  });
}

// ---------------------------------------------------------------- "Is dit het bord?"
function vraag() {
  st.vraagt = true;
  $("vraag").hidden = false;
  zetStatus("Is dit het bord?", "ok");
  if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
}

function bevestig() {
  st.vraagt = false; st.vast = true;
  $("vraag").hidden = true;
  zetStatus("Bord vastgezet", "ok");
}

function wijsAf() {
  if (st.hoek) st.afgewezen.push(st.hoek);
  st.vraagt = false; st.hoek = null; st.geschiedenis = []; st.stabiel = 0;
  $("vraag").hidden = true;
  zetStatus("Verder zoeken…", "zoek");
}

function opnieuwZoeken() {
  st.vast = false; st.vraagt = false; st.hand = false; st.handPunten = [];
  st.hoek = null; st.geschiedenis = []; st.stabiel = 0; st.afgewezen = [];
  $("vraag").hidden = true;
  $("hand").setAttribute("aria-pressed", "false"); $("hand").textContent = "Hoeken zelf aanduiden";
  zetStatus("Bord zoeken…", "zoek");
}

// ---------------------------------------------------------------- tekenen
function teken() {
  const c = over.getContext("2d");
  c.clearRect(0, 0, over.width, over.height);
  const lijn = Math.max(4, over.width / 160);
  if (st.hand) {
    c.fillStyle = "#f0c36b";
    st.handPunten.forEach(([x, y], i) => {
      c.beginPath(); c.arc(x, y, lijn * 3, 0, 7); c.fill();
      c.font = `${lijn * 7}px sans-serif`; c.fillText(String(i + 1), x + lijn * 4, y - lijn * 4);
    });
    return;
  }
  if (!st.hoek) return;
  const h = st.hoek;
  c.strokeStyle = (st.vast || st.vraagt) ? "#7fd18b" : "#f0c36b";
  c.lineWidth = lijn;
  c.beginPath(); h.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); c.stroke();
  // het raster zelf (dunne lijnen), via bilineaire interpolatie tussen de hoeken
  c.lineWidth = lijn / 3; c.globalAlpha = 0.6;
  const punt = (u, v) => [0, 1].map(d => (1 - u) * (1 - v) * h[0][d] + u * (1 - v) * h[1][d] + u * v * h[2][d] + (1 - u) * v * h[3][d]);
  c.beginPath();
  for (let k = 1; k < N; k++) {
    const u = k / N;
    let a = punt(u, 0), b = punt(u, 1); c.moveTo(...a); c.lineTo(...b);
    a = punt(0, u); b = punt(1, u); c.moveTo(...a); c.lineTo(...b);
  }
  c.stroke(); c.globalAlpha = 1;
  if (st.vast || st.vraagt) tekenRecht();
}

function tekenRecht() {
  if (!st.hoek || !st.cvKlaar) return;
  const s = werkbeeld();
  const src = cv.imread(werk), uit = new cv.Mat();
  const bron = cv.matFromArray(4, 1, cv.CV_32FC2, st.hoek.flat().map(v => v * s));
  const doel = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, RECHT, 0, RECHT, RECHT, 0, RECHT]);
  const T = cv.getPerspectiveTransform(bron, doel);
  cv.warpPerspective(src, uit, T, new cv.Size(RECHT, RECHT));
  cv.imshow(recht, uit);
  [src, uit, bron, doel, T].forEach(m => m.delete());
  const c = recht.getContext("2d");
  c.strokeStyle = "rgba(255,255,255,0.55)"; c.lineWidth = 1;
  c.beginPath();
  for (let k = 1; k < N; k++) {
    const p = Math.round(k * RECHT / N) + 0.5;
    c.moveTo(p, 0); c.lineTo(p, RECHT); c.moveTo(0, p); c.lineTo(RECHT, p);
  }
  c.stroke();
}

// ---------------------------------------------------------------- knoppen
$("start").addEventListener("click", start);

$("opnieuw").addEventListener("click", opnieuwZoeken);
$("ja").addEventListener("click", bevestig);
$("nee").addEventListener("click", wijsAf);

$("hand").addEventListener("click", () => {
  st.hand = !st.hand;
  st.handPunten = [];
  st.vraagt = false; $("vraag").hidden = true;
  $("hand").setAttribute("aria-pressed", String(st.hand));
  $("hand").textContent = st.hand ? "Annuleren" : "Hoeken zelf aanduiden";
  if (st.hand) zetStatus("Tik de 4 hoeken van het speelveld", "zoek");
  else opnieuwZoeken();
});

over.addEventListener("pointerdown", e => {
  if (!st.hand) return;
  // klikpositie omrekenen naar videopixels (het beeld past 'contain' in het vak)
  const r = over.getBoundingClientRect();
  const schaal = Math.min(r.width / over.width, r.height / over.height);
  const ox = (r.width - over.width * schaal) / 2, oy = (r.height - over.height * schaal) / 2;
  const x = (e.clientX - r.left - ox) / schaal, y = (e.clientY - r.top - oy) / schaal;
  if (x < 0 || y < 0 || x > over.width || y > over.height) return;
  st.handPunten.push([x, y]);
  if (st.handPunten.length === 4) {
    st.hoek = ordenHoeken(st.handPunten);
    st.hand = false; st.vast = true; st.handPunten = [];
    $("hand").setAttribute("aria-pressed", "false"); $("hand").textContent = "Hoeken zelf aanduiden";
    zetStatus("Bord vastgezet", "ok");
  }
});

// voor het testen: toestand opvragen
window.scrabbleToestand = () => ({ status: $("status").textContent, hoek: st.hoek, stabiel: st.stabiel, score: st.score, vast: st.vast, vraagt: st.vraagt, afgewezen: st.afgewezen.length });
