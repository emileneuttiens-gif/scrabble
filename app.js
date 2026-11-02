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
const LEES_MS = 500;          // zo vaak de letters lezen als het bord vastligt
const STEMMEN = 5, STEMMEN_NODIG = 3;
const RUSTIG = 4;             // een fout woord pas tonen als het 4 lezingen (2 s) niet meer veranderde   // een letter telt pas als hij 3 van de laatste 5 keer gelezen werd
const vol = document.createElement("canvas");   // camerabeeld op volle grootte, om de letters te lezen
const st = {
  cvKlaar: false, loopt: false, vast: false, hand: false,
  vraagt: false,         // de vraag "Is dit het bord?" staat open
  afgewezen: [],         // kaders waarop "Nee" gezegd werd: niet opnieuw voorstellen
  hoek: null,            // 4 hoeken van het speelveld in videopixels [[x,y] x4]: lb, rb, ro, lo
  geschiedenis: [], stabiel: 0, laatstGezocht: 0, handPunten: [],
  lees: null,            // { laatst, stemmen[r][c] = [...], letters[r][c], woorden }
};

// het spel: wat er al lag (basis), de zetten en de spelers. Blijft bestaan als het bord opnieuw gezocht wordt.
const spel = { basis: null, zetten: [], spelers: ["Speler 1", "Speler 2"], aanBeurt: 0, kandidaat: null, melding: null };

function nieuwLezen() {
  st.lees = { laatst: 0, stemmen: [...Array(N)].map(() => [...Array(N)].map(() => [])),
              kansen: [...Array(N)].map(() => [...Array(N)].map(() => [])),
              letters: [...Array(N)].map(() => Array(N).fill(null)), woorden: [],
              lezingen: 0, opwarmen: !spel.basis,   // nieuw spel: eerst rustig alles lezen wat er al ligt
              sinds: [...Array(N)].map(() => Array(N).fill(0)),   // hoeveel lezingen dit vakje al hetzelfde is
              jokerKeuze: {},     // "r,c" -> letter die de speler voor de joker koos
              jokerVraag: null }; // { r, c, opties } als we moeten vragen welke letter de joker is
  toonJokerVraag();
}

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
    $("startvak").hidden = false;   // opnieuw proberen
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
  const leesNu = st.vast && st.lees && window.Lezer && Lezer.klaar() && t - st.lees.laatst > LEES_MS;
  if ((st.vast || st.vraagt) && (t - volg.laatst > VOLG_MS || leesNu)) {
    volg.laatst = t;
    try { volgBord(t); } catch (e) { console.error(e); }
  }
  if (st.vast && !volg.kwijt && t - volg.laatstControle > CONTROLE_MS) {
    volg.laatstControle = t;
    try { controleerBord(); } catch (e) { console.error(e); }
  }
  // lezen meteen na het volgen (zelfde beeld), en alleen als het beeld op dit moment rustig is
  if (leesNu && st.vast && t - volg.bewogen > STIL_MS && volg.stap < 0.15 && !volg.kwijt) {
    st.lees.laatst = t;
    try { leesLetters(); tekenRecht(); } catch (e) { console.error(e); }
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

// ---- het vaste patroon van de premievakjes (hetzelfde op elk standaard Scrabblebord)
const PREMIE = (() => {
  const m = new Uint8Array(N * N);
  const zet = lijst => lijst.forEach(([r, c]) => { m[r * N + c] = 1; });
  zet([[0,0],[0,7],[0,14],[7,0],[7,14],[14,0],[14,7],[14,14]]);                                  // woordwaarde x3
  for (let i = 1; i < 5; i++) zet([[i,i],[i,14-i],[14-i,i],[14-i,14-i]]);                          // woordwaarde x2
  zet([[7,7]]);
  zet([[1,5],[1,9],[5,1],[5,5],[5,9],[5,13],[9,1],[9,5],[9,9],[9,13],[13,5],[13,9]]);              // letterwaarde x3
  zet([[0,3],[0,11],[2,6],[2,8],[3,0],[3,7],[3,14],[6,2],[6,6],[6,8],[6,12],[7,3],[7,11],[8,2],    // letterwaarde x2
       [8,6],[8,8],[8,12],[11,0],[11,7],[11,14],[12,6],[12,8],[14,3],[14,11]]);
  return m;
})();

function premieVerschuiving(rgb, h) {
  // Zet het raster plus één vakje rondom recht (17 x 17), neemt per vakje de kleur van het midden,
  // en kijkt bij welke verschuiving (-1, 0, +1 vakje) de premievakjes het duidelijkst afwijken van de gewone.
  const C = 16, M = N + 2;
  const bron = cv.matFromArray(4, 1, cv.CV_32FC2, h.flat());
  const doel = cv.matFromArray(4, 1, cv.CV_32FC2, [C, C, (N + 1) * C, C, (N + 1) * C, (N + 1) * C, C, (N + 1) * C]);
  const T = cv.getPerspectiveTransform(bron, doel);
  const w = new cv.Mat(), lab = new cv.Mat();
  cv.warpPerspective(rgb, w, T, new cv.Size(M * C, M * C));
  cv.cvtColor(w, lab, cv.COLOR_RGB2Lab);
  const d = lab.data, kleur = new Float32Array(M * M * 3);
  for (let r = 0; r < M; r++) for (let c = 0; c < M; c++) {
    let a = 0, b = 0, l = 0;
    for (let y = r * C + 4; y < r * C + 12; y++) for (let x = c * C + 4; x < c * C + 12; x++) {
      const i = (y * M * C + x) * 3; l += d[i]; a += d[i + 1]; b += d[i + 2];
    }
    const k = (r * M + c) * 3; kleur[k] = l / 64; kleur[k + 1] = a / 64; kleur[k + 2] = b / 64;
  }
  [bron, doel, T, w, lab].forEach(m => m.delete());
  let best = { score: -9, dx: 0, dy: 0 };
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cel = (r, c) => ((r + 1 + dy) * M + (c + 1 + dx)) * 3;
    // 'gewone' kleur = mediaan van de gewone vakjes
    const gewoon = [0, 1, 2].map(j => {
      const v = [];
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!PREMIE[r * N + c]) v.push(kleur[cel(r, c) + j]);
      v.sort((x, y) => x - y);
      return v[v.length >> 1];
    });
    let sp = 0, np_ = 0, sg = 0, ng = 0, som = 0, som2 = 0;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const i = cel(r, c);
      const afstand = Math.hypot(kleur[i] - gewoon[0], kleur[i + 1] - gewoon[1], kleur[i + 2] - gewoon[2]);
      if (PREMIE[r * N + c]) { sp += afstand; np_++; } else { sg += afstand; ng++; }
      som += afstand; som2 += afstand * afstand;
    }
    const gem = som / (N * N), sd = Math.sqrt(Math.max(som2 / (N * N) - gem * gem, 0)) + 1e-3;
    const score = (sp / np_ - sg / ng) / sd;
    if (score > best.score) best = { score, dx, dy };
  }
  return best;
}

