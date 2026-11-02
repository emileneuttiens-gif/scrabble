// Een tweede scherm koppelen (andere gsm, tablet, laptop) dat de stand groot toont.
// Rechtstreekse verbinding tussen de twee browsers (WebRTC via PeerJS); de openbare PeerJS-server zorgt alleen
// voor het eerste contact. Er gaan alleen namen, punten en woorden over, geen camerabeelden.
"use strict";

window.Koppel = (() => {
  let peer = null, id = null, laatst = "";
  const verbindingen = new Set();
  let opBericht = () => {};

  // lokaal testen: eigen PeerJS-server op poort 9000
  const instelling = () => (location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ? { host: location.hostname, port: 9000, path: "/scrabble" } : {};

  function nieuweCode() {
    const tekens = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // geen 0/O, 1/I: makkelijk over te typen
    let c = ""; for (let i = 0; i < 6; i++) c += tekens[Math.floor(Math.random() * tekens.length)];
    return c;
  }
  const peerId = code => "scrabble-camera-" + code;

  function start(status) {
    if (peer && !peer.destroyed) {
      if (peer.disconnected) peer.reconnect();
      status(verbindingen.size ? "gekoppeld" : "wacht");
      return id;
    }
    id = nieuweCode();
    peer = new Peer(peerId(id), { ...instelling(), debug: 0 });
    status("start");
    peer.on("open", () => status("wacht"));
    peer.on("connection", conn => {
      conn.on("open", () => {
        verbindingen.add(conn);
        laatst = "";               // het nieuwe scherm meteen alles sturen
        status("gekoppeld");
        opBericht({ type: "hallo" });
      });
      conn.on("data", d => { try { opBericht(d); } catch (e) { console.error(e); } });
      conn.on("close", () => { verbindingen.delete(conn); status(verbindingen.size ? "gekoppeld" : "wacht"); });
      conn.on("error", () => { verbindingen.delete(conn); });
    });
    peer.on("disconnected", () => { setTimeout(() => { if (peer && !peer.destroyed) peer.reconnect(); }, 2000); });
    peer.on("error", e => {
      if (e.type === "unavailable-id") { peer.destroy(); peer = null; start(status); return; }   // code al in gebruik
      status("fout", e.type);
    });
    return id;
  }

  function stuur(staat) {
    if (!verbindingen.size) return;
    const tekst = JSON.stringify(staat);
    if (tekst === laatst) return;
    laatst = tekst;
    for (const c of verbindingen) { try { c.send({ type: "stand", ...staat }); } catch (e) {} }
  }

  return {
    start, stuur,
    opBericht: f => { opBericht = f; },
    gekoppeld: () => verbindingen.size > 0,
    link: () => new URL("scorebord.html#" + id, location.href).href,
    code: () => id,
  };
})();
