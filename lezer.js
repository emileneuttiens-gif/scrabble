// De letters op de stenen lezen. Per vakje van het rechtgezette bord:
//   1. ligt er een steen? (lichte, weinig gekleurde achtergrond met een duidelijke donkere vlek in het midden)
//   2. welke letter? een klein neuraal netje (letters-net.json), geleerd op nagemaakte stenen in veel lettertypes,
//      wazig, schuin en slecht belicht. Precies dezelfde stappen als bij het leren (scratch: vak.py).
// Alles op het toestel zelf.
"use strict";

(() => {
  const N = 15, C = 48, M = 4, L = C - 2 * M, K = 20, CMIN = 30;
  let net = null;

  const laden = fetch("letters-net.json?v=1")
    .then(r => { if (!r.ok) throw new Error("letters-net.json niet gevonden"); return r.json(); })
    .then(j => {
      net = {
        klassen: j.klassen,
        lagen: j.lagen.map(l => {
          const ruw = Uint8Array.from(atob(l.W), c => c.charCodeAt(0));
          const q = new Int8Array(ruw.buffer);
          const W = new Float32Array(l.in * l.uit);
          for (let i = 0; i < l.in; i++) for (let o = 0; o < l.uit; o++) W[i * l.uit + o] = q[i * l.uit + o] * l.s[o];
          return { in: l.in, uit: l.uit, W, b: Float32Array.from(l.b) };
        }),
      };
      return true;
    })
    .catch(e => { console.warn("Lezer:", e.message); return false; });

  function voorwaarts(x) {
    let a = x;
    net.lagen.forEach((l, k) => {
      const y = Float32Array.from(l.b);
      for (let i = 0; i < l.in; i++) {
        const v = a[i];
        if (v === 0) continue;
        const rij = i * l.uit;
        for (let o = 0; o < l.uit; o++) y[o] += v * l.W[rij + o];
      }
      if (k < net.lagen.length - 1) for (let o = 0; o < l.uit; o++) y[o] = Math.max(0, y[o]);
      a = y;
    });
    // softmax
    let m = -Infinity; for (const v of a) m = Math.max(m, v);
    let s = 0; const p = a.map(v => { const e = Math.exp(v - m); s += e; return e; });
    return p.map(v => v / s);
  }

  function mediaan(hist, n) {
    // zoals numpy: bij een even aantal het gemiddelde van de twee middelste
    if (!n) return 0;
    const a = (n - 1) >> 1, b = n >> 1;
    let tel = 0, va = -1;
    for (let v = 0; v < 256; v++) {
      tel += hist[v];
      if (va < 0 && tel > a) va = v;
      if (tel > b) return (va + v) / 2;
    }
    return va;
  }

  function lijnachtig(x, y, w, h) {
    const links = x === 0, boven = y === 0, rechts = x + w >= L, onder = y + h >= L;
    if ((links && rechts) || (boven && onder)) return true;
    if ((links || boven || rechts || onder) && Math.min(w, h) <= 0.22 * L && Math.max(w, h) >= 0.45 * L) return true;
    return false;
  }

  // kenmerken van 1 vakje; g en s: Uint8Array L*L (grijs en verzadiging)
  function kenmerken(g, s, cvm) {
    const { grijsMat, inkMat, lab, stats, cent } = cvm;
    grijsMat.data.set(g);
    cv.threshold(grijsMat, inkMat, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    const ink = inkMat.data;
    const hL = new Uint32Array(256), hD = new Uint32Array(256), hS = new Uint32Array(256);
    let nL = 0, nD = 0;
    for (let i = 0; i < L * L; i++) {
      if (ink[i]) { hD[g[i]]++; nD++; } else { hL[g[i]]++; hS[s[i]]++; nL++; }
    }
    if (nD < 10 || nL < 10) return null;
    const bg = mediaan(hL, nL), fg = mediaan(hD, nD);
    if (bg - fg < CMIN) return null;
    if (bg < 110 || mediaan(hS, nL) > 100) return null;
    const n = cv.connectedComponentsWithStats(inkMat, lab, stats, cent, 8, cv.CV_32S);
    const st = stats.data32S;
    let beste = -1, opp = -1;
    for (let q = 1; q < n; q++) {
      const x = st[q * 5], y = st[q * 5 + 1], w = st[q * 5 + 2], h = st[q * 5 + 3], a = st[q * 5 + 4];
      if (lijnachtig(x, y, w, h)) continue;
      if (a > opp) { opp = a; beste = q; }
    }
    if (beste < 0) return null;
    const x = st[beste * 5], y = st[beste * 5 + 1], w = st[beste * 5 + 2], h = st[beste * 5 + 3];
    if (h < 0.35 * L || h > 0.9 * L || w > 0.9 * L) return null;
    // masker van de vlek, 1 pixel dikker (3x3)
    const lb = lab.data32S, masker = new Uint8Array(L * L);
    for (let yy = 0; yy < L; yy++) for (let xx = 0; xx < L; xx++) {
      if (lb[yy * L + xx] !== beste) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const u = xx + dx, v = yy + dy;
        if (u >= 0 && v >= 0 && u < L && v < L) masker[v * L + u] = 1;
      }
    }
    const z = Math.max(w, h), vk = new Float32Array(z * z);
    const oy = (z - h) >> 1, ox = (z - w) >> 1;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const i = (y + yy) * L + (x + xx);
      if (!masker[i]) continue;
      vk[(oy + yy) * z + (ox + xx)] = Math.min(1, Math.max(0, (bg - g[i]) / (bg - fg)));
    }
    const groot = cv.matFromArray(z, z, cv.CV_32F, vk), klein = new cv.Mat();
    cv.resize(groot, klein, new cv.Size(K, K), 0, 0, cv.INTER_AREA);
    const f = new Float32Array(K * K + 3);
    f.set(klein.data32F);
    f[K * K] = w / h; f[K * K + 1] = h / L; f[K * K + 2] = w / L;
    groot.delete(); klein.delete();
    return f;
  }

  // rgba: cv.Mat (CV_8UC4) van het camerabeeld; hoek: 4 hoeken van het speelveld in die pixels.
  // Geeft 15 x 15: null (geen steen) of { letter, p }.
  function leesBord(rgba, hoek) {
    if (!net) return null;
    const B = N * C;
    const bron = cv.matFromArray(4, 1, cv.CV_32FC2, hoek.flat());
    const doel = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, B, 0, B, B, 0, B]);
    const T = cv.getPerspectiveTransform(bron, doel);
    const bord = new cv.Mat(), rgb = new cv.Mat(), grijs = new cv.Mat(), hsv = new cv.Mat();
    cv.warpPerspective(rgba, bord, T, new cv.Size(B, B), cv.INTER_LINEAR);
    cv.cvtColor(bord, grijs, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(bord, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const gd = grijs.data, hd = hsv.data;
    const cvm = { grijsMat: new cv.Mat(L, L, cv.CV_8UC1), inkMat: new cv.Mat(), lab: new cv.Mat(), stats: new cv.Mat(), cent: new cv.Mat() };
    const g = new Uint8Array(L * L), s = new Uint8Array(L * L);
    const uit = [];
    for (let r = 0; r < N; r++) {
      const rij = [];
      for (let c = 0; c < N; c++) {
        for (let y = 0; y < L; y++) {
          const basis = (r * C + M + y) * B + c * C + M;
          for (let x = 0; x < L; x++) { g[y * L + x] = gd[basis + x]; s[y * L + x] = hd[(basis + x) * 3 + 1]; }
        }
        const f = kenmerken(g, s, cvm);
        if (!f) { rij.push(null); continue; }
        const p = voorwaarts(f);
        let k = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[k]) k = i;
        const letter = net.klassen[k];
        rij.push(letter === "-" ? null : { letter, p: p[k], kansen: p });
      }
      uit.push(rij);
    }
    [bron, doel, T, bord, rgb, grijs, hsv, cvm.grijsMat, cvm.inkMat, cvm.lab, cvm.stats, cvm.cent].forEach(m => m.delete());
    return uit;
  }

  // woorden: alle reeksen van 2 of meer letters, horizontaal en verticaal
  function woorden(letters) {
    const uit = [];
    for (const horiz of [true, false]) {
      for (let i = 0; i < N; i++) {
        let start = -1;
        for (let j = 0; j <= N; j++) {
          const l = j < N ? (horiz ? letters[i][j] : letters[j][i]) : null;
          if (l && start < 0) start = j;
          if (!l && start >= 0) {
            if (j - start >= 2) {
              const cellen = [];
              for (let k = start; k < j; k++) cellen.push(horiz ? [i, k] : [k, i]);
              uit.push({ woord: cellen.map(([r, c]) => letters[r][c]).join(""), cellen, horiz });
            }
            start = -1;
          }
        }
      }
    }
    return uit;
  }

  window.Lezer = { laden, leesBord, woorden, klaar: () => net !== null, klassen: () => net.klassen };
})();
