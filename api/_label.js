// DHL-verzendlabels. De CRM maakt zelf geen label: hij legt een opdracht klaar
// (hash `crm:labels`, de lopende of laatste per order) en de bot op de pc in de werkplaats
// pakt die op. De bot vult het formulier van DHL in tot aan de betaling en meldt de
// betaallink terug; die gaat als pushmelding (Seintje) naar de telefoon. Na het betalen
// stuurt de bot de volgcode en het label (pdf) terug. Dan gaat de order op Verzonden en
// krijgt de klant meteen het verzendbericht.
//
// Niets gaat verloren: elke stap komt in het logboek van de order (`crm:log:<order>`),
// en elk label blijft als pdf bewaard (`crm:labelpdf:<order>:<label>`), ook als er later
// een nieuw label voor dezelfde order wordt gemaakt.
//
//   LABEL_BOT_SLEUTEL   geheime sleutel waarmee de bot zich meldt (minstens 24 tekens);
//                       zonder staat het maken van labels uit
const crypto = require("node:crypto");
const { kv, opslagAan, pasAan, eenOrder, winkelVan, WINKELS, mailAan, maakMail, verstuur, logMail, logboek } = require("./_lib");
const seintje = require("./_seintje");

// De pakketformaten van DHL voor particulieren (my.dhlecommerce.nl); de sleutel is die van DHL.
const FORMATEN = {
  ENVELOPE: { naam: "Envelop", max: "tot 500 g · 38 × 26 × 3 cm" },
  XSMALL: { naam: "Brievenbuspakket", max: "tot 2 kg · 38 × 26 × 3 cm" },
  SMALL: { naam: "Pakket tot 5 kg", max: "80 × 50 × 35 cm" },
  MEDIUM: { naam: "Pakket tot 10 kg", max: "80 × 50 × 35 cm" },
  XLARGE: { naam: "Pakket tot 20 kg", max: "80 × 50 × 35 cm" }
};
const BEZORGING = { deur: "Thuisbezorgen", punt: "DHL ServicePoint bij de klant" };
const LOPEND = ["wacht", "bezig", "betalen"];
const MIN = 60 * 1000;
const BEZIG_MAX = 8 * MIN;     // zo lang mag de bot over het invullen doen
const BETALEN_MAX = 45 * MIN;  // zo lang blijft de betaallink staan

function botSleutel() { return String(process.env.LABEL_BOT_SLEUTEL || ""); }
function labelsAan() { return botSleutel().length >= 24 && opslagAan(); }
function isBot(req) {
  const s = botSleutel();
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (s.length < 24 || !m) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(a, b);
}

/** "12A", "12-2" of "12 bis" → nummer en toevoeging. */
function splitsHuisnummer(s) {
  const m = /^(\d{1,5})\s*[-/ ]?\s*([A-Za-z0-9][A-Za-z0-9 -]{0,7})?$/.exec(String(s || "").trim());
  return m ? { nummer: m[1], toevoeging: (m[2] || "").trim() } : null;
}

/**
 * De ontvanger zoals DHL die wil hebben. DHL zoekt straat en plaats zelf op bij
 * postcode + huisnummer. Gooit een fout met een leesbare melding als er iets ontbreekt.
 */
function ontvanger(o) {
  const a = o.shippingAddress || {};
  const land = String(a.country || "").trim().toLowerCase();
  if (land && !["nl", "nld", "nederland", "netherlands", "the netherlands"].includes(land)) throw new Error("Een DHL-label maken kan nu alleen voor adressen in Nederland");
  const postcode = String(a.postalCode || "").replace(/\s/g, "").toUpperCase();
  if (!/^\d{4}[A-Z]{2}$/.test(postcode)) throw new Error("De postcode van de klant klopt niet (vul hem in als 1234 AB)");
  let huis = splitsHuisnummer(a.houseNumber);
  if (!huis) {
    // Huisnummer staat achter de straat, zoals bij Deskna: "Dorpsstraat 12a"
    const m = /^.*?[\s,]+(\d{1,5}\s*[-/ ]?\s*[A-Za-z0-9 -]{0,8})$/.exec(String(a.streetAndNumber || a.street || "").trim());
    huis = m ? splitsHuisnummer(m[1]) : null;
  }
  if (!huis) throw new Error("Het huisnummer van de klant ontbreekt of klopt niet");
  const naam = String(o.customerName || "").trim().replace(/\s+/g, " ");
  if (!naam) throw new Error("De naam van de klant ontbreekt");
  const delen = naam.split(" ");
  const email = String(o.customerEmail || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new Error("Het e-mailadres van de klant ontbreekt of klopt niet (DHL heeft het nodig)");
  return {
    voornaam: delen[0].slice(0, 35), achternaam: (delen.slice(1).join(" ") || delen[0]).slice(0, 35),
    postcode, huisnummer: huis.nummer, toevoeging: huis.toevoeging, email
  };
}

function leesJob(v) { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } }
async function lees(orderId) { return leesJob(await kv("HGET", "crm:labels", orderId)); }
async function bewaar(job) { job.bijgewerkt = new Date().toISOString(); await kv("HSET", "crm:labels", job.orderId, JSON.stringify(job)); return job; }