function verschuif(h, dx, dy) {
  // het raster een heel vakje opschuiven, langs zijn eigen (schuine) richtingen
  const bron = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, N, 0, N, N, 0, N]);
  const doel = cv.matFromArray(4, 1, cv.CV_32FC2, h.flat());
  const T = cv.getPerspectiveTransform(bron, doel);
  const pts = cv.matFromArray(4, 1, cv.CV_32FC2, [dx, dy, N + dx, dy, N + dx, N + dy, dx, N + dy]);
  const uit = new cv.Mat();
  cv.perspectiveTransform(pts, uit, T);
  const r = [0, 1, 2, 3].map(k => [uit.data32F[2 * k], uit.data32F[2 * k + 1]]);
  [bron, doel, T, pts, uit].forEach(m => m.delete());
  return r;
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
  const geldig = bordKandidaten();
  zoekBordStap(geldig);
}

// alle goede kandidaat-borden in het huidige beeld (in videopixels), beste eerst
function bordKandidaten() {
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
    if (r.sc >= 12) {
      // controle met het vaste patroon van de premievakjes: ligt het raster een vakje verschoven
      // (bv. omdat letters in de rand van het bord op rasterlijnen lijken), dan schuiven we het terug
      const p = premieVerschuiving(rgb, r.h);
      r.patroon = p.score;
      if (p.dx || p.dy) {
        const terug = vindRaster(grijs, verschuif(r.h, p.dx, p.dy), HEEL_FIJN);
        if (terug.sc >= 12) { r = terug; r.patroon = p.score; }
      }
    }
    return r;
  });
  [src, grijs, hsv, rgb, kanalen, verzadiging, kern].forEach(m => m.delete());
  kandidaten.sort((a, b) => (b.patroon || 0) - (a.patroon || 0) || b.sc - a.sc);
  const geldig = kandidaten
    // rasterlijnen kloppen (15 van de 16) en het premiepatroon klopt, of: het patroon klopt heel duidelijk
    // en de meeste lijnen zijn er (bij een heel schuin bord zijn de verste lijnen soms te dun om te zien)
    .filter(k => (k.sc >= 14.5 && k.patroon >= 0.6) || (k.sc >= 12 && k.patroon >= 1.0))
    .map(k => ({ sc: k.sc, h: k.h.map(([x, y]) => [x / s, y / s]) }))   // terug naar videopixels
    .filter(k => !isAfgewezen(k.h));
  return geldig;
}

function zoekBordStap(geldig) {
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
  if (st.stabiel >= STABIEL_NODIG) {
    st.hoek = keuze.h;   // de laatste meting, niet het gemiddelde: vanaf hier volgen we het bord
    // bord kwijt geweest midden in een spel: meteen weer vastzetten, zonder opnieuw te vragen
    if (volg.terugzoeken) { volg.terugzoeken = false; bevestig(); zetStatus("Bord terug", "ok"); }
    else vraag();
  }
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
  st.vraagt = true; volgStart();   // tijdens de vraag het bord al volgen: de gsm beweegt intussen
  $("vraag").hidden = false; $("acties").hidden = true;
  zetStatus("Is dit het bord?", "ok");
  if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
}

function bevestig() {
  const volgde = st.vraagt;
  st.vraagt = false; st.vast = true; nieuwLezen();
  if (!volgde) volgStart();
  $("vraag").hidden = true; $("acties").hidden = false; $("recht").hidden = false;
  zetStatus("Letters lezen…", "ok");
}

function wijsAf() {
  volgStop();
  if (st.hoek) st.afgewezen.push(st.hoek);
  st.vraagt = false; st.hoek = null; st.geschiedenis = []; st.stabiel = 0;
  $("vraag").hidden = true; $("acties").hidden = false;
  zetStatus("Verder zoeken…", "zoek");
}

function opnieuwZoeken() {
  volgStop(); volg.terugzoeken = false;
  st.vast = false; st.vraagt = false; st.hand = false; st.handPunten = [];
  st.hoek = null; st.geschiedenis = []; st.stabiel = 0; st.afgewezen = []; st.lees = null;
  $("jokervraag").hidden = true;
  $("vraag").hidden = true; $("acties").hidden = false; $("recht").hidden = true;
  $("hand").setAttribute("aria-pressed", "false"); $("hand").textContent = "Zelf aanduiden";
  zetStatus("Bord zoeken…", "zoek");
}

