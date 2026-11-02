// Nederlandse woordenlijst (OpenTaal, BSD/CC BY 3.0 - zie OPENTAAL-LICENSE.txt).
// woorden.txt: kleine letters a-z, 2 tot 15 letters, accenten weggehaald (café -> cafe),
// zonder eigennamen en zonder afkortingen zonder klinker (gsm, btw, cd).
// Wordt op de achtergrond geladen; later gebruikt om de woorden die de OCR leest na te kijken.
(() => {
  let woorden = null;

  function normaal(w) {
    return w.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  const laden = fetch("woorden.txt?v=1")
    .then(r => { if (!r.ok) throw new Error("woordenlijst niet gevonden"); return r.text(); })
    .then(t => { woorden = new Set(t.split("\n").filter(Boolean)); return woorden.size; })
    .catch(e => { console.warn("Woordenboek:", e.message); return 0; });

  window.woordenboek = {
    laden,                                   // belofte: aantal woorden als het klaar is
    klaar: () => woorden !== null,
    aantal: () => (woorden ? woorden.size : 0),
    bestaat: w => (woorden ? woorden.has(normaal(w)) : null),   // null = nog niet geladen
  };
})();