/** Opdrachten die te lang stilstaan krijgen hun eindstatus; verandert niets in de opslag. */
function metVerloop(job, nu) {
  if (!job) return null;
  const oud = (nu || Date.now()) - Date.parse(job.bijgewerkt || job.aangemaakt || 0);
  if (job.status === "bezig" && oud > BEZIG_MAX) return { ...job, status: "mislukt", fout: "De bot is halverwege gestopt. Probeer het opnieuw." };
  if (job.status === "betalen" && oud > BETALEN_MAX) return { ...job, status: "verlopen" };
  return job;
}
/** Wat het scherm van een opdracht mag zien. */
function publiek(job) {
  const j = metVerloop(job);
  if (!j) return null;
  const { id, botId, ontvanger: _o, ...rest } = j;
  return rest;
}
const omschrijving = (job) => FORMATEN[job.formaat].naam + ", " + BEZORGING[job.bezorging].toLowerCase();

async function alle() {
  if (!opslagAan()) return {};
  const plat = (await kv("HGETALL", "crm:labels")) || [];
  const uit = {};
  for (let i = 0; i < plat.length; i += 2) {
    if (plat[i].startsWith(PRINT)) continue; // printopdrachten staan in dezelfde hash
    const j = publiek(leesJob(plat[i + 1])); if (j) uit[plat[i]] = j;
  }
  return uit;
}

// ---------- printen op de labelprinter ----------
// Een printopdracht staat in dezelfde hash als de labels (veld `print:<id>`), zodat de bot
// met één keer ophalen alles heeft. De bot haalt de pdf op, snijdt het label uit, schaalt
// het naar het formaat van de labelprinter (Zebra ZD220, 100 × 150 mm) en print het.
const PRINT = "print:";
async function vraagPrint(orderId, labelId) {
  if (!labelsAan()) throw new Error("Printen staat nog uit: de bot is niet gekoppeld");
  if (!(await leesPdf(orderId, labelId))) throw new Error("Dit label is niet bewaard, dus het kan niet geprint worden");
  const p = { id: crypto.randomUUID(), orderId, labelId, status: "wacht", tijd: new Date().toISOString() };
  await kv("HSET", "crm:labels", PRINT + p.id, JSON.stringify(p));
  await logboek(orderId, "DHL-label naar de labelprinter gestuurd");
  return { id: p.id, status: p.status };
}
async function leesPrint(id) {
  const p = leesJob(await kv("HGET", "crm:labels", PRINT + String(id)));
  return p ? { id: p.id, status: p.status, fout: p.fout || "" } : null;
}
/** De bot meldt of het printen is gelukt. */
async function meldPrint(invoer) {
  const p = leesJob(await kv("HGET", "crm:labels", PRINT + String((invoer || {}).print)));
  if (!p) { const e = new Error("Deze printopdracht bestaat niet meer"); e.status = 409; throw e; }
  p.status = invoer.status === "klaar" ? "klaar" : "mislukt";
  p.fout = p.status === "mislukt" ? String(invoer.fout || "onbekende fout").slice(0, 300) : "";
  p.tijd = new Date().toISOString();
  await kv("HSET", "crm:labels", PRINT + p.id, JSON.stringify(p));
  await logboek(p.orderId, p.status === "klaar" ? "DHL-label geprint op de labelprinter" : "Printen mislukt: " + p.fout, { door: "bot" });
  return { id: p.id, status: p.status, fout: p.fout };
}

/** Legt een labelopdracht klaar voor de bot. */
async function vraagAan(o, invoer) {
  if (!labelsAan()) throw new Error("Labels maken staat nog uit: LABEL_BOT_SLEUTEL is niet ingesteld");
  const formaat = String((invoer && invoer.formaat) || "");
  const bezorging = String((invoer && invoer.bezorging) || "deur");
  if (!FORMATEN[formaat]) throw new Error("Kies een pakketformaat");
  if (!BEZORGING[bezorging]) throw new Error("Kies thuisbezorgen of een DHL ServicePoint");
  const naar = ontvanger(o);
  const huidig = metVerloop(await lees(o.id));
  if (huidig && LOPEND.includes(huidig.status)) throw new Error("Er loopt al een label voor deze bestelling. Annuleer dat eerst.");
  const job = await bewaar({
    id: crypto.randomUUID(), orderId: o.id, winkel: winkelVan(o), formaat, bezorging,
    nietBijBuren: bezorging === "deur" && !!(invoer && invoer.nietBijBuren),
    status: "wacht", aangemaakt: new Date().toISOString(), ontvanger: naar
  });
  await logboek(o.id, "DHL-label aangevraagd: " + omschrijving(job) + ", naar " + naar.postcode + " " + naar.huisnummer + (naar.toevoeging ? " " + naar.toevoeging : ""));
  return publiek(job);
}