// ---------------------------------------------------------------- het bord volgen als de gsm beweegt
// Hoekpunten (Shi-Tomasi) op het bord van beeld tot beeld volgen (Lucas-Kanade), daaruit de verschuiving van het
// bord als homografie (RANSAC: wie niet meedoet, zoals een hand, telt niet). Af en toe het raster opnieuw inpassen
// om kleine fouten niet te laten optellen. Bij beweging even niet lezen (wazig beeld).
const VOLG_MS = 90, STIL_MS = 350, KWIJT_MS = 1500, PASSEN_MS = 700;
const volg = { stap: 0, misPassen: 0, laatstControle: 0, ander: null, laatst: 0, vorig: null, punten: null, bewogen: 0, kwijt: 0, laatstGepast: 0, terugzoeken: false };

// is de nieuwe vierhoek een geloofwaardige volgende stand van de oude? (bol, niet plots veel groter/kleiner/scheef)
function geloofwaardig(oud, nieuw) {
  const opp = h => Math.abs(h.reduce((t, p, i) => { const q = h[(i + 1) % 4]; return t + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  const kruis = h => h.map((p, i) => { const a = h[(i + 1) % 4], b = h[(i + 2) % 4];
    return (a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0]); });
  const k = kruis(nieuw);
  if (!(k.every(v => v > 0) || k.every(v => v < 0))) return false;
  const v = opp(nieuw) / opp(oud);
  if (!(v > 0.8 && v < 1.25)) return false;
  for (let i = 0; i < 4; i++) {
    const zo = Math.hypot(oud[(i + 1) % 4][0] - oud[i][0], oud[(i + 1) % 4][1] - oud[i][1]);
    const zn = Math.hypot(nieuw[(i + 1) % 4][0] - nieuw[i][0], nieuw[(i + 1) % 4][1] - nieuw[i][1]);
    if (zn / zo < 0.82 || zn / zo > 1.22) return false;
  }
  return true;
}

// Controle: om de 2 s zoeken we het bord in het hele beeld, zoals bij het begin. Ziet die zoektocht twee keer
// na elkaar duidelijk een ander bord dan wat we volgen, dan nemen we dat over (zoals zelf op "Opnieuw zoeken" duwen).
const CONTROLE_MS = 2000;
function controleerBord() {
  const geldig = bordKandidaten();
  if (!geldig.length || geldig.some(k => zelfdeKader(k.h, st.hoek, 0.05))) { volg.ander = null; return; }
  const k = geldig[0];
  if (volg.ander && zelfdeKader(volg.ander, k.h, 0.04)) {
    volgStop(); volgStart();
    st.hoek = k.h; volg.ander = null;
    const jk = st.lees ? st.lees.jokerKeuze : {};
    nieuwLezen(); st.lees.jokerKeuze = jk;   // de oude lezingen kwamen van een verkeerd raster
    zetStatus("Bord opnieuw ingepast", "ok");
  } else volg.ander = k.h;
}

function volgStart() {
  volgStop();
  volg.bewogen = 0; volg.kwijt = 0; volg.misPassen = 0; volg.ander = null; volg.laatstGepast = performance.now();
}
function volgStop() {
  if (volg.vorig) volg.vorig.delete();
  if (volg.punten) volg.punten.delete();
  volg.vorig = null; volg.punten = null;
}

function bordMasker(h, s, maat) {
  const m = cv.Mat.zeros(maat.height, maat.width, cv.CV_8UC1);
  const poly = cv.matFromArray(4, 1, cv.CV_32SC2, h.flat().map(v => Math.round(v * s)));
  const pv = new cv.MatVector(); pv.push_back(poly);
  cv.fillPoly(m, pv, new cv.Scalar(255));
  poly.delete(); pv.delete();
  return m;
}

function volgBord(t) {
  const s = werkbeeld();
  const src = cv.imread(werk), grijs = new cv.Mat();
  cv.cvtColor(src, grijs, cv.COLOR_RGBA2GRAY);
  src.delete();
  const vakMaat = Math.hypot(st.hoek[1][0] - st.hoek[0][0], st.hoek[1][1] - st.hoek[0][1]) * s / N;
  let gelukt = false, onzin = false;
  if (volg.vorig && volg.punten && volg.punten.rows >= 12) {
    const nieuw = new cv.Mat(), status = new cv.Mat(), fout = new cv.Mat();
    cv.calcOpticalFlowPyrLK(volg.vorig, grijs, volg.punten, nieuw, status, fout, new cv.Size(21, 21), 3,
      new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 20, 0.03));
    const a = [], b = [];
    for (let i = 0; i < status.rows; i++) {
      if (!status.data[i]) continue;
      a.push(volg.punten.data32F[2 * i], volg.punten.data32F[2 * i + 1]);
      b.push(nieuw.data32F[2 * i], nieuw.data32F[2 * i + 1]);
    }
    if (a.length >= 24) {
      const A = cv.matFromArray(a.length / 2, 1, cv.CV_32FC2, a), Bm = cv.matFromArray(b.length / 2, 1, cv.CV_32FC2, b);
      const inl = new cv.Mat();
      const H = cv.findHomography(A, Bm, cv.RANSAC, 2.0, inl);
      let mee = 0; for (let i = 0; i < inl.rows; i++) mee += inl.data[i] ? 1 : 0;
      if (!H.empty() && mee >= 15 && mee >= 0.5 * a.length / 2) {
        const hk = cv.matFromArray(4, 1, cv.CV_32FC2, st.hoek.flat().map(v => v * s)), uit = new cv.Mat();
        cv.perspectiveTransform(hk, uit, H);
        const nh = [0, 1, 2, 3].map(k => [uit.data32F[2 * k] / s, uit.data32F[2 * k + 1] / s]);
        const verschil = Math.max(...nh.map((p, k) => Math.hypot(p[0] - st.hoek[k][0], p[1] - st.hoek[k][1]))) * s;
        if (verschil > 0.5 * vakMaat) volg.bewogen = t;   // snel bewogen: beeld wazig
        volg.stap = verschil / vakMaat;
        onzin = !geloofwaardig(st.hoek, nh);
        if (!onzin) {
        // houd alleen de punten die meedoen
        const goed = [];
        for (let i = 0; i < inl.rows; i++) if (inl.data[i]) goed.push(b[2 * i], b[2 * i + 1]);
        volg.punten.delete(); volg.punten = cv.matFromArray(goed.length / 2, 1, cv.CV_32FC2, goed);
        st.hoek = nh; gelukt = true;
        if (volg.log) volg.log.push([Math.round(t), a.length / 2, mee, +verschil.toFixed(1)]);
        }
        hk.delete(); uit.delete();
      }
      [A, Bm, inl, H].forEach(m => m.delete());
    }
    [nieuw, status, fout].forEach(m => m.delete());
  }
  if (onzin) {
    // onmogelijke sprong (bv. punten op een weerspiegeling): deze stap negeren en de punten opnieuw kiezen
    grijs.delete(); volgStop(); volgMislukt(t, null); return;
  }
  // stilstaand: af en toe het raster opnieuw precies inpassen (houdt het kader recht op de lijnen)
  if (volg.passen !== false && t - volg.laatstGepast > PASSEN_MS) {
    volg.laatstGepast = t;
    let r = vindRaster(grijs, st.hoek.map(([x, y]) => [x * s, y * s]), FIJN);
    if (r.sc >= 12) r = vindRaster(grijs, r.h, HEEL_FIJN);
    if (r.sc >= 12) {
      const nh = r.h.map(([x, y]) => [x / s, y / s]);
      const verschil = Math.max(...nh.map((p, k) => Math.hypot(p[0] - st.hoek[k][0], p[1] - st.hoek[k][1]))) * s;
      if (verschil < 0.35 * vakMaat) { st.hoek = nh; gelukt = gelukt || !volg.vorig; volg.misPassen = 0; }
      else volg.misPassen++;
    } else volg.misPassen++;
  }
  // het raster past al een tijd niet meer op de lijnen: we volgen iets anders dan het bord
  if (volg.misPassen >= 4) { volg.misPassen = 0; grijs.delete(); volgStop(); return volgMislukt(t, "verloren"); }
  // nieuwe punten zoeken als er te weinig over zijn
  if (!volg.punten || volg.punten.rows < 60) {
    const m = bordMasker(st.hoek, s, grijs.size()), p = new cv.Mat();
    cv.goodFeaturesToTrack(grijs, p, 250, 0.01, 7, m, 5);
    if (volg.punten) volg.punten.delete();
    volg.punten = p; m.delete();
    if (!volg.vorig) gelukt = true;
  }
  if (volg.vorig) volg.vorig.delete();
  volg.vorig = grijs;
  if (gelukt) {
    if (volg.kwijt) zetStatus("Letters lezen…", "ok");
    volg.kwijt = 0;
  } else volgMislukt(t, null);
}

function volgMislukt(t, hoe) {
  {
    if (!volg.kwijt) volg.kwijt = hoe === "verloren" ? t - KWIJT_MS - 1 : t;
    zetStatus("Bord kwijt… richt de camera op het bord", "zoek");
    if (t - volg.kwijt > KWIJT_MS && st.vraagt) {
      // tijdens de vraag kwijtgeraakt: gewoon verder zoeken
      volgStop(); st.vraagt = false; st.hoek = null; st.geschiedenis = []; st.stabiel = 0; volg.kwijt = 0;
      $("vraag").hidden = true; $("acties").hidden = false;
      zetStatus("Bord zoeken…", "zoek");
    } else if (t - volg.kwijt > KWIJT_MS) {
      // terug zoeken; het spel (punten, wat er lag) blijft bewaard
      volgStop();
      st.vast = false; st.hoek = null; st.geschiedenis = []; st.stabiel = 0;
      volg.terugzoeken = true; volg.kwijt = 0;
      zetStatus("Bord zoeken…", "zoek");
    }
  }
}

// ---------------------------------------------------------------- letters lezen en woorden nakijken
function leesLetters() {
  vol.width = video.videoWidth; vol.height = video.videoHeight;
  const ctx = vol.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0);
  const beeld = cv.imread(vol);
  const gelezen = Lezer.leesBord(beeld, st.hoek);
  beeld.delete();
  if (gelezen) verwerkLezing(gelezen);
}

