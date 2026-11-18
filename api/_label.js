// DHL-verzendlabels. De CRM maakt zelf geen label: hij legt een opdracht klaar
// (hash `crm:labels`, één per order) en de bot op de pc in de werkplaats pakt die op.
// De bot vult het formulier van DHL in tot aan de betaling en meldt de betaallink
// terug; die gaat als pushmelding (Seintje) naar de telefoon. Na het betalen zet de
// bot de volgcode bij de order.
//
//   LABEL_BOT_SLEUTEL   geheime sleutel waarmee de bot zich meldt (minstens 24 tekens);
//                       zonder staat het maken van labels uit
const crypto = require("node:crypto");
const { kv, opslagAan, pasAan, winkelVan, WINKELS } = require("./_lib");
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

async function alle() {
  if (!opslagAan()) return {};
  const plat = (await kv("HGETALL", "crm:labels")) || [];
  const uit = {};
  for (let i = 0; i < plat.length; i += 2) { const j = publiek(leesJob(plat[i + 1])); if (j) uit[plat[i]] = j; }
  return uit;
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
  return publiek(await bewaar({
    id: crypto.randomUUID(), orderId: o.id, winkel: winkelVan(o), formaat, bezorging,
    nietBijBuren: bezorging === "deur" && !!(invoer && invoer.nietBijBuren),
    status: "wacht", aangemaakt: new Date().toISOString(), ontvanger: naar
  }));
}

async function annuleer(orderId) {
  const job = await lees(orderId);
  if (!job || !LOPEND.includes(job.status)) return publiek(job);
  job.status = "geannuleerd";
  return publiek(await bewaar(job));
}

/**
 * Voor de bot: nieuwe opdrachten (die meteen op "bezig" gaan, zodat ze maar één keer
 * worden opgepakt) en de opdrachten die nog op een betaling wachten.
 */
async function voorBot() {
  const plat = (await kv("HGETALL", "crm:labels")) || [];
  const opdrachten = [], wachtOpBetaling = [];
  for (let i = 0; i < plat.length; i += 2) {
    const job = leesJob(plat[i + 1]);
    if (!job) continue;
    if (job.status === "wacht") {
      job.status = "bezig";
      await bewaar(job);
      opdrachten.push({ id: job.id, orderId: job.orderId, winkel: job.winkel, formaat: job.formaat, bezorging: job.bezorging, nietBijBuren: !!job.nietBijBuren, ontvanger: job.ontvanger });
    } else if (metVerloop(job).status === "betalen") wachtOpBetaling.push(job.id);
  }
  return { opdrachten, wachtOpBetaling };
}

function euro(n) { return "€ " + (Number(n) || 0).toFixed(2).replace(".", ","); }

/**
 * De bot meldt de voortgang. Bij "betalen" gaat de betaallink als pushmelding naar de
 * telefoon; bij "klaar" komt de volgcode bij de order te staan.
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
  job.status = status;
  let push = null;
  if (status === "betalen") {
    const link = tekst(invoer.betaalUrl, 500);
    if (!/^https:\/\/my\.dhlecommerce\.nl\/payment\//.test(link)) throw new Error("De betaallink is niet van DHL");
    job.betaalUrl = link;
    job.bedrag = Number(invoer.bedrag) || 0;
    push = { bron: naam, titel: "DHL-label betalen " + euro(job.bedrag), tekst: FORMATEN[job.formaat].naam + " voor " + wie + " (" + job.orderId + ")\nTik om te betalen.", url: link, prioriteit: "hoog" };
  } else if (status === "klaar") {
    job.trackTrace = tekst(invoer.trackTrace, 60);
    delete job.betaalUrl;
    if (job.trackTrace) await pasAan(job.orderId, { trackTrace: job.trackTrace });
    push = { bron: naam, titel: "DHL-label is klaar", tekst: wie + " (" + job.orderId + ")" + (job.trackTrace ? "\nVolgcode " + job.trackTrace : "\nHet label staat in je mail.") };
  } else {
    job.fout = tekst(invoer.fout, 300);
    delete job.betaalUrl;
    if (status === "mislukt") push = { bron: naam, titel: "DHL-label mislukt", tekst: wie + " (" + job.orderId + ")\n" + (job.fout || "Onbekende fout") };
  }
  if (push) { try { job.push = await seintje.stuurMelding(push); } catch (e) { job.push = false; job.pushFout = e.message; } }
  return publiek(await bewaar(job));
}

module.exports = { FORMATEN, BEZORGING, LOPEND, labelsAan, isBot, splitsHuisnummer, ontvanger, metVerloop, publiek, alle, lees, vraagAan, annuleer, voorBot, meld };
