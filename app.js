// Scrabble Camera - stap 1: live camera, zelf het speelveld zoeken, vragen "is dit het bord?" en rechtzetten.
// Het bord zoeken: kaders vinden (randen in helderheid en kleur), daarbinnen het raster van 16 x 16 lijnen inpassen.
// Alles gebeurt op het toestel zelf; er wordt niets verstuurd.
"use strict";

const N = 15;                 // 15 x 15 vakjes
const WERK = 800;             // breedte waarop we rekenen (kleiner = sneller)
const RECHT = 450;            // grootte van het rechtgezette bord
const ZOEK_MS = 300;          // zo vaak zoeken naar het bord

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
    zetStatus("Scrabble");
    toonFout(e && e.name === "NotAllowedError"
      ? "Je hebt de camera niet toegestaan. Sta de camera toe via het slotje naast het adres en probeer opnieuw."
      : "De camera start niet: " + (e && e.message ? e.message : e));
    return;
  }
  $("startvak").hidden = true;
  over.width = video.videoWidth; over.height = video.videoHeight;
  $("opnieuw").disabled = false; $("hand").disabled = false;
  $("acties").hidden = false;
  if (!st.cvKlaar) {
    zetStatus("Even laden…", "zoek");
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

// ---- het raster van 15 x 15 binnen een kader zoeken
// Een kader (bv. de buitenrand van het bord) wordt rechtgezet. Dan zoeken we per richting waar de
// 16 rasterlijnen liggen: 16 gelijk verdeelde lijnen met sterke randen erop en weinig ertussen.
// Zo vinden we het speelveld ook als er geen duidelijke lijn rond het speelveld zelf loopt.
const R_MAAT = 360, R_MARGE = 20, R_L = R_MAAT - 2 * R_MARGE;

const DREMPEL_LIJN = 1.6;   // zo veel sterker dan het midden van de vakjes ernaast = "hier ligt een lijn"

function profielPassing(prof, aVan, aTot, bVan, bTot, stapGrootte, tol) {
  // Beste begin a en einde b (als deel van het kader) voor 16 gelijk verdeelde lijnen.
  // Score = aantal lijnen dat er echt is, min een straf als er net buiten het raster nóg een lijn ligt
  // (dan is het raster een vakje verschoven en telt de rand van het bord als lijn).
  const n = prof.length;
  const p = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) p[i] = (prof[i - 1] + 2 * prof[i] + prof[i + 1]) / 4;
  const waarde = x => {
    const i = Math.round(x);
    if (i < tol || i >= n - tol) return 0;
    let m = 0;
    for (let d = -tol; d <= tol; d++) m = Math.max(m, p[i + d]);
    return m;
  };
  const midden = x => { const i = Math.round(x); return i < 0 || i >= n ? 0 : p[i]; };
  let best = { s: -99, a: 0, b: 1 };
  for (let a = aVan; a <= aTot + 1e-9; a += stapGrootte) {
    for (let b = bVan; b <= bTot + 1e-9; b += stapGrootte) {
      if (b - a < 0.6) continue;
      const stap = (b - a) * R_L / N, x0 = R_MARGE + a * R_L;
      const c = k => waarde(x0 + k * stap) / ((midden(x0 + (k - 0.5) * stap) + midden(x0 + (k + 0.5) * stap)) / 2 + 1);
      let treffers = 0, sterkte = 0;
      for (let k = 0; k <= N; k++) { const v = c(k); if (v > DREMPEL_LIJN) treffers++; sterkte += Math.min(v, 4); }
      const buiten = (c(-1) > DREMPEL_LIJN ? 1 : 0) + (c(N + 1) > DREMPEL_LIJN ? 1 : 0);
      const sc = treffers - 2 * buiten + 0.1 * sterkte / (N + 1);
      if (sc > best.s) best = { s: sc, a, b };
    }
  }
  return best;
}

const GROF = [-0.04, 0.18, 0.82, 1.04, 0.004, 1], FIJN = [-0.03, 0.03, 0.97, 1.03, 0.002, 1], HEEL_FIJN = [-0.01, 0.01, 0.99, 1.01, 0.001, 0];