function verwerkLezing(gelezen) {
  const L = st.lees;
  L.lezingen++;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const v = L.stemmen[r][c];
    const g = gelezen[r][c];
    v.push(g && g.p >= 0.6 ? g.letter : null);
    if (v.length > STEMMEN) v.shift();
    const kv = L.kansen[r][c];
    kv.push(g ? g.kansen : null);
    if (kv.length > STEMMEN) kv.shift();
    const tel = {};
    v.forEach(l => { const k = l || "."; tel[k] = (tel[k] || 0) + 1; });
    let beste = null;
    for (const [k, n] of Object.entries(tel)) if (k !== "." && n >= STEMMEN_NODIG) beste = k;
    // een letter die er al lag, blijft liggen tot hij duidelijk weg is
    if (!beste && L.letters[r][c] && (tel["."] || 0) < STEMMEN_NODIG) beste = L.letters[r][c];
    L.sinds[r][c] = beste === L.letters[r][c] ? L.sinds[r][c] + 1 : 0;
    L.letters[r][c] = beste;
  }
  const wb = window.woordenboek;
  const letters = L.letters.map(r => r.slice());
  if (wb && wb.klaar()) { verbeterMetWoordenlijst(letters, L.kansen, wb); vulJokersIn(letters, wb); }
  L.getoond = letters;
  L.woorden = Lezer.woorden(letters).map(w => ({ ...w, woord: w.woord.toUpperCase(),
    geldig: !(wb && wb.klaar()) ? null : w.woord.includes("?") ? (L.jokerVraag ? null : false) : wb.bestaat(w.woord) }));
  // pas "fout" zeggen als het woord en zijn uiteinden een tijdje niet meer veranderd zijn (anders: nog aan het lezen)
  const rustig = (r, c) => r < 0 || c < 0 || r >= N || c >= N || L.sinds[r][c] >= RUSTIG;
  for (const w of L.woorden) {
    if (w.geldig !== false) continue;
    const [r0, c0] = w.cellen[0], [r1, c1] = w.cellen[w.cellen.length - 1];
    const ends = w.horiz ? [[r0, c0 - 1], [r1, c1 + 1]] : [[r0 - 1, c0], [r1 + 1, c1]];
    if (!w.cellen.every(([r, c]) => rustig(r, c)) || !ends.every(([r, c]) => rustig(r, c))) w.geldig = null;
  }
  toonJokerVraag();
  if (L.opwarmen) {
    // alles wat er in de eerste seconden verschijnt, lag er al: hoort bij het begin, telt niet als zet
    if (!spel.basis) spel.basis = letters.map(r => r.map(() => null));
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (letters[r][c] && letters[r][c] !== "?") spel.basis[r][c] = letters[r][c];
    if (L.lezingen >= STEMMEN + RUSTIG + 2) L.opwarmen = false;
  } else if (L.lezingen >= STEMMEN) volgZetten(letters);
  toonScores();
  const fout = L.woorden.filter(w => w.geldig === false);
  if (spel.melding && performance.now() < spel.melding.tot) zetStatus(spel.melding.tekst, "ok");
  else if (L.lezingen < STEMMEN + RUSTIG) zetStatus("Letters lezen…", "ok");
  else if (!L.woorden.length) zetStatus("Geen woorden gevonden", "ok");
  else if (fout.length) zetStatus(fout.length === 1 ? `Fout woord: ${fout[0].woord}` : `${fout.length} foute woorden: ${fout.map(w => w.woord).join(", ")}`, "fout");
  else zetStatus(`${L.woorden.length} ${L.woorden.length === 1 ? "woord" : "woorden"} · alles klopt`, "ok");
}