async function annuleer(orderId) {
  const job = await lees(orderId);
  if (!job || !LOPEND.includes(job.status)) return publiek(job);
  job.status = "geannuleerd";
  await bewaar(job);
  await logboek(orderId, "DHL-label geannuleerd (" + omschrijving(job) + ")");
  return publiek(job);
}

/**
 * Voor de bot: nieuwe opdrachten (die meteen op "bezig" gaan, zodat ze maar één keer
 * worden opgepakt) en de opdrachten die nog op een betaling wachten.
 */
async function voorBot() {
  const plat = (await kv("HGETALL", "crm:labels")) || [];
  const opdrachten = [], wachtOpBetaling = [], printen = [];
  for (let i = 0; i < plat.length; i += 2) {
    const job = leesJob(plat[i + 1]);
    if (!job) continue;
    if (plat[i].startsWith(PRINT)) {
      // Printopdracht: één keer uitdelen; na een dag opruimen (wat er gebeurd is staat in het logboek).
      if (job.status === "wacht") { job.status = "bezig"; await kv("HSET", "crm:labels", plat[i], JSON.stringify(job)); printen.push({ id: job.id, orderId: job.orderId, labelId: job.labelId }); }
      else if (Date.now() - Date.parse(job.tijd || 0) > 24 * 60 * MIN) await kv("HDEL", "crm:labels", plat[i]);
      continue;
    }
    if (job.status === "wacht") {
      job.status = "bezig";
      await bewaar(job);
      opdrachten.push({ id: job.id, orderId: job.orderId, winkel: job.winkel, formaat: job.formaat, bezorging: job.bezorging, nietBijBuren: !!job.nietBijBuren, ontvanger: job.ontvanger });
    } else if (metVerloop(job).status === "betalen") wachtOpBetaling.push(job.id);
  }
  return { opdrachten, wachtOpBetaling, printen };
}

// ---------- het label als pdf ----------
const PDF_MAX = 900 * 1000;      // tekens base64; ruim genoeg voor één label
const pdfSleutel = (orderId, labelId) => "crm:labelpdf:" + orderId + ":" + labelId;
/** Bewaart het label (base64 van een pdf), zonder einddatum. Geeft true als er iets is bewaard. */
async function bewaarPdf(orderId, labelId, base64) {
  if (typeof base64 !== "string" || !base64.startsWith("JVBERi0") || base64.length > PDF_MAX || !/^[A-Za-z0-9+/=]+$/.test(base64)) return false;
  await kv("SET", pdfSleutel(orderId, labelId), base64);
  return true;
}
/** Een bewaard label als bytes, of null. */
async function leesPdf(orderId, labelId) {
  if (!/^[\w-]{8,64}$/.test(String(labelId || ""))) return null;
  const v = await kv("GET", pdfSleutel(orderId, labelId));
  return typeof v === "string" && v.startsWith("JVBERi0") ? Buffer.from(v, "base64") : null;
}

function euro(n) { return "€ " + (Number(n) || 0).toFixed(2).replace(".", ","); }

/**
 * Het verzendbericht naar de klant zodra het label er is. Eén keer per order: is er al
 * een verzendbericht gestuurd, dan niet nog eens. Geeft terug wat er is gebeurd.
 */
async function mailKlant(orderId) {
  try {
    const o = await eenOrder(orderId);
    if (!o) return "order niet gevonden";
    if (!mailAan(winkelVan(o))) return "mailen staat uit voor " + WINKELS[winkelVan(o)].naam;
    if ((o.mails || []).some((m) => m.soort === "verzonden")) return "had al een verzendbericht";
    const mail = maakMail(o, "verzonden");
    await verstuur(mail);
    await logMail(orderId, { soort: "verzonden", aan: mail.aan, onderwerp: mail.onderwerp, automatisch: true });
    return "verstuurd";
  } catch (e) { return "mislukt: " + e.message; }
}

