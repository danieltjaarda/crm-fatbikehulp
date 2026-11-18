// DHL-labelbot. Draait op de pc in de werkplaats: haalt labelopdrachten op uit de CRM,
// vult het formulier van DHL (my.dhlecommerce.nl, particulier, zonder inloggen) in tot
// aan de betaling en meldt de betaallink aan de CRM. Die stuurt hem als pushmelding
// naar de telefoon. De bot betaalt zelf nooit. Na het betalen haalt hij de volgcode op.
//
//   node bot.js            draaien (instellingen.json nodig, zie instellingen.voorbeeld.json)
//   node bot.js --proef    één proefronde bij DHL tot aan de betaallink, zonder CRM en zonder betalen
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const DHL = "https://my.dhlecommerce.nl";
const MAP = path.join(__dirname, "labels");
const PROEF = process.argv.includes("--proef");
const FORMATEN = ["ENVELOPE", "XSMALL", "SMALL", "MEDIUM", "XLARGE"];
const BETAAL_WACHT = 40 * 60 * 1000; // zo lang wacht de bot op de betaling

function log(...a) {
  const regel = new Date().toISOString().slice(0, 19).replace("T", " ") + "  " + a.join(" ");
  console.log(regel);
  try { fs.appendFileSync(path.join(__dirname, "bot.log"), regel + "\n"); } catch (e) { /* loggen is bijzaak */ }
}
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

function leesInstellingen() {
  const p = process.env.BOT_INSTELLINGEN || path.join(__dirname, "instellingen.json");
  if (!fs.existsSync(p)) {
    if (PROEF) return { afzender: { standaard: { voornaam: "Test", achternaam: "Verzender", postcode: "1012JS", huisnummer: "1", email: "test@example.com" } } };
    throw new Error("instellingen.json ontbreekt. Kopieer instellingen.voorbeeld.json en vul hem in.");
  }
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!PROEF && (!c.crmUrl || String(c.sleutel || "").length < 24)) throw new Error("Vul crmUrl en sleutel (minstens 24 tekens) in instellingen.json in");
  const a = c.afzender && c.afzender.standaard;
  if (!a || !a.voornaam || !a.achternaam || !a.postcode || !a.huisnummer || !a.email) throw new Error("Vul afzender.standaard volledig in (voornaam, achternaam, postcode, huisnummer, email)");
  return c;
}