function verbeterMetWoordenlijst(letters, kansen, wb) {
  // Een fout woord kan ook een verkeerd gelezen letter zijn (J of I, E of B, ...). Als de tweede keus van het netje
  // in één vakje het woord (en het woord dat er dwars door loopt) wel laat bestaan, nemen we die.
  const klassen = Lezer.klassen();
  const allesGoed = (r, c) => Lezer.woorden(letters).filter(w => w.cellen.some(([a, b]) => a === r && b === c)).every(w => w.woord.includes("?") || wb.bestaat(w.woord));
  for (const w of Lezer.woorden(letters)) {
    if (w.woord.includes("?") || wb.bestaat(w.woord)) continue;
    let opgelost = false;
    for (const [r, c] of w.cellen) {
      const reeks = kansen[r][c].filter(Boolean);
      if (!reeks.length) continue;
      const gem = klassen.split("").map((k, i) => [k, reeks.reduce((s, p) => s + p[i], 0) / kansen[r][c].length]);
      const alt = gem.filter(([k, p]) => k !== "-" && k !== letters[r][c] && p >= 0.05).sort((a, b) => b[1] - a[1]);
      const was = letters[r][c];
      for (const [k] of alt) {
        letters[r][c] = k;
        if (allesGoed(r, c)) { opgelost = true; break; }
      }
      if (opgelost) break;
      letters[r][c] = was;
    }
  }
}

// ---------------------------------------------------------------- zetten volgen en punten tellen
// Nederlandse letterwaarden (staan ook rechtsonder op de stenen). Een joker (kleine letter) is 0 waard.
const WAARDE = { A: 1, B: 3, C: 5, D: 2, E: 1, F: 4, G: 3, H: 4, I: 1, J: 4, K: 3, L: 3, M: 3, N: 1, O: 1, P: 3, Q: 10,
                 R: 2, S: 2, T: 2, U: 4, V: 4, W: 5, X: 8, Y: 8, Z: 4 };
const ZET_STABIEL = 3;   // zoveel lezingen na elkaar dezelfde nieuwe stenen: dan pas is de zet gelegd

function puntenVoorZet(letters, nieuw) {
  // alleen de nieuwe stenen krijgen de premie van hun vakje; elk woord met minstens één nieuwe steen telt
  const isNieuw = (r, c) => nieuw.some(([a, b]) => a === r && b === c);
  const woorden = Lezer.woorden(letters).filter(w => w.cellen.some(([r, c]) => isNieuw(r, c)));
  let totaal = 0;
  const uit = woorden.map(w => {
    let som = 0, maal = 1;
    for (const [r, c] of w.cellen) {
      const l = letters[r][c];
      let v = l === l.toUpperCase() ? (WAARDE[l] || 0) : 0;
      if (isNieuw(r, c)) {
        const soort = Lezer.SOORT[r][c];
        if (soort === 3) v *= 3; else if (soort === 4) v *= 2;
        if (soort === 1) maal *= 3; else if (soort === 2 || soort === 5) maal *= 2;
      }
      som += v;
    }
    totaal += som * maal;
    return { woord: w.woord.toUpperCase(), punten: som * maal };
  });
  const bonus = nieuw.length === 7 ? 50 : 0;
  return { woorden: uit, bonus, punten: totaal + bonus };
}