function vindRaster(grijs, kader, zoek) {
  const bron = cv.matFromArray(4, 1, cv.CV_32FC2, kader.flat());
  const doel = cv.matFromArray(4, 1, cv.CV_32FC2,
    [R_MARGE, R_MARGE, R_MARGE + R_L, R_MARGE, R_MARGE + R_L, R_MARGE + R_L, R_MARGE, R_MARGE + R_L]);
  const T = cv.getPerspectiveTransform(bron, doel);
  const w = new cv.Mat(), gx = new cv.Mat(), gy = new cv.Mat();
  cv.warpPerspective(grijs, w, T, new cv.Size(R_MAAT, R_MAAT));
  cv.Sobel(w, gx, cv.CV_32F, 1, 0, 3); cv.Sobel(w, gy, cv.CV_32F, 0, 1, 3);
  const kol = new Float32Array(R_MAAT), rij = new Float32Array(R_MAAT);
  const dx = gx.data32F, dy = gy.data32F;
  for (let y = R_MARGE; y < R_MAAT - R_MARGE; y++) for (let x = 0; x < R_MAAT; x++) kol[x] += Math.abs(dx[y * R_MAAT + x]);
  for (let y = 0; y < R_MAAT; y++) for (let x = R_MARGE; x < R_MAAT - R_MARGE; x++) rij[y] += Math.abs(dy[y * R_MAAT + x]);
  const px = profielPassing(kol, ...zoek), py = profielPassing(rij, ...zoek);
  // gevonden raster terugrekenen naar het camerabeeld
  const X = a => R_MARGE + a * R_L;
  const pts = cv.matFromArray(4, 1, cv.CV_32FC2,
    [X(px.a), X(py.a), X(px.b), X(py.a), X(px.b), X(py.b), X(px.a), X(py.b)]);
  const inv = new cv.Mat(), terug = new cv.Mat();
  let h = kader, sc = 0;
  if (cv.invert(T, inv, cv.DECOMP_LU) !== 0) {
    cv.perspectiveTransform(pts, terug, inv);
    h = [0, 1, 2, 3].map(k => [terug.data32F[2 * k], terug.data32F[2 * k + 1]]);
    sc = Math.min(px.s, py.s);
  }
  [bron, doel, T, w, gx, gy, pts, inv, terug].forEach(m => m.delete());
  return { h, sc };
}

function vierhoek(c, opp) {
  // contour -> vierhoek via de omhullende (werkt ook als een stuk van de rand ontbreekt)
  const romp = new cv.Mat();
  cv.convexHull(c, romp, false, true);
  const omtrek = cv.arcLength(romp, true);
  let uit = null;
  for (let e = 0.01; e <= 0.08 && !uit; e += 0.01) {
    const b = new cv.Mat();
    cv.approxPolyDP(romp, b, e * omtrek, true);
    if (b.rows === 4 && cv.contourArea(b) > 0.04 * opp) {
      const p = [];
      for (let k = 0; k < 4; k++) p.push([b.data32S[2 * k], b.data32S[2 * k + 1]]);
      uit = ordenHoeken(p);
    }
    b.delete();
  }
  romp.delete();
  return uit;
}