async function crm(cfg, methode, body) {
  const r = await fetch(cfg.crmUrl.replace(/\/$/, "") + "/api/label", {
    method: methode,
    headers: { Authorization: "Bearer " + cfg.sleutel, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.fout || "De CRM gaf " + r.status); e.status = r.status; throw e; }
  return j;
}

/** De velden van een verzender of ontvanger als [naam van het invoerveld, waarde]. */
function velden(wie, p) {
  return [
    [wie + ".firstName", p.voornaam], [wie + ".lastName", p.achternaam], [wie + ".companyName", p.bedrijf],
    [wie + ".address.postalCode", String(p.postcode).replace(/\s/g, "").toUpperCase()], [wie + ".address.houseNumber", p.huisnummer],
    [wie + ".address.houseNumberSuffix", p.toevoeging], [wie + ".emailAddress", p.email], [wie + ".phoneNumber", p.telefoon]
  ].filter(([, w]) => w).map(([n, w]) => [n, String(w).trim()]);
}
/**
 * Vult de velden in en kijkt daarna of alles er echt staat: het formulier van DHL
 * wist soms een veld dat is ingevuld terwijl de pagina nog aan het laden was.
 */
async function vulIn(page, lijst) {
  for (let ronde = 0; ronde < 4; ronde++) {
    let goed = true;
    for (const [naam, waarde] of lijst) {
      const veld = page.locator('input[name="' + naam + '"]');
      if ((await veld.inputValue()) === waarde) continue;
      goed = false;
      await veld.click();
      await veld.fill(waarde);
    }
    if (goed) return;
    await wacht(1200);
  }
  throw new Error("Het formulier van DHL neemt de gegevens niet over");
}
// De keuzerondjes en vinkjes van DHL zijn onzichtbare invoervelden: rechtstreeks aanklikken.
async function kies(page, selector) {
  const el = page.locator(selector);
  await el.waitFor({ state: "attached", timeout: 15000 });
  if (!(await el.isChecked())) await el.evaluate((e) => e.click());
}

/**
 * Loopt het formulier van DHL door tot er een betaallink is. Geeft de browsercontext
 * terug: die blijft open, want alleen daarin is na het betalen het label op te vragen.
 */
async function maakBetaling(browser, opdracht, afzender) {
  if (!FORMATEN.includes(opdracht.formaat)) throw new Error("Onbekend formaat " + opdracht.formaat);
  const ctx = await browser.newContext({ locale: "nl-NL", viewport: { width: 1280, height: 1600 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(25000);
  let betaalUrl = "", bedrag = 0;
  page.on("response", async (r) => {
    try {
      if (/\/basket\/payment$/.test(r.url()) && r.request().method() === "POST" && r.ok()) betaalUrl = (await r.json()).paymentUrl || "";
      else if (/\/basket\/summary$/.test(r.url()) && r.ok()) { const j = await r.json(); if (j && j.totalPrice && j.totalPrice.withTax) bedrag = j.totalPrice.withTax; }
    } catch (e) { /* antwoord al weg */ }
  });
  try {
    // 1. formaat kiezen (bestemming staat standaard op Nederland)
    await page.goto(DHL + "/home/c2c/new-parcel", { waitUntil: "domcontentloaded", timeout: 60000 });
    const plus = page.getByTestId("parcel-type-select-Standard-" + opdracht.formaat + "-list-item-amount-picker-increment");
    await plus.waitFor({ timeout: 40000 });
    const cookies = page.locator("#onetrust-reject-all-handler");
    await cookies.click({ timeout: 4000 }).catch(() => {});
    const land = await page.locator('input[name="destinationCountry"]').inputValue();
    if (land !== "Nederland") throw new Error("DHL staat niet op bestemming Nederland maar op " + land);
    await plus.click();
    await page.getByTestId("add-to-basket-button").click();
    await page.waitForURL(/\/c2c\/details\//);

    // 2. afzender, ontvanger en bezorging
    await page.locator('input[name="sender.firstName"]').waitFor();
    await page.locator('input[name="deliveryOption"]').first().waitFor({ state: "attached" });
    await wacht(1000);
    const gegevens = [...velden("sender", afzender), ...velden("receiver", opdracht.ontvanger)];
    await vulIn(page, gegevens);
    await wacht(2500); // DHL zoekt straat en plaats op bij postcode en huisnummer
    await kies(page, 'input[name="deliveryOption"][value="' + (opdracht.bezorging === "punt" ? "DeliverAtServicePoint" : "DeliverToDoor") + '"]');
    if (opdracht.nietBijBuren && opdracht.bezorging !== "punt") await kies(page, 'input[name="serviceOptions.NotToNeighbours.checked"]');
    await wacht(800);
    await vulIn(page, gegevens); // laatste controle vlak voor het opslaan
    await page.getByTestId("save-basket-item-details-button").click();
    try { await page.waitForURL(/\/c2c\/basket/, { timeout: 20000 }); }
    catch (e) {
      // Alleen de foutregels onder de velden, niet de veldnamen zelf ("Postcode *").
      const fouten = await page.evaluate(() => Array.from(document.querySelectorAll(".Mui-error")).map((x) => x.innerText.trim()).filter((t, i, a) => t && !/\*$/.test(t) && a.indexOf(t) === i).slice(0, 4).join("; "));
      throw new Error("DHL keurt de gegevens af" + (fouten ? ": " + fouten.replace(/\s+/g, " ").slice(0, 200) : " (staat het adres goed?)"));
    }

    // 3. winkelwagen: voorwaarden en door
    await page.getByTestId("to-shipment-options-button").waitFor();
    await kies(page, 'input[name="termsAndConditions"]');
    await page.getByTestId("to-shipment-options-button").click();
    await page.waitForURL(/\/c2c\/shipment-options/);

    // 4. label zelf printen (gratis) of inlevercode, en inleveren bij een DHL-punt
    await page.getByTestId("to-payment-button").waitFor();
    await kies(page, 'input[name="labelType.DHL_PARCEL"][value="' + (afzender.inlevercode ? "Printless" : "Print") + '"]');
    await wacht(800);
    await page.getByTestId("to-payment-button").click();
    await page.waitForURL(/\/payment\/start\?paymentId=/, { timeout: 30000 });
    const paymentId = new URL(page.url()).searchParams.get("paymentId");
    if (!betaalUrl) betaalUrl = page.url();
    const status = await (await ctx.request.get(DHL + "/payment-service/payment/" + paymentId)).json();
    const orderId = new URL(status.returnUrl).searchParams.get("orderId");
    if (!orderId) throw new Error("DHL gaf geen ordernummer terug");
    return { ctx, page, betaalUrl, bedrag, paymentId, orderId };
  } catch (e) {
    fs.mkdirSync(MAP, { recursive: true });
    await page.screenshot({ path: path.join(MAP, "fout-" + String(opdracht.orderId).replace(/[^\w-]/g, "_") + ".png"), fullPage: true }).catch(() => {});
    await ctx.close().catch(() => {});
    throw new Error(String(e.message || e).split("\n")[0]);
  }
}

/** Zoekt de volgcode in wat DHL over de order teruggeeft. */
function zoekVolgcode(order) {
  let gevonden = "";
  (function loop(v, sleutel) {
    if (gevonden || v == null) return;
    if (typeof v === "string") {
      if (/track|barcode|shipmentnumber|parcelnumber/i.test(sleutel || "") && /^[A-Z0-9]{8,30}$/.test(v)) gevonden = v;
    } else if (typeof v === "object") for (const [k, w] of Object.entries(v)) loop(w, Array.isArray(v) ? sleutel : k);
  })(order, "");
  if (!gevonden) { const m = /"((?:JVGL|JJD|3S)[A-Z0-9]{8,26})"/.exec(JSON.stringify(order)); if (m) gevonden = m[1]; }
  return gevonden;
}

/** De order bij DHL: bestaat pas als er betaald is. null = nog niet. */
async function haalOrder(sessie) {
  const xsrf = (await sessie.ctx.cookies(DHL)).find((c) => /xsrf/i.test(c.name));
  const r = await sessie.ctx.request.get(DHL + "/consumer-sender-services/orders/" + sessie.orderId, { headers: xsrf ? { "X-XSRF-TOKEN": xsrf.value } : {} });
  if (r.status() === 404) return null;
  if (!r.ok()) throw new Error("DHL gaf " + r.status() + " bij het opvragen van de order");
  return r.json();
}

const VOLGCODE = /\b(JVGL[0-9]{10,24}|JJD[0-9]{10,25}|3S[A-Z0-9]{9,15})\b/;

/**
 * Haalt het label (pdf) op en leest de volgcode eruit. Dat kan alleen in de
 * browsersessie waarin het label is besteld. DHL geeft de volgcode nergens anders terug.
 */
async function haalLabel(sessie, order, naam) {
  const stuk = Object.values(order.orderArtifacts || {}).find((a) => a && a.label && a.label.url);
  if (!stuk) return { code: "" };
  const xsrf = (await sessie.ctx.cookies(DHL)).find((c) => /xsrf/i.test(c.name));
  const r = await sessie.ctx.request.get(stuk.label.url, { headers: xsrf ? { "X-XSRF-TOKEN": xsrf.value } : {} });
  if (!r.ok()) throw new Error("DHL gaf " + r.status() + " bij het ophalen van het label");
  const pdf = await r.body();
  const bestand = path.join(MAP, naam + "-label.pdf");
  fs.writeFileSync(bestand, pdf);
  let code = "";
  try { const m = VOLGCODE.exec((await require("pdf-parse")(pdf)).text.replace(/[ \t]/g, "")); if (m) code = m[1]; } catch (e) { log(naam, "label gelezen maar de volgcode niet gevonden:", e.message); }
  return { code, bestand };
}

// ---------- printen op de labelprinter ----------
const PDFJS = path.join(__dirname, "node_modules", "pdfjs-dist", "build");
/**
 * Maakt van de eerste pagina van de pdf een afbeelding van alleen het label: de witte
 * randen eromheen worden weggesneden (DHL zet het label soms op een groter vel) en een
 * liggend label wordt rechtop gezet. Het tekenen gebeurt in de browser van de bot.
 */
async function pdfNaarPng(browser, pdf) {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.route("http://bot.lokaal/**", (route) => {
      const naam = new URL(route.request().url()).pathname.slice(1);
      if (!naam) return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>label</title>" });
      if (naam === "label.pdf") return route.fulfill({ contentType: "application/pdf", body: pdf });
      if (/^pdf(\.worker)?\.min\.mjs$/.test(naam)) return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(PDFJS, naam)) });
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://bot.lokaal/");
    const url = await page.evaluate(async () => {
      const pdfjs = await import("/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const blad = await (await pdfjs.getDocument("/label.pdf").promise).getPage(1);
      const vp = blad.getViewport({ scale: 4 }); // 288 punten per inch: ruim genoeg voor de 203 van de printer
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext("2d", { willReadFrequently: true });
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      await blad.render({ canvasContext: g, viewport: vp }).promise;
      // Rand zoeken: de buitenste rijen en kolommen waar iets donkers staat.
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] + d[i + 1] + d[i + 2] < 660) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) throw new Error("De pdf is leeg");
      const b = x1 - x0 + 1, h = y1 - y0 + 1, liggend = b > h * 1.05;
      const uit = document.createElement("canvas");
      uit.width = liggend ? h : b; uit.height = liggend ? b : h;
      const u = uit.getContext("2d");
      u.fillStyle = "#fff"; u.fillRect(0, 0, uit.width, uit.height);
      if (liggend) { u.translate(h, 0); u.rotate(Math.PI / 2); }
      u.drawImage(c, x0, y0, b, h, 0, 0, b, h);
      return uit.toDataURL("image/png");
    });
    return Buffer.from(url.split(",")[1], "base64");
  } finally { await ctx.close().catch(() => {}); }
}

/** Print een label-pdf op de labelprinter uit de instellingen. Geeft de naam van de afbeelding terug. */
async function printPdf(browser, cfg, pdf, naam) {
  const printer = cfg.printer || "ZDesigner ZD220-203dpi ZPL";
  fs.mkdirSync(MAP, { recursive: true });
  const png = path.join(MAP, naam + "-print.png");
  fs.writeFileSync(png, await pdfNaarPng(browser, pdf));
  if (cfg.printAlleenBestand) return png; // voor een proef zonder papier
  await new Promise((klaar, fout) => {
    require("node:child_process").execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "print.ps1"), "-Bestand", png, "-Printer", printer],
      { timeout: 60000, windowsHide: true }, (e, uit, err) => (e ? fout(new Error(String(err || e.message).split("\n").find((r) => r.trim()) || "printen mislukt")) : klaar(uit)));
  });
  return png;
}