/**
 * De bot meldt de voortgang. Bij "betalen" gaat de betaallink als pushmelding naar de
 * telefoon. Bij "klaar" wordt het label bewaard, komt de volgcode bij de order, gaat de
 * order op Verzonden en krijgt de klant het verzendbericht.
 */
async function meld(invoer) {
  const { orderId, id, status } = invoer || {};
  const job = typeof orderId === "string" ? await lees(orderId) : null;
  if (!job || job.id !== id) { const e = new Error("Deze opdracht bestaat niet meer"); e.status = 409; throw e; }
  if (!LOPEND.includes(job.status)) { const e = new Error("Deze opdracht is al " + job.status); e.status = 409; throw e; }
  if (!["betalen", "klaar", "mislukt", "verlopen", "geannuleerd"].includes(status)) throw new Error("Onbekende status");
  const tekst = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
  const naam = (WINKELS[job.winkel] || {}).naam || job.winkel;
  const wie = [job.ontvanger.voornaam, job.ontvanger.achternaam].filter((x, i, a) => a.indexOf(x) === i).join(" ");
  const bot = { door: "bot" };
  job.status = status;
  let push = null;
  if (status === "betalen") {
    const link = tekst(invoer.betaalUrl, 500);
    if (!/^https:\/\/my\.dhlecommerce\.nl\/payment\//.test(link)) throw new Error("De betaallink is niet van DHL");
    job.betaalUrl = link;
    job.bedrag = Number(invoer.bedrag) || 0;
    push = { bron: naam, titel: "DHL-label betalen " + euro(job.bedrag), tekst: FORMATEN[job.formaat].naam + " voor " + wie + " (" + job.orderId + ")\nTik om te betalen.", url: link, prioriteit: "hoog" };
    await logboek(orderId, "DHL-formulier ingevuld, betaallink van " + euro(job.bedrag) + " naar de telefoon gestuurd", bot);
  } else if (status === "klaar") {
    job.trackTrace = tekst(invoer.trackTrace, 60);
    delete job.betaalUrl;
    // Het label zelf (pdf) bewaren, zodat het altijd vanuit de order te openen en te printen is.
    try { job.heeftPdf = await bewaarPdf(orderId, job.id, invoer.labelPdf); } catch (e) { job.heeftPdf = false; }
    if (job.heeftPdf) job.pdfId = job.id;
    await logboek(orderId, "DHL-label betaald en gemaakt (" + omschrijving(job) + ", " + euro(job.bedrag) + ")" + (job.trackTrace ? ", volgcode " + job.trackTrace : ", volgcode niet gevonden"), { ...bot, ...(job.heeftPdf ? { pdf: job.id } : {}) });
    if (job.trackTrace) {
      await pasAan(orderId, { trackTrace: job.trackTrace, verzendstatus: "verzonden" });
      await logboek(orderId, "Volgcode " + job.trackTrace + " ingevuld en status op Verzonden gezet", { door: "automatisch" });
      job.klantMail = await mailKlant(orderId);
      if (job.klantMail !== "verstuurd") await logboek(orderId, "Verzendbericht niet automatisch verstuurd: " + job.klantMail, { door: "automatisch" });
    } else {
      job.klantMail = "geen volgcode";
      await logboek(orderId, "Geen volgcode gevonden: status en verzendbericht moeten met de hand", { door: "automatisch" });
    }
    push = { bron: naam, titel: "DHL-label is klaar", tekst: wie + " (" + job.orderId + ")" + (job.trackTrace ? "\nVolgcode " + job.trackTrace : "\nVolgcode niet gevonden: vul hem zelf in.") + (job.klantMail === "verstuurd" ? "\nDe klant heeft het verzendbericht gekregen." : "\nDe klant is nog niet gemaild.") };
  } else {
    job.fout = tekst(invoer.fout, 300);
    delete job.betaalUrl;
    await logboek(orderId, status === "mislukt" ? "DHL-label mislukt: " + (job.fout || "onbekende fout") : status === "verlopen" ? "DHL-label verlopen: er is niet betaald" : "DHL-label gestopt", bot);
    if (status === "mislukt") push = { bron: naam, titel: "DHL-label mislukt", tekst: wie + " (" + job.orderId + ")\n" + (job.fout || "Onbekende fout") };
  }
  if (push) { try { job.push = await seintje.stuurMelding(push); } catch (e) { job.push = false; job.pushFout = e.message; } }
  return publiek(await bewaar(job));
}

module.exports = { FORMATEN, BEZORGING, LOPEND, labelsAan, isBot, splitsHuisnummer, ontvanger, metVerloop, publiek, alle, lees, vraagAan, annuleer, voorBot, meld, bewaarPdf, leesPdf, mailKlant, vraagPrint, leesPrint, meldPrint };