function volgZetten(letters) {
  if (!spel.basis) { spel.basis = letters.map(r => r.slice()); return; }   // wat er al lag bij het begin telt niet
  const nieuw = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (letters[r][c] && !spel.basis[r][c]) nieuw.push([r, c]);
  if (!nieuw.length) { spel.kandidaat = null; return; }
  // een geldige zet: alle nieuwe stenen op één lijn, zonder gaten, vast aan wat er lag (of over de ster bij de eerste zet),
  // geen open joker, en alle nieuwe woorden bestaan
  const rijen = new Set(nieuw.map(x => x[0])), kols = new Set(nieuw.map(x => x[1]));
  if (rijen.size > 1 && kols.size > 1) { spel.kandidaat = null; return; }
  const horiz = rijen.size === 1 && (kols.size > 1 || nieuw.length === 1);
  const [r0, c0] = nieuw[0];
  const posities = nieuw.map(([r, c]) => (horiz ? c : r));
  for (let k = Math.min(...posities); k <= Math.max(...posities); k++) {
    const [r, c] = horiz ? [r0, k] : [k, c0];
    if (!letters[r][c]) { spel.kandidaat = null; return; }
  }
  if (nieuw.some(([r, c]) => letters[r][c] === "?")) { spel.kandidaat = null; return; }
  const basisLeeg = spel.basis.every(r => r.every(x => !x));
  const raakt = nieuw.some(([r, c]) => [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
    .some(([a, b]) => a >= 0 && b >= 0 && a < N && b < N && spel.basis[a][b]));
  if (basisLeeg ? !nieuw.some(([r, c]) => r === 7 && c === 7) : !raakt) { spel.kandidaat = null; return; }
  const zet = puntenVoorZet(letters, nieuw);
  const wb = window.woordenboek;
  if (!zet.woorden.length || !wb || !wb.klaar() || zet.woorden.some(w => !wb.bestaat(w.woord))) { spel.kandidaat = null; return; }
  const sleutel = nieuw.map(([r, c]) => `${r},${c}${letters[r][c]}`).join(" ");
  if (!spel.kandidaat || spel.kandidaat.sleutel !== sleutel) { spel.kandidaat = { sleutel, keer: 1 }; return; }
  if (++spel.kandidaat.keer < ZET_STABIEL) return;
  // de zet is gelegd
  spel.kandidaat = null;
  const vorigeBasis = spel.basis.map(r => r.slice());
  nieuw.forEach(([r, c]) => { spel.basis[r][c] = letters[r][c]; });
  spel.zetten.push({ speler: spel.aanBeurt, ...zet, vorigeBasis });
  const naam = spel.spelers[spel.aanBeurt];
  spel.melding = { tekst: `${zet.woorden.map(w => w.woord).join(" + ")}: ${zet.punten} punten voor ${naam}${zet.bonus ? " (met 50 bonus)" : ""}`,
                   tot: performance.now() + 6000 };
  spel.aanBeurt = (spel.aanBeurt + 1) % spel.spelers.length;
  if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) {} }
}

function stand(i) { return spel.zetten.filter(z => z.speler === i).reduce((s, z) => s + z.punten, 0); }

function toonScores() {
  const vak = $("scores");
  vak.hidden = !st.vast;
  const sleutel = spel.spelers.map((n, i) => `${n}:${stand(i)}`).join("|") + spel.aanBeurt;
  if (vak.dataset.sleutel === sleutel) return;
  vak.dataset.sleutel = sleutel;
  vak.textContent = "";
  spel.spelers.forEach((naam, i) => {
    const b = document.createElement("button");
    b.className = "speler" + (i === spel.aanBeurt ? " aan" : "");
    b.innerHTML = `<span></span><b></b>`;
    b.firstChild.textContent = naam; b.lastChild.textContent = stand(i);
    b.title = "Tik: deze speler is aan de beurt";
    b.addEventListener("click", () => { spel.aanBeurt = i; vak.dataset.sleutel = ""; toonScores(); });
    vak.appendChild(b);
  });
  $("terug").disabled = !spel.zetten.length;
}

function zetTerug() {
  const z = spel.zetten.pop();
  if (!z) return;
  spel.basis = z.vorigeBasis; spel.aanBeurt = z.speler; spel.kandidaat = null;
  spel.melding = { tekst: `Zet teruggedraaid (${z.woorden.map(w => w.woord).join(" + ")})`, tot: performance.now() + 4000 };
  zetStatus(spel.melding.tekst, "ok");
  $("scores").dataset.sleutel = ""; toonScores();
}