function zoekBord() {
  const s = werkbeeld();
  const src = cv.imread(werk);
  const grijs = new cv.Mat(), hsv = new cv.Mat(), rgb = new cv.Mat(), kanalen = new cv.MatVector();
  cv.cvtColor(src, grijs, cv.COLOR_RGBA2GRAY);
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  cv.split(hsv, kanalen);
  const verzadiging = kanalen.get(1);
  cv.GaussianBlur(grijs, grijs, new cv.Size(5, 5), 0);
  cv.GaussianBlur(verzadiging, verzadiging, new cv.Size(5, 5), 0);
  const opp = werk.width * werk.height;
  const kaders = [];
  const kern = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  // randen zoeken in helderheid én in kleurverzadiging (bord en tafel verschillen vaak vooral in kleur)
  for (const [beeld, lo, hi] of [[grijs, 30, 90], [grijs, 60, 160], [verzadiging, 30, 90]]) {
    const rand = new cv.Mat(), contouren = new cv.MatVector(), hier = new cv.Mat();
    cv.Canny(beeld, rand, lo, hi);
    cv.dilate(rand, rand, kern);
    cv.findContours(rand, contouren, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contouren.size(); i++) {
      const c = contouren.get(i);
      const r = cv.boundingRect(c);
      if (r.width * r.height > 0.06 * opp) {
        const h = vierhoek(c, opp);
        if (h) kaders.push({ h, opp: cv.contourArea(cv.matFromArray(4, 1, cv.CV_32SC2, h.flat().map(Math.round))) });
      }
      c.delete();
    }
    [rand, contouren, hier].forEach(m => m.delete());
  }
  // dubbele kaders weg, de grootste eerst, hooguit 8 nader bekijken
  kaders.sort((a, b) => b.opp - a.opp);
  const uniek = [];
  for (const k of kaders) {
    const maat = Math.hypot(k.h[2][0] - k.h[0][0], k.h[2][1] - k.h[0][1]);
    if (!uniek.some(u => u.h.every((p, i) => Math.hypot(p[0] - k.h[i][0], p[1] - k.h[i][1]) < 0.03 * maat))) uniek.push(k);
    if (uniek.length >= 8) break;
  }
  // per kader: eerst grof zoeken, dan twee keer verfijnen met het gevonden raster als nieuw kader
  const kandidaten = uniek.map(k => {
    let r = vindRaster(grijs, k.h, GROF);
    if (r.sc > 10) r = vindRaster(grijs, r.h, FIJN);
    if (r.sc > 10) r = vindRaster(grijs, r.h, HEEL_FIJN);
    return r;
  });
  [src, grijs, hsv, rgb, kanalen, verzadiging, kern].forEach(m => m.delete());
  kandidaten.sort((a, b) => b.sc - a.sc);
  const geldig = kandidaten
    .filter(k => k.sc >= 14.5)                                  // minstens 15 van de 16 lijnen in elke richting
    .map(k => ({ sc: k.sc, h: k.h.map(([x, y]) => [x / s, y / s]) }))   // terug naar videopixels
    .filter(k => !isAfgewezen(k.h));
  // voorkeur voor wat we vorige keer ook al zagen: zo springt het kader niet heen en weer
  let keuze = geldig[0] || null;
  if (st.hoek) {
    const dichtbij = geldig.find(k => zelfdeKader(k.h, st.hoek, 0.04));
    if (dichtbij) keuze = dichtbij;
  }
  st.geschiedenis.push(keuze ? keuze.h : null);
  if (st.geschiedenis.length > 8) st.geschiedenis.shift();
  if (!keuze) {
    if (!st.geschiedenis.some(Boolean)) { st.hoek = null; zetStatus("Bord zoeken…", "zoek"); }
    return;
  }
  // hoeveel van de laatste metingen zagen (ongeveer) hetzelfde kader?
  const gelijk = st.geschiedenis.filter(h => h && zelfdeKader(h, keuze.h, 0.03));
  st.stabiel = gelijk.length;
  st.hoek = [0, 1, 2, 3].map(k => [0, 1].map(d => gelijk.reduce((t, h) => t + h[k][d], 0) / gelijk.length));
  st.score = keuze.sc;
  if (st.stabiel >= STABIEL_NODIG) vraag();
  else zetStatus("Mogelijk bord… even stil houden", "zoek");
}

function zelfdeKader(a, b, marge) {
  const maat = Math.hypot(b[2][0] - b[0][0], b[2][1] - b[0][1]);
  return a.every((p, k) => Math.hypot(p[0] - b[k][0], p[1] - b[k][1]) < marge * maat);
}

function isAfgewezen(h) {
  // hetzelfde kader als een eerder afgewezen kader (hoeken binnen 6% van de grootte)?
  return st.afgewezen.some(a => zelfdeKader(h, a, 0.06));
}

// ---------------------------------------------------------------- "Is dit het bord?"
function vraag() {
  st.vraagt = true;
  $("vraag").hidden = false; $("acties").hidden = true;
  zetStatus("Is dit het bord?", "ok");
  if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
}

function bevestig() {
  st.vraagt = false; st.vast = true;
  $("vraag").hidden = true; $("acties").hidden = false; $("recht").hidden = false;
  zetStatus("Bord vastgezet", "ok");
}

function wijsAf() {
  if (st.hoek) st.afgewezen.push(st.hoek);
  st.vraagt = false; st.hoek = null; st.geschiedenis = []; st.stabiel = 0;
  $("vraag").hidden = true; $("acties").hidden = false;
  zetStatus("Verder zoeken…", "zoek");
}

function opnieuwZoeken() {
  st.vast = false; st.vraagt = false; st.hand = false; st.handPunten = [];
  st.hoek = null; st.geschiedenis = []; st.stabiel = 0; st.afgewezen = [];
  $("vraag").hidden = true; $("acties").hidden = false; $("recht").hidden = true;
  $("hand").setAttribute("aria-pressed", "false"); $("hand").textContent = "Zelf aanduiden";
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
  if (st.vast) tekenRecht();
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
  $("hand").textContent = st.hand ? "Annuleren" : "Zelf aanduiden";
  if (st.hand) { zetStatus("Tik de 4 hoeken van het speelveld", "zoek"); $("recht").hidden = true; }
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
    $("hand").setAttribute("aria-pressed", "false"); $("hand").textContent = "Zelf aanduiden";
    $("recht").hidden = false;
    zetStatus("Bord vastgezet", "ok");
  }
});

// voor het testen: toestand opvragen
window.scrabbleToestand = () => ({ status: $("status").textContent, hoek: st.hoek, stabiel: st.stabiel, score: st.score, vast: st.vast, vraagt: st.vraagt, afgewezen: st.afgewezen.length });