/** Wacht tot er betaald is en haalt dan de volgcode op. magDoor() = false stopt het wachten. */
async function wachtOpBetaling(sessie, opdracht, magDoor) {
  const start = Date.now();
  while (Date.now() - start < BETAAL_WACHT) {
    await wacht(5000);
    if (!(await magDoor())) return { status: "gestopt" };
    let order = null;
    try { order = await haalOrder(sessie); } catch (e) { log(opdracht.orderId, "order opvragen lukte even niet:", e.message); continue; }
    if (!order) {
      const st = await (await sessie.ctx.request.get(DHL + "/payment-service/payment/" + sessie.paymentId)).json().catch(() => ({}));
      if (/cancel|fail|refus|expir|error|declin/i.test(st.status || "")) return { status: "mislukt", fout: "De betaling is niet gelukt (" + st.status + ")" };
      continue;
    }
    // Betaald. Het label staat als pdf klaar bij de order; daar staat de volgcode op.
    const naam = String(opdracht.orderId).replace(/[^\w-]/g, "_");
    fs.mkdirSync(MAP, { recursive: true });
    let code = zoekVolgcode(order), labelPdf;
    for (let i = 0; i < 12; i++) {
      try {
        const label = await haalLabel(sessie, order, naam);
        if (label.bestand) { log(opdracht.orderId, "label bewaard:", label.bestand); code = code || label.code; labelPdf = fs.readFileSync(label.bestand).toString("base64"); break; }
      } catch (e) { log(opdracht.orderId, "label ophalen lukte even niet:", e.message); }
      await wacht(5000);
      try { order = (await haalOrder(sessie)) || order; } catch (e) { /* volgende ronde */ }
    }
    fs.writeFileSync(path.join(MAP, naam + "-" + Date.now() + ".json"), JSON.stringify(order, null, 2));
    return { status: "klaar", trackTrace: code, labelPdf };
  }
  return { status: "verlopen" };
}