// ---------------------------------------------------------------- jokers
// Een joker heeft geen letter. We vullen de letter in die alle woorden door dat vakje laat bestaan.
// Past er maar één: die nemen we. Passen er meerdere: we vragen het. Een joker wordt als kleine letter bijgehouden (0 punten).
const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function vulJokersIn(letters, wb) {
  const L = st.lees;
  const jokers = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (letters[r][c] === "?") jokers.push([r, c]);
  // keuzes van jokers die er niet meer liggen vergeten
  for (const k of Object.keys(L.jokerKeuze)) if (!jokers.some(([r, c]) => `${r},${c}` === k)) delete L.jokerKeuze[k];
  for (const [r, c] of jokers) if (L.jokerKeuze[`${r},${c}`]) letters[r][c] = L.jokerKeuze[`${r},${c}`].toLowerCase();
  let vraag = null;
  const gedaan = new Set();
  for (const [r, c] of jokers) {
    if (letters[r][c] !== "?" || gedaan.has(`${r},${c}`)) continue;
    // groepje jokers die naast elkaar liggen (meestal 1, hoogstens 2 in een spel)
    const groep = [[r, c]];
    for (const [a, b] of [[r, c + 1], [r + 1, c], [r, c - 1], [r - 1, c]])
      if (a >= 0 && b >= 0 && a < N && b < N && letters[a][b] === "?" && groep.length < 2) groep.push([a, b]);
    groep.forEach(([a, b]) => gedaan.add(`${a},${b}`));
    const raakt = w => w.cellen.some(([a, b]) => groep.some(([x, y]) => x === a && y === b));
    const opties = [];
    const probeer = k => {
      if (k === groep.length) {
        const ws = Lezer.woorden(letters).filter(raakt);
        if (ws.every(w => w.woord.includes("?") || wb.bestaat(w.woord))) opties.push(groep.map(([a, b]) => letters[a][b].toUpperCase()).join(""));
        return;
      }
      const [a, b] = groep[k];
      for (const l of ABC) { letters[a][b] = l.toLowerCase(); probeer(k + 1); }
      letters[a][b] = "?";
    };
    probeer(0);
    if (opties.length === 1) groep.forEach(([a, b], i) => { letters[a][b] = opties[0][i].toLowerCase(); });
    else if (opties.length > 1 && !vraag) {
      // vragen voor het eerste vakje van het groepje; de rest volgt daarna vanzelf
      vraag = { r: groep[0][0], c: groep[0][1], opties: [...new Set(opties.map(o => o[0]))] };
    }
  }
  L.jokerVraag = vraag;
}

function toonJokerVraag() {
  const v = st.lees && st.lees.jokerVraag;
  const vak = $("jokervraag");
  // pas vragen als het vakje een tijdje rustig als joker gelezen wordt (anders is het vaak een leesfout)
  const rustig = v && st.lees.lezingen >= STEMMEN + RUSTIG && st.lees.sinds[v.r][v.c] >= RUSTIG;
  if (!v || st.vraagt || !rustig) { vak.hidden = true; vak.dataset.sleutel = ""; return; }
  const sleutel = `${v.r},${v.c}:${v.opties.join("")}`;
  if (vak.dataset.sleutel === sleutel && !vak.hidden) return;
  vak.dataset.sleutel = sleutel;
  const knoppen = $("jokeropties");
  knoppen.textContent = "";
  for (const l of v.opties) {
    const b = document.createElement("button");
    b.className = "letter"; b.textContent = l;
    b.addEventListener("click", () => {
      st.lees.jokerKeuze[`${v.r},${v.c}`] = l;
      st.lees.jokerVraag = null; vak.hidden = true; vak.dataset.sleutel = "";
    });
    knoppen.appendChild(b);
  }
  vak.hidden = false;
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
  // het raster zelf (dunne lijnen), perspectivisch juist: verder weg liggen de lijnen dichter bij elkaar
  c.lineWidth = lijn / 3; c.globalAlpha = 0.6;
  const punt = perspectief(h);
  c.beginPath();
  for (let k = 1; k < N; k++) {
    const u = k / N;
    let a = punt(u, 0), b = punt(u, 1); c.moveTo(...a); c.lineTo(...b);
    a = punt(0, u); b = punt(1, u); c.moveTo(...a); c.lineTo(...b);
  }
  c.stroke(); c.globalAlpha = 1;
  if (st.vast && st.lees) tekenWoorden(c, punt, lijn);
  if (st.vast && st.lees && st.lees.jokerVraag) {
    // het vakje van de joker waarover we iets vragen, geel
    const { r, c: k } = st.lees.jokerVraag;
    c.strokeStyle = "#ffd84d"; c.lineWidth = lijn * 1.2; c.beginPath();
    [[k, r], [k + 1, r], [k + 1, r + 1], [k, r + 1]].forEach(([u, v], i) => { const p = punt(u / N, v / N); i ? c.lineTo(...p) : c.moveTo(...p); });
    c.closePath(); c.stroke();
  }
}

function tekenWoorden(c, punt, lijn) {
  // elk woord omlijnd: groen = bestaat, rood = bestaat niet
  for (const w of st.lees.woorden) {
    const [r0, c0] = w.cellen[0], [r1, c1] = w.cellen[w.cellen.length - 1];
    const k = 0.08;
    const u0 = (c0 + k) / N, u1 = (c1 + 1 - k) / N, v0 = (r0 + k) / N, v1 = (r1 + 1 - k) / N;
    c.strokeStyle = w.geldig === false ? "#ff5a4f" : w.geldig ? "#7fd18b" : "#cccccc";
    c.lineWidth = w.geldig === false ? lijn * 1.1 : lijn * 0.7;
    c.beginPath();
    [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].forEach(([u, v], i) => { const p = punt(u, v); i ? c.lineTo(...p) : c.moveTo(...p); });
    c.closePath(); c.stroke();
  }
}

