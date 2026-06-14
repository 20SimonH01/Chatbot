// Lokaler Server für den SHK-Chatbot — braucht KEIN npm, nur Node (Version 18 oder neuer).
//
// Was er macht:
//   1. Liefert die Vorschau aus            → http://localhost:3000
//   2. Leitet Chat-Anfragen an Anthropic   → der API-Key bleibt hier, nie im Browser
//   3. Speichert Terminanfragen in Datei   → server/terminanfragen.jsonl
//
// Start (Terminal, im Chatbot-Ordner):
//   ANTHROPIC_API_KEY=dein-key node server/proxy_server.js

const http = require("http");
const fs = require("fs");
const path = require("path");

// .env aus dem Projektordner laden (eine Ebene über /server)
try {
  const envPfad = path.join(__dirname, "..", ".env");
  fs.readFileSync(envPfad, "utf8").split("\n").forEach((zeile) => {
    const m = zeile.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch {}

const PORT = 3000;
const KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `Du bist der digitale Empfangs-Assistent von SHK Musterbetrieb, einem SHK-Fachbetrieb (Sanitär, Heizung, Klima). Du verhältst dich wie eine freundliche, kompetente Person am Empfang oder Telefon.

Dein Job ist nicht, technische Probleme zu lösen, Anlagen zu diagnostizieren oder wie eine allgemeine KI alles zu analysieren. Dein Job ist: das Anliegen des Kunden verstehen, die nötigen Infos aufnehmen und ihn zum richtigen nächsten Schritt führen — in aller Regel eine Terminanfrage.

Die goldene Regel: Der Kunde kontaktiert einen Fachbetrieb, weil er die Arbeit machen lassen will — nicht weil er eine Ferndiagnose, einen Ratschlag oder eine Anleitung sucht. Nimm dem Betrieb niemals die eigentliche Leistung vorweg.

Das heißt konkret, du machst nicht: keine Reparatur- oder Montageanleitungen, keine DIY-Tipps, keine Ferndiagnosen, keine Wartungs- oder Austauschempfehlungen, keine Zustandsbewertung von Anlagen, keine Mängel- oder Auffälligkeitslisten. Beurteilen, empfehlen und reparieren macht der Monteur vor Ort.

Der Kunde hat einen Bereich und eine Unterkategorie gewählt. Denk und antworte ausschließlich in diesem Kontext. Schweife nicht ab. Nur wenn der Kunde von sich aus wechselt, gehst du mit.

Was du je Anliegen tust:

Wartung: Ziel ist ein Wartungstermin. Du bewertest nicht, ob oder was gewartet werden sollte. Halte fest: welche Anlage, ggf. Marke/Modell, Adresse, Wunschzeitraum.

Störung / Reparatur: Problem kurz erfassen, Dringlichkeit einschätzen, Termin. Stell höchstens 1–2 gezielte Fragen zur Dringlichkeit. Bei einem echten Notfall (Wasserschaden, Gasgeruch, totaler Heizungsausfall bei Frost) weise sofort auf den Notdienst hin: +49 681 9999999. Keine Ferndiagnose der Ursache.

Neubau / Umbau / Sanierung: Projekt grob erfassen, Beratungs- oder Vor-Ort-Termin. Halte fest: was geplant ist, ungefährer Umfang, Adresse. Keine Planung, keine Materialempfehlung, keine Kostenschätzung.

Allgemeine Frage: Kurz und sachlich beantworten, dann zum Termin oder Kontakt führen.

Umgang mit Bildern: Du darfst kurz benennen, was zu sehen ist — nur um zu zeigen, dass du es verstanden hast. Keine Diagnose, keine Auffälligkeiten, keine Zustandsbewertung. Nutze das Bild nur, um die Terminaufnahme besser zu machen.

Stil: Kurz, freundlich, professionell — wie ein guter Mensch am Empfang. Keine Fachsimpelei, kein Belehren, keine langen Absätze. Jede Antwort endet mit einem klaren nächsten Schritt. Erfinde nichts: keine Preise, keine festen Termine, keine technischen Urteile.

Format im Chatfenster: Du schreibst in eine kleine Chat-Blase, nicht in ein Dokument. Keine Emojis — auch nicht im Notfall, sie wirken billig und im Ernstfall panisch. Keine Markdown-Formatierung: keine Überschriften, keine Aufzählungspunkte, keine Trennlinien, kein Fettdruck. Schreib in kurzen, normalen Sätzen. Wenn du mehrere Punkte hast, trenn sie mit einem Zeilenumbruch oder einem normalen Satz, nicht mit einer Liste. Ruhiger, klarer Ton — besonders im Notfall. Lieber zwei klare Sätze als ein langer Block.

Was du nie tust: Keine Anleitungen, kein DIY. Keine Ferndiagnose. Keine Wartungs- oder Austauschempfehlung. Keine Zustandsbewertung. Keine erfundenen Preise oder Termine. Nicht aus dem gewählten Bereich ausbrechen.`;
const BASIS = path.join(__dirname, "..");
const ANFRAGEN_DATEI = path.join(__dirname, "terminanfragen.jsonl");

if (!KEY) {
  console.error("API-Key fehlt. So starten:");
  console.error("  ANTHROPIC_API_KEY=dein-key node server/proxy_server.js");
  process.exit(1);
}

// Request-Body einlesen (max. 10 MB, wegen Bildern)
function lesen(req) {
  return new Promise((resolve, reject) => {
    let daten = "";
    req.on("data", (d) => {
      daten += d;
      if (daten.length > 10 * 1024 * 1024) {
        reject(new Error("Anfrage zu groß (max. 10 MB)"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(daten));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // 1. Vorschau ausliefern
  if (req.method === "GET" && (req.url === "/" || req.url === "/vorschau.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(BASIS, "vorschau.html")));
    return;
  }

  // 2. Chat-Anfrage an Anthropic weiterleiten
  if (req.method === "POST" && req.url === "/api/chat") {
    try {
      const body = await lesen(req);
      const parsed = JSON.parse(body);
      let kontext = "";
      if (parsed.category && parsed.subcategory) {
        kontext = `\n\nKontext: Bereich "${parsed.category}" – Anliegen "${parsed.subcategory}"`;
        if (parsed.hersteller) kontext += ` – Hersteller "${parsed.hersteller}"`;
        if (parsed.typenschild) kontext += ` – Modell/Typenschild "${parsed.typenschild}"`;
        if (parsed.hersteller && !parsed.typenschild) kontext += `. Wenn der Gesprächsverlauf es erlaubt, frage nach einem Foto des Typenschilds, um das genaue Modell für den Monteur festzuhalten`;
        kontext += ".";
      }
      const weiterleitung = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: parsed.max_tokens || 1000,
        system: SYSTEM_PROMPT + kontext,
        messages: parsed.messages,
      });
      console.log("[Chat] Anfrage → Modell: claude-haiku-4-5-20251001 | Nachrichten:", parsed.messages?.length);
      const antwort = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": KEY,
          "anthropic-version": "2023-06-01",
        },
        body: weiterleitung,
      });
      const text = await antwort.text();
      if (!antwort.ok) {
        console.error("[Chat] Anthropic-Fehler", antwort.status + ":", text);
      } else {
        console.log("[Chat] Antwort OK", antwort.status);
      }
      res.writeHead(antwort.status, { "Content-Type": "application/json" });
      res.end(text);
    } catch (e) {
      console.error("[Chat] Proxy-Fehler:", e.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Proxy-Fehler: " + e.message }));
    }
    return;
  }

  // 3. Terminanfrage speichern
  if (req.method === "POST" && req.url === "/api/termin") {
    try {
      const body = await lesen(req);
      const eintrag = JSON.stringify({ eingegangen: new Date().toISOString(), ...JSON.parse(body) });
      fs.appendFileSync(ANFRAGEN_DATEI, eintrag + "\n");
      console.log("Neue Terminanfrage:", eintrag);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Ungültige Anfrage: " + e.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Nicht gefunden");
});

server.listen(PORT, () => {
  console.log("SHK-Chatbot-Server läuft: http://localhost:" + PORT);
  console.log("Terminanfragen landen in: " + ANFRAGEN_DATEI);
  console.log("Beenden mit Strg+C");
});