async function proef(browser, cfg) {
  const formaat = FORMATEN.find((f) => process.argv.includes(f)) || "SMALL";
  const opdracht = { orderId: "PROEF", formaat, bezorging: "deur", ontvanger: { voornaam: "Test", achternaam: "Ontvanger", postcode: "2513AA", huisnummer: "19", email: "test@example.com" } };
  log("proef: formulier van DHL invullen voor", formaat);
  const s = await maakBetaling(browser, opdracht, cfg.afzender.standaard);
  log("proef: betaallink", s.betaalUrl, "| bedrag €", s.bedrag, "| DHL-order", s.orderId);
  log("proef: order opvragen (hoort 'nog niet betaald' te zijn):", (await haalOrder(s)) === null ? "nog niet betaald" : "onverwacht antwoord");
  await s.ctx.close();
  log("proef klaar. Er is niets betaald; de link verloopt vanzelf.");
}

(async () => {
  const cfg = leesInstellingen();
  const browser = await chromium.launch({ headless: !cfg.zichtbaar });
  if (PROEF) { try { await proef(browser, cfg); } finally { await browser.close(); } return; }
  // node bot.js --print <bestand.pdf> [--zonder-papier]: één pdf uitsnijden en printen, los van de CRM
  const pi = process.argv.indexOf("--print");
  if (pi > 0) {
    try {
      const bestand = process.argv[pi + 1];
      if (process.argv.includes("--zonder-papier")) cfg.printAlleenBestand = true;
      log("print:", await printPdf(browser, cfg, fs.readFileSync(bestand), path.basename(bestand, ".pdf")), cfg.printAlleenBestand ? "(alleen de afbeelding gemaakt)" : "(naar de printer gestuurd)");
    } finally { await browser.close(); }
    return;
  }

  log("bot gestart, CRM:", cfg.crmUrl);
  let lopend = new Set();      // opdrachten die volgens de CRM nog op betaling wachten
  let crmFout = "";
  for (;;) {
    let werk = null;
    try { werk = await crm(cfg, "GET"); if (crmFout) log("CRM weer bereikbaar"); crmFout = ""; }
    catch (e) { if (e.message !== crmFout) log("CRM niet bereikbaar:", e.message); crmFout = e.message; }
    if (werk) {
      lopend = new Set(werk.wachtOpBetaling || []);
      // Printopdrachten uit de CRM: label ophalen, uitsnijden en naar de labelprinter.
      for (const p of werk.printen || []) {
        try {
          const r = await fetch(cfg.crmUrl.replace(/\/$/, "") + "/api/label?pdf=" + encodeURIComponent(p.orderId) + "&label=" + encodeURIComponent(p.labelId), { headers: { Authorization: "Bearer " + cfg.sleutel }, signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error("label ophalen gaf " + r.status);
          await printPdf(browser, cfg, Buffer.from(await r.arrayBuffer()), String(p.orderId).replace(/[^\w-]/g, "_"));
          log(p.orderId, "label geprint");
          await crm(cfg, "PUT", { print: p.id, status: "klaar" });
        } catch (e) {
          log(p.orderId, "printen mislukt:", e.message);
          await crm(cfg, "PUT", { print: p.id, status: "mislukt", fout: e.message }).catch(() => {});
        }
      }
      for (const opdracht of werk.opdrachten || []) {
        const afzender = (cfg.afzender && cfg.afzender[opdracht.winkel]) || cfg.afzender.standaard;
        log(opdracht.orderId, "label maken:", opdracht.formaat, opdracht.bezorging);
        try {
          const sessie = await maakBetaling(browser, opdracht, afzender);
          await crm(cfg, "PUT", { orderId: opdracht.orderId, id: opdracht.id, status: "betalen", betaalUrl: sessie.betaalUrl, bedrag: sessie.bedrag });
          lopend.add(opdracht.id);
          log(opdracht.orderId, "wacht op betaling van €", sessie.bedrag);
          // Het wachten loopt op de achtergrond, zodat een volgende opdracht meteen door kan.
          wachtOpBetaling(sessie, opdracht, async () => lopend.has(opdracht.id)).then(async (uit) => {
            log(opdracht.orderId, "afgelopen:", uit.status, uit.trackTrace || uit.fout || "");
            if (uit.status !== "gestopt") await crm(cfg, "PUT", { orderId: opdracht.orderId, id: opdracht.id, ...uit });
          }).catch((e) => log(opdracht.orderId, "melden mislukt:", e.message)).finally(() => sessie.ctx.close().catch(() => {}));
        } catch (e) {
          log(opdracht.orderId, "mislukt:", e.message);
          await crm(cfg, "PUT", { orderId: opdracht.orderId, id: opdracht.id, status: "mislukt", fout: e.message }).catch((f) => log(opdracht.orderId, "melden mislukt:", f.message));
        }
      }
    }
    await wacht((cfg.interval || 8) * 1000);
  }
})().catch((e) => { log("gestopt:", e.message); process.exit(1); });