function perspectief(h) {
  // (u, v) in 0..1 over het speelveld -> punt in het camerabeeld (homografie uit de 4 hoeken)
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = h;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den, k = (dx1 * sy - sx * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + k * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + k * y3, f = y0;
  return (u, v) => { const w = g * u + k * v + 1; return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]; };
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
  // gelezen letters op het kleine bord
  if (st.lees) {
    const v = RECHT / N;
    c.font = `700 ${Math.round(v * 0.62)}px system-ui, sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
    for (let r = 0; r < N; r++) for (let k = 0; k < N; k++) {
      const l = (st.lees.getoond || st.lees.letters)[r][k];
      if (!l) continue;
      const joker = l === "?" || l !== l.toUpperCase();
      c.fillStyle = joker ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.72)"; c.fillRect(k * v + 1, r * v + 1, v - 2, v - 2);
      c.fillStyle = joker ? "#333" : "#ffe08a"; c.fillText(l.toUpperCase(), k * v + v / 2, r * v + v / 2 + 1);
    }
  }
}

// ---------------------------------------------------------------- knoppen
$("start").addEventListener("click", start);

// ---------------------------------------------------------------- menu: spel starten en spelers
const MIN_SPELERS = 2, MAX_SPELERS = 4;   // Scrabble is voor 2 tot 4 spelers (4 rekjes)
function bewaardeNamen() {
  try { const n = JSON.parse(localStorage.getItem("scrabbleSpelers") || "[]"); return Array.isArray(n) ? n : []; }
  catch (e) { return []; }
}
function spelerRij(naam) {
  const li = document.createElement("li");
  const inv = document.createElement("input");
  inv.type = "text"; inv.maxLength = 16; inv.autocomplete = "off"; inv.enterKeyHint = "next"; inv.value = naam || "";
  const weg = document.createElement("button");
  weg.className = "weg"; weg.type = "button"; weg.textContent = "×"; weg.setAttribute("aria-label", "Speler verwijderen");
  weg.addEventListener("click", () => { li.remove(); werkSpelersBij(); });
  li.append(inv, weg);
  return li;
}
function werkSpelersBij() {
  const rijen = [...$("spelerLijst").children];
  rijen.forEach((li, i) => {
    li.querySelector("input").placeholder = `Speler ${i + 1}`;
    li.querySelector("input").setAttribute("aria-label", `Naam speler ${i + 1}`);
    li.querySelector(".weg").style.visibility = rijen.length > MIN_SPELERS ? "visible" : "hidden";
  });
  $("spelerErbij").hidden = rijen.length >= MAX_SPELERS;
}
$("nieuwSpel").addEventListener("click", () => {
  const lijst = $("spelerLijst");
  lijst.textContent = "";
  const namen = bewaardeNamen().slice(0, MAX_SPELERS);
  for (let i = 0; i < Math.max(MIN_SPELERS, namen.length); i++) lijst.appendChild(spelerRij(namen[i]));
  werkSpelersBij();
  $("welkom").hidden = true; $("spelersScherm").hidden = false;
});
$("spelerErbij").addEventListener("click", () => {
  const li = spelerRij("");
  $("spelerLijst").appendChild(li); werkSpelersBij();
  li.querySelector("input").focus();
});
$("menuTerug").addEventListener("click", () => { $("spelersScherm").hidden = true; $("welkom").hidden = false; });
$("spelerLijst").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const li = e.target.closest("li"), volgende = li && li.nextElementSibling;
  if (volgende) volgende.querySelector("input").focus(); else $("begin").click();
});
$("begin").addEventListener("click", () => {
  const namen = [...$("spelerLijst").querySelectorAll("input")].map((x, i) => x.value.trim() || `Speler ${i + 1}`);
  try { localStorage.setItem("scrabbleSpelers", JSON.stringify(namen)); } catch (e) {}
  spel.spelers = namen; spel.zetten = []; spel.aanBeurt = 0; spel.basis = null; spel.kandidaat = null; spel.melding = null;
  $("scores").dataset.sleutel = "";
  $("menu").hidden = true; $("status").hidden = false;
  start();
});

$("opnieuw").addEventListener("click", opnieuwZoeken);
$("terug").addEventListener("click", zetTerug);
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
    st.hand = false; st.vast = true; st.handPunten = []; nieuwLezen(); volgStart();
    $("hand").setAttribute("aria-pressed", "false"); $("hand").textContent = "Zelf aanduiden";
    $("recht").hidden = false;
    zetStatus("Letters lezen…", "ok");
  }
});

// voor het testen: toestand opvragen, en één stilstaand beeld lezen (zonder stemmen)
window.scrabbleVolg = volg;
window.scrabbleSt = st;
window.scrabbleSpel = () => ({ stand: spel.spelers.map((n, i) => stand(i)), aanBeurt: spel.aanBeurt,
  zetten: spel.zetten.map(z => ({ speler: z.speler, woorden: z.woorden, bonus: z.bonus, punten: z.punten })) });
window.scrabbleLees = () => st.lees && ({ letters: (st.lees.getoond || st.lees.letters).map(r => r.map(l => l || ".").join("")), woorden: st.lees.woorden.map(w => w.woord + (w.geldig === false ? "!" : "")) });
window.scrabbleLeesBeeld = async (url, hoek) => {
  if (!st.cvKlaar) { await laadCv(); st.cvKlaar = true; }
  await Lezer.laden;
  const img = new Image(); img.src = url; await img.decode();
  const cnv = document.createElement("canvas"); cnv.width = img.naturalWidth; cnv.height = img.naturalHeight;
  cnv.getContext("2d").drawImage(img, 0, 0);
  const m = cv.imread(cnv), t0 = performance.now();
  const g = Lezer.leesBord(m, hoek); m.delete();
  return { ms: Math.round(performance.now() - t0), letters: g.map(r => r.map(x => (x && x.p >= 0.6 ? x.letter : ".")).join("")) };
};
// voor het testen: toestand opvragen
window.scrabbleToestand = () => ({ status: $("status").textContent, hoek: st.hoek, stabiel: st.stabiel, score: st.score, vast: st.vast, vraagt: st.vraagt, afgewezen: st.afgewezen.length });
