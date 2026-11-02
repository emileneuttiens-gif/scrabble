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
    if (nD > 0.5 * L * L) return null;   // meer donker dan licht: geen steen (bv. een premievak met witte letters)
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

  // soort vakje: 0 gewoon, 1 woordwaarde x3, 2 woordwaarde x2, 3 letterwaarde x3, 4 letterwaarde x2, 5 ster
  const SOORT = (() => {
    const m = [...Array(N)].map(() => Array(N).fill(0));
    const zet = (lijst, k) => lijst.forEach(([r, c]) => { m[r][c] = k; });
    zet([[0,0],[0,7],[0,14],[7,0],[7,14],[14,0],[14,7],[14,14]], 1);
    for (let i = 1; i < 5; i++) zet([[i,i],[i,14-i],[14-i,i],[14-i,14-i]], 2);
    zet([[1,5],[1,9],[5,1],[5,5],[5,9],[5,13],[9,1],[9,5],[9,9],[9,13],[13,5],[13,9]], 3);
    zet([[0,3],[0,11],[2,6],[2,8],[3,0],[3,7],[3,14],[6,2],[6,6],[6,8],[6,12],[7,3],[7,11],[8,2],
         [8,6],[8,8],[8,12],[11,0],[11,7],[11,14],[12,6],[12,8],[14,3],[14,11]], 4);
    m[7][7] = 5;
    return m;
  })();

  // Jokers: een egaal vakje (geen letter) naast een steen, met de kleur van de stenen eromheen
  // eerder dan de kleur van de lege vakjes van dezelfde soort eromheen. Alles lokaal vergeleken (licht valt ongelijk).
  function zoekJokers(uit, midden, spreiding, tegel) {
    const d = (x, y) => Math.hypot(0.5 * (x[0] - y[0]), x[1] - y[1], x[2] - y[2]);
    const med = lijst => [0, 1, 2].map(k => { const v = lijst.map(x => x[k]).sort((a, b) => a - b); return v[v.length >> 1]; });
    const isSteen = (r, c) => r >= 0 && c >= 0 && r < N && c < N && uit[r][c];
    const alleTegels = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (tegel[r][c]) alleTegels.push(tegel[r][c]);
    if (alleTegels.length < 3) return;
    for (let ronde = 0; ronde < 2; ronde++) {          // twee rondes: twee jokers naast elkaar
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (uit[r][c] || spreiding[r][c] > 12) continue;
        if (![[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].some(([a, b]) => isSteen(a, b))) continue;
        if (SOORT[r][c] === 5) { uit[r][c] = { letter: "?", p: 1 }; continue; }   // ster bedekt door iets egaals
        const tg = [], leeg = [];
        for (let a = Math.max(0, r - 3); a <= Math.min(N - 1, r + 3); a++) for (let b = Math.max(0, c - 3); b <= Math.min(N - 1, c + 3); b++) {
          if (a === r && b === c) continue;
          if (tegel[a][b]) tg.push(tegel[a][b]);
          else if (!uit[a][b] && SOORT[a][b] === SOORT[r][c] && spreiding[a][b] <= 12) leeg.push(midden[a][b]);
        }
        let leegRef = leeg;
        if (leeg.length < 2) {
          leegRef = [];
          for (let a = 0; a < N; a++) for (let b = 0; b < N; b++)
            if ((a !== r || b !== c) && !uit[a][b] && SOORT[a][b] === SOORT[r][c]) leegRef.push(midden[a][b]);
        }
        if (!leegRef.length) continue;
        const dt = d(midden[r][c], med(tg.length ? tg : alleTegels)), dl = d(midden[r][c], med(leegRef));
        if (dt < 0.8 * dl) uit[r][c] = { letter: "?", p: 1 };
      }
    }
  }

  // rgba: cv.Mat (CV_8UC4) van het camerabeeld; hoek: 4 hoeken van het speelveld in die pixels.
  // Geeft 15 x 15: null (geen steen) of { letter, p } ("?" = joker).
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
    const labMat = new cv.Mat();
    cv.cvtColor(rgb, labMat, cv.COLOR_RGB2Lab);
    const gd = grijs.data, hd = hsv.data, ld = labMat.data;
    const midden = [], spreiding = [], tegel = [];
    const a0 = Math.round(C * 0.3), a1 = Math.round(C * 0.7);
    const cvm = { grijsMat: new cv.Mat(L, L, cv.CV_8UC1), inkMat: new cv.Mat(), lab: new cv.Mat(), stats: new cv.Mat(), cent: new cv.Mat() };
    const g = new Uint8Array(L * L), s = new Uint8Array(L * L);
    const uit = [];
    for (let r = 0; r < N; r++) {
      const rij = [], mr = [], sr = [], tr = [];
      midden.push(mr); spreiding.push(sr); tegel.push(tr);
      for (let c = 0; c < N; c++) {
        // kleur en egaalheid van het midden van het vakje (voor de jokers)
        let sL = 0, sa = 0, sb = 0, sg = 0, sg2 = 0, n = 0;
        for (let y = r * C + a0; y < r * C + a1; y++) for (let x = c * C + a0; x < c * C + a1; x++) {
          const i = y * B + x; sL += ld[3 * i]; sa += ld[3 * i + 1]; sb += ld[3 * i + 2]; sg += gd[i]; sg2 += gd[i] * gd[i]; n++;
        }
        mr.push([sL / n, sa / n, sb / n]); sr.push(Math.sqrt(Math.max(0, sg2 / n - (sg / n) ** 2))); tr.push(null);
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
        if (letter !== "-") {
          // kleur van de steen zelf (de lichte pixels rond de letter)
          const ink = cvm.inkMat.data; let tL = 0, ta = 0, tb = 0, tn = 0;
          for (let y = 0; y < L; y++) for (let x = 0; x < L; x++) {
            if (ink[y * L + x]) continue;
            const i = (r * C + M + y) * B + c * C + M + x; tL += ld[3 * i]; ta += ld[3 * i + 1]; tb += ld[3 * i + 2]; tn++;
          }
          if (tn) tr[c] = [tL / tn, ta / tn, tb / tn];
        }
      }
      uit.push(rij);
    }
    zoekJokers(uit, midden, spreiding, tegel);
    [labMat, bron, doel, T, bord, rgb, grijs, hsv, cvm.grijsMat, cvm.inkMat, cvm.lab, cvm.stats, cvm.cent].forEach(m => m.delete());
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

  window.Lezer = { laden, leesBord, woorden, SOORT, klaar: () => net !== null, klassen: () => net.klassen };
})();
