// Gedeelde code voor de CRM van fatbikehulp.nl, deskna.nl en fatbiketeile.de.
//
// Bestellingen komen uit de webshops zelf:
//  - Fatbikehulp: de opslag van de site (sleutel `orders`), of BRON_URL.
//  - Deskna: de opslag van de Deskna-webshop (sleutels `order:<id>`), alleen
//    met het alleen-lezen-token.
//  - Archief: de orders uit het oude CRM (apr–okt 2026, alle drie de winkels),
//    in data/archief.json (gemaakt met scripts/archief-maken.js, gaat mee in de
//    deploy, staat niet in git). Staat een order ook in een webshop, dan telt
//    de webshop en komen de gegevens uit het oude CRM erbij.
// De CRM schrijft nooit in een webshop: alles wat je hier bewerkt staat als
// "wijziging per order" in de eigen opslag van de CRM en wordt bij het tonen
// over de order uit de site heen gelegd. Een webshop kan dus niet stuk door
// iets wat hier gebeurt.
//
//   CRM_WACHTWOORD    wachtwoord om in te loggen
//   CRM_GEHEIM        sleutel waarmee de inlogcookie is ondertekend
//   KV_REST_API_URL / KV_REST_API_TOKEN   eigen opslag (Upstash Redis)
//   MAIL_VAN          afzender, standaard "Fatbikehulp <info@fatbikehulp.nl>"
//   MAIL_WACHTWOORD   verzamelwachtwoord (catch-all) van het domein in Forward Email; zonder staat mailen uit
//   MAIL_GEBRUIKER    optioneel: andere inlognaam dan *@domein, bv. een alias met eigen wachtwoord
//   MAIL_MELDINGEN    optioneel: adres dat een melding krijgt bij een nieuwe bestelling
//   DESKNA_KV_REST_API_URL / DESKNA_KV_REST_API_READ_ONLY_TOKEN   opslag van de Deskna-webshop (alleen lezen)
//   DESKNA_MAIL_WACHTWOORD   verzamelwachtwoord van deskna.nl in Forward Email; zonder staat mailen voor Deskna uit
//   DESKNA_MAIL_VAN          afzender voor Deskna, standaard "Deskna <info@deskna.nl>"
//   DESKNA_AUTO_BEVESTIGING  "1" = ook Deskna-klanten automatisch een bevestiging sturen (standaard uit)
//   FATBIKETEILE_MAIL_VAN    afzender voor Fatbiketeile, standaard "Fatbiketeile.de <info@fatbikehulp.nl>"
//   FATBIKETEILE_MAIL_WACHTWOORD  alleen nodig bij een afzender buiten fatbikehulp.nl (anders telt MAIL_WACHTWOORD)
//   FORWARDEMAIL_API_SLEUTEL  API-sleutel van het Forward Email-account (alle domeinen); daarmee mailt elke
//                     winkel die geen eigen wachtwoord heeft, vanaf zijn eigen afzender
//   CRON_SECRET       door Vercel meegestuurd bij de automatische controle

const crypto = require("node:crypto");

const BRON_URL = process.env.BRON_URL || "https://www.fatbikehulp.nl/api/web-orders";
const DAG = 24 * 60 * 60 * 1000;

// ---------- opslag ----------
function kvUrl() { return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || ""; }
function kvToken() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""; }
function opslagAan() { return !!(kvUrl() && kvToken()); }

async function roep(url, token, cmd) {
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error("Opslag: " + ((j && j.error) || r.status));
  return j.result;
}

async function kv(...cmd) {
  if (!opslagAan()) throw new Error("De opslag van de CRM is nog niet gekoppeld");
  return roep(kvUrl(), kvToken(), cmd);
}

// Opslag van de Deskna-webshop. Bewust alleen het alleen-lezen-token: de CRM
// kan daar dus technisch niets in wijzigen.
function desknaUrl() { return process.env.DESKNA_KV_REST_API_URL || ""; }
function desknaToken() { return process.env.DESKNA_KV_REST_API_READ_ONLY_TOKEN || ""; }
function desknaAan() { return !!(desknaUrl() && desknaToken()); }
async function desknaKv(...cmd) {
  if (!desknaAan()) throw new Error("De opslag van Deskna is niet gekoppeld");
  return roep(desknaUrl(), desknaToken(), cmd);
}

async function alleWijzigingen() {
  if (!opslagAan()) return {};
  const plat = (await kv("HGETALL", "crm:orders")) || [];
  const uit = {};
  for (let i = 0; i < plat.length; i += 2) {
    try { uit[plat[i]] = JSON.parse(plat[i + 1]); } catch (e) { /* kapotte regel overslaan */ }
  }
  return uit;
}
async function wijziging(id) {
  const v = await kv("HGET", "crm:orders", id);
  try { return v ? JSON.parse(v) : {}; } catch (e) { return {}; }
}
async function bewaarWijziging(id, w) { await kv("HSET", "crm:orders", id, JSON.stringify(w)); }

// ---------- bestellingen ----------
async function bronOrders() {
  let j = null;
  // Eerst rechtstreeks uit de opslag van de site (alleen lezen), anders via de order-API van de site.
  if (opslagAan() && !process.env.BRON_URL) {
    try {
      const v = await kv("GET", "orders");
      const p = typeof v === "string" ? JSON.parse(v) : v;
      if (Array.isArray(p)) j = p;
    } catch (e) { j = null; }
  }
  if (!j) {
    const r = await fetch(BRON_URL, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error("De site gaf " + r.status + " bij het ophalen van de bestellingen");
    j = await r.json();
    if (!Array.isArray(j)) throw new Error("De site gaf geen lijst met bestellingen terug");
  }
  return j.filter((o) => o && typeof o.id === "string");
}

// ---------- Deskna ----------
// Statussen van de Deskna-webshop die een bevestigde bestelling betekenen:
// betaald, aanbetaald (rest bij levering) of volledig betalen bij levering.
const DESKNA_BEVESTIGD = ["paid", "deposit_paid", "on_delivery"];

function desknaItemNaam(li) {
  const opties = (li.selectedOptions || []).filter((x) => x && x.value && x.value !== "Default Title").map((x) => x.value);
  const variant = opties.length ? opties.join(" / ") : (li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : "");
  return variant ? li.productName + " (" + variant + ")" : String(li.productName || "");
}

/**
 * Zet een order uit de Deskna-webshop om naar de vorm die de CRM gebruikt.
 * start = het moment waarop Deskna aan de CRM is gekoppeld: bestellingen van
 * daarvoor zijn al afgehandeld en komen dus niet in "Te verzenden".
 */
function vanDeskna(d, start) {
  const s = d.shippingInfo || {};
  const bevestigd = DESKNA_BEVESTIGD.includes(d.status);
  const openBijLevering = d.status === "deposit_paid" || d.status === "on_delivery" ? Number(d.amountDueOnDelivery) || 0 : 0;
  const gemaakt = Date.parse(d.createdAt || "");
  const uit = {
    id: d.id,
    winkel: "deskna",
    customerName: [s.firstName, s.lastName].filter(Boolean).join(" ").trim(),
    customerEmail: s.email || "",
    customerPhone: s.phone || "",
    amount: Number(d.total) || 0,
    shippingCost: Number(d.shipping) || 0,
    status: d.status,
    paid: bevestigd,
    siteStatus: d.status,
    paymentMethod: d.paymentMethod || "",
    betaalmoment: d.paymentPlan || "full",
    aanbetaald: d.status === "deposit_paid" ? Number(d.amountDueNow) || 0 : 0,
    openBijLevering,
    createdAt: d.createdAt,
    // Bij betalen bij levering is er geen betaalmoment; dan telt het bestelmoment.
    paidAt: d.paidAt || d.depositPaidAt || (d.status === "on_delivery" ? d.createdAt : undefined),
    items: (d.lineItems || []).map((li) => ({ name: desknaItemNaam(li), quantity: li.quantity, price: li.unitPrice })),
    shippingAddress: { street: s.address || "", houseNumber: "", postalCode: s.zipCode || "", city: s.city || "", country: s.country || "" }
  };
  // Betaal-ID van Mollie of Stripe: daarmee wordt dezelfde order in het archief herkend.
  const betaalId = d.paymentId || d.stripeSessionId;
  if (betaalId) uit.paymentId = betaalId;
  if (bevestigd && start && gemaakt && gemaakt < start) { uit.fulfillmentStatus = "afgeleverd"; uit.afgeleverdAangenomen = true; }
  return uit;
}

function leesJson(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

/** Moment waarop Deskna aan de CRM is gekoppeld (wordt de eerste keer vastgelegd). */
async function desknaStart() {
  if (!opslagAan()) return 0;
  await kv("SETNX", "crm:deskna:start", new Date().toISOString());
  return Date.parse(await kv("GET", "crm:deskna:start")) || 0;
}

async function desknaOrders() {
  if (!desknaAan()) return [];
  const start = await desknaStart();
  const sleutels = [];
  let cursor = "0";
  for (let i = 0; i < 60; i++) {
    const [volgende, deel] = await desknaKv("SCAN", cursor, "MATCH", "order:*", "COUNT", 1000);
    sleutels.push(...(deel || []));
    cursor = String(volgende);
    if (cursor === "0") break;
  }
  const uit = [];
  for (let i = 0; i < sleutels.length; i += 200) {
    const waarden = await desknaKv("MGET", ...sleutels.slice(i, i + 200));
    for (const v of waarden || []) {
      const d = leesJson(v);
      if (d && typeof d.id === "string" && d.shippingInfo) uit.push(vanDeskna(d, start));
    }
  }
  return uit;
}

async function desknaOrder(id) {
  if (!desknaAan()) return null;
  const d = leesJson(await desknaKv("GET", "order:" + id));
  return d && typeof d.id === "string" ? vanDeskna(d, await desknaStart()) : null;
}

// ---------- archief (oude CRM) ----------
let archiefCache = null;
let archiefFout = "";
/** Orders uit het oude CRM. Alleen lezen: wijzigingen gaan, net als bij de webshops, naar `crm:orders`. */
function archief() {
  if (archiefCache) return archiefCache;
  try {
    const j = process.env.CRM_ARCHIEF_BESTAND
      ? JSON.parse(require("node:fs").readFileSync(process.env.CRM_ARCHIEF_BESTAND, "utf8"))
      : require("../data/archief.json");
    archiefCache = Array.isArray(j && j.orders) ? j.orders : [];
  } catch (e) {
    archiefCache = [];
    archiefFout = e.code === "MODULE_NOT_FOUND" || e.code === "ENOENT" ? "het bestand data/archief.json zit niet in deze deploy" : e.message;
  }
  return archiefCache;
}
const isArchiefId = (id) => /^#\d+$/.test(id);

function betaalIds(o) {
  return [o.stripeSessionId, o.stripePaymentIntentId, o.paymentId, o.molliePaymentId].filter((x) => typeof x === "string" && x);
}
// Voor handmatige orders uit het oude CRM (zonder Stripe-betaling): zelfde winkel, klant, bedrag en rond dezelfde dag.
function zelfdeBestelling(o, a) {
  const mail = String(a.customerEmail || "").trim().toLowerCase();
  return !!mail && winkelVan(o) === a.winkel && String(o.customerEmail || "").trim().toLowerCase() === mail &&
    Math.abs((Number(o.amount) || 0) - a.amount) < 0.01 &&
    Math.abs((Date.parse(o.createdAt || "") || 0) - Date.parse(a.createdAt)) <= 3 * DAG;
}
/** Zet de gegevens uit het oude CRM bij een webshoporder die ook in het archief staat. */
function verrijk(o, a) {
  o.oudCrm = { ...a.oudCrm, id: a.id };
  if (!o.trackTrace && a.trackTrace) { o.trackTrace = a.trackTrace; o.volgCode = a.volgCode; }
  if (a.volgUrl && !o.volgUrl && o.trackTrace === a.volgCode) o.volgUrl = a.volgUrl;
  // De webshop weet niet wat er na de betaling gebeurde; het oude CRM wel. Alleen
  // overnemen als de webshopstatus zelf een aanname was en die van het archief niet.
  if ((!o.fulfillmentStatus || o.afgeleverdAangenomen) && !a.oudCrm.aangenomen) {
    o.fulfillmentStatus = a.fulfillmentStatus;
    delete o.afgeleverdAangenomen;
  }
}
/**
 * Legt het archief naast de orders uit de webshops (die worden aangevuld).
 * Geeft de archieforders terug die niet in een webshop staan. Elke webshoporder
 * hoort bij hooguit één archieforder.
 */
function koppelArchief(live, arch) {
  const perId = new Map();
  for (const o of live) for (const id of betaalIds(o)) perId.set(id, o);
  const gebruikt = new Set();
  const los = [];
  let gekoppeld = 0;
  for (const a of arch) {
    let m = betaalIds(a).map((id) => perId.get(id)).find((o) => o && !gebruikt.has(o));
    if (!m && a.oudCrm && a.oudCrm.handmatig) m = live.find((o) => !gebruikt.has(o) && zelfdeBestelling(o, a));
    if (!m) { los.push(a); continue; }
    gebruikt.add(m);
    verrijk(m, a);
    gekoppeld++;
  }
  return { los, gekoppeld };
}

function isBetaald(o) { return o.paid === true || o.status === "betaald" || o.status === "paid"; }

/** Order uit de site met de CRM-wijziging eroverheen. */
function samengevoegd(o, w) {
  w = w || {};
  const uit = { ...o };
  for (const k of BEWERKBAAR) if (k !== "shippingAddress" && w[k] !== undefined) uit[k] = w[k];
  if (w.shippingAddress) uit.shippingAddress = { ...(o.shippingAddress || {}), ...w.shippingAddress };
  uit.winkel = winkelVan(o);
  uit.betaald = isBetaald(o);
  uit.mails = w.mails || [];
  uit.bewerktOp = w.bewerktOp || null;
  return uit;
}

/**
 * Alle bestellingen van alle winkels, nieuwste eerst. Valt één winkel uit,
 * dan komen de andere gewoon door en staat de storing in `meldingen`.
 */
async function alleOrdersMetMeldingen() {
  const meldingen = [];
  const mislukt = new Set();
  const veilig = (winkel, naam, belofte) => belofte.catch((e) => { mislukt.add(winkel); meldingen.push(naam + " kon niet worden opgehaald: " + e.message); return []; });
  const [fatbike, deskna, w] = await Promise.all([
    veilig("fatbikehulp", "Fatbikehulp", bronOrders()),
    veilig("deskna", "Deskna", desknaOrders()),
    alleWijzigingen()
  ]);
  const live = [...fatbike, ...deskna];
  // Zonder de webshop valt niet te zien welke archieforders dubbel zijn: die winkel dan even zonder archief.
  const arch = archief().filter((a) => !mislukt.has(a.winkel));
  if (archiefFout) meldingen.push("Het archief van het oude CRM kon niet worden geladen: " + archiefFout);
  const { los, gekoppeld } = koppelArchief(live, arch);
  const orders = [...live, ...los].map((o) => samengevoegd(o, w[o.id]));
  orders.sort((a, b) => (Date.parse(b.createdAt || "") || 0) - (Date.parse(a.createdAt || "") || 0));
  return { orders, meldingen, archief: { totaal: arch.length, los: los.length, gekoppeld } };
}
async function alleOrders() { return (await alleOrdersMetMeldingen()).orders; }

async function eenOrder(id) {
  if (isArchiefId(id)) {
    const a = archief().find((x) => x.id === id);
    return a ? samengevoegd(a, await wijziging(id)) : null;
  }
  // Deskna-orders zijn te herkennen aan hun nummer en worden rechtstreeks opgehaald.
  const o = /^DESKNA-/.test(id) ? await desknaOrder(id) : (await bronOrders()).find((x) => x.id === id);
  if (!o) return null;
  koppelArchief([o], archief());
  return samengevoegd(o, await wijziging(id));
}

const BEWERKBAAR = ["verzendstatus", "trackTrace", "notitie", "customerName", "customerEmail", "customerPhone", "shippingAddress", "verborgen"];
const VERZENDSTATUSSEN = ["nieuw", "verwerkt", "verzonden", "afgeleverd", "geannuleerd"];
const ADRESVELDEN = ["street", "houseNumber", "postalCode", "city", "country"];
const EMAIL_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/i;
function geldigAdres(a) { return typeof a === "string" && a.length <= 200 && EMAIL_RE.test(a); }

/** Alleen toegestane velden, opgeschoond. Gooit een fout met een leesbare melding. */
function schoon(invoer) {
  const uit = {};
  const tekst = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
  if (!invoer || typeof invoer !== "object") throw new Error("Geen wijzigingen meegestuurd");
  if ("verzendstatus" in invoer) {
    if (!VERZENDSTATUSSEN.includes(invoer.verzendstatus)) throw new Error("Onbekende status");
    uit.verzendstatus = invoer.verzendstatus;
  }
  if ("trackTrace" in invoer) uit.trackTrace = tekst(invoer.trackTrace, 300);
  if ("notitie" in invoer) uit.notitie = tekst(invoer.notitie, 4000);
  if ("customerName" in invoer) uit.customerName = tekst(invoer.customerName, 200);
  if ("customerPhone" in invoer) uit.customerPhone = tekst(invoer.customerPhone, 40);
  if ("customerEmail" in invoer) {
    const e = tekst(invoer.customerEmail, 200);
    if (!geldigAdres(e)) throw new Error("Dat e-mailadres klopt niet");
    uit.customerEmail = e;
  }
  if ("verborgen" in invoer) uit.verborgen = !!invoer.verborgen;
  if (invoer.shippingAddress && typeof invoer.shippingAddress === "object") {
    uit.shippingAddress = {};
    for (const k of ADRESVELDEN) if (k in invoer.shippingAddress) uit.shippingAddress[k] = tekst(invoer.shippingAddress[k], 200);
  }
  return uit;
}

async function pasAan(id, invoer) {
  const nieuw = schoon(invoer);
  const w = await wijziging(id);
  if (nieuw.shippingAddress) nieuw.shippingAddress = { ...(w.shippingAddress || {}), ...nieuw.shippingAddress };
  const samen = { ...w, ...nieuw, bewerktOp: new Date().toISOString() };
  await bewaarWijziging(id, samen);
  return samen;
}

const MAILNAAM = { bevestiging: "Bevestiging", verzonden: "Verzendbericht", vrij: "Eigen bericht" };
async function logMail(id, regel) {
  const w = await wijziging(id);
  w.mails = [...(w.mails || []), { ...regel, tijd: new Date().toISOString() }].slice(-50);
  await bewaarWijziging(id, w);
  // Bij een verzendbericht staat in het logboek of er een volgcode in de mail stond.
  const metCode = regel.soort === "verzonden" && typeof regel.volgcode === "string" ? (regel.volgcode ? ", met volgcode " + regel.volgcode : ", zonder volgcode") : "";
  await logboek(id, (MAILNAAM[regel.soort] || "Mail") + " gemaild naar " + regel.aan + (regel.onderwerp && regel.soort === "vrij" ? " (" + regel.onderwerp + ")" : "") + metCode, { door: regel.automatisch ? "automatisch" : "jij" });
}

// ---------- logboek ----------
// Alles wat er met een order gebeurt komt als regel in de lijst `crm:log:<order>` en
// blijft daar staan: er wordt alleen bijgeschreven, nooit iets gewist of overschreven.
// Het logboek mag een actie nooit laten mislukken, dus fouten worden hier opgevangen.
async function logboek(id, tekst, extra) {
  try { await kv("RPUSH", "crm:log:" + id, JSON.stringify({ tijd: new Date().toISOString(), tekst: String(tekst).slice(0, 500), door: "jij", ...(extra || {}) })); }
  catch (e) { console.log("logboek: schrijven mislukt voor " + id + ": " + e.message); }
}
async function leesLog(id) {
  if (!opslagAan()) return [];
  const regels = (await kv("LRANGE", "crm:log:" + id, 0, -1)) || [];
  return regels.map((r) => { try { return typeof r === "string" ? JSON.parse(r) : r; } catch (e) { return null; } }).filter(Boolean);
}
const VELDNAAM = { verzendstatus: "Status", trackTrace: "Volgcode", customerName: "Naam", customerEmail: "E-mail", customerPhone: "Telefoon", street: "Straat", houseNumber: "Huisnummer", postalCode: "Postcode", city: "Plaats", country: "Land" };
const STATUSNAAM = { open: "Niet betaald", nieuw: "Te verzenden", verwerkt: "Verwerkt", verzonden: "Verzonden", afgeleverd: "Afgeleverd", geannuleerd: "Geannuleerd" };
/** Wat er tussen twee versies van een order is veranderd, als leesbare regels ("Status: Te verzenden → Verzonden"). */
function verschillen(voor, na) {
  const uit = [];
  const toon = (k, v) => (k === "verzendstatus" ? STATUSNAAM[v] || "" : String(v == null ? "" : v).trim()) || "leeg";
  const vergelijk = (k, a, b) => { if (String(a == null ? "" : a).trim() !== String(b == null ? "" : b).trim()) uit.push(VELDNAAM[k] + ": " + toon(k, a) + " → " + toon(k, b)); };
  // De status zoals het scherm hem toont: zonder eigen keuze is dat de status die uit de webshop volgt.
  const status = (o) => o.verzendstatus || (!o.betaald ? "open" : ["verzonden", "afgeleverd", "verwerkt", "geannuleerd"].includes(o.fulfillmentStatus) ? o.fulfillmentStatus : "nieuw");
  if (status(voor) !== status(na)) uit.push("Status: " + (STATUSNAAM[status(voor)] || status(voor)) + " → " + (STATUSNAAM[status(na)] || status(na)));
  for (const k of ["trackTrace", "customerName", "customerEmail", "customerPhone"]) vergelijk(k, voor[k], na[k]);
  for (const k of ADRESVELDEN) vergelijk(k, (voor.shippingAddress || {})[k], (na.shippingAddress || {})[k]);
  if (String(voor.notitie || "").trim() !== String(na.notitie || "").trim()) uit.push("Notitie aangepast");
  if (!!voor.verborgen !== !!na.verborgen) uit.push(na.verborgen ? "Verborgen uit de lijst" : "Teruggezet in de lijst");
  return uit;
}

// ---------- inloggen ----------
function geheim() { return process.env.CRM_GEHEIM || ""; }
function teken(s) { return crypto.createHmac("sha256", geheim()).update(s).digest("base64url"); }
function gelijk(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function wachtwoordKlopt(w) {
  const echt = process.env.CRM_WACHTWOORD || "";
  return !!echt && !!geheim() && typeof w === "string" && gelijk(w, echt);
}
function maakCookie() {
  const tot = String(Date.now() + 30 * DAG);
  return "crm=" + tot + "." + teken(tot) + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + 30 * 24 * 3600;
}
function ingelogd(req) {
  if (!geheim()) return false;
  const m = /(?:^|;\s*)crm=(\d+)\.([\w-]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  return Number(m[1]) > Date.now() && gelijk(m[2], teken(m[1]));
}
/** true als het verzoek door mag; anders is er al geantwoord. */
function bewaak(req, res) {
  if (ingelogd(req)) return true;
  res.status(401).json({ fout: "Niet ingelogd" });
  return false;
}

// ---------- winkels ----------
// Elke winkel mailt vanaf zijn eigen adres, met zijn eigen naam en kleur. Een
// Deskna-klant krijgt dus nooit een mail van Fatbikehulp of andersom.
const domeinVan = (van) => kaalAdres(van).split("@")[1] || "";
const fatbiketeileVan = () => process.env.FATBIKETEILE_MAIL_VAN || "Fatbiketeile.de <info@fatbikehulp.nl>";
// Fatbiketeile mailde altijd al vanaf fatbikehulp.nl; dan werkt het verzamelwachtwoord van dat domein.
const zelfdeDomeinAlsFatbikehulp = () => domeinVan(fatbiketeileVan()) === domeinVan(process.env.MAIL_VAN || "Fatbikehulp <info@fatbikehulp.nl>");
const WINKELS = {
  fatbikehulp: {
    naam: "Fatbikehulp", site: "https://www.fatbikehulp.nl", kleur: "#234C6A",
    van: () => process.env.MAIL_VAN || "Fatbikehulp <info@fatbikehulp.nl>",
    wachtwoord: () => process.env.MAIL_WACHTWOORD || "",
    gebruiker: () => process.env.MAIL_GEBRUIKER || "",
    autoBevestiging: () => true
  },
  deskna: {
    naam: "Deskna", site: "https://www.deskna.nl", kleur: "#111111",
    van: () => process.env.DESKNA_MAIL_VAN || "Deskna <info@deskna.nl>",
    wachtwoord: () => process.env.DESKNA_MAIL_WACHTWOORD || "",
    gebruiker: () => process.env.DESKNA_MAIL_GEBRUIKER || "",
    // Standaard uit: pas aanzetten als vaststaat dat de webshop zelf geen bevestiging stuurt.
    autoBevestiging: () => process.env.DESKNA_AUTO_BEVESTIGING === "1"
  },
  fatbiketeile: {
    naam: "Fatbiketeile", site: "https://www.fatbiketeile.de", kleur: "#234C6A", taal: "de",
    van: fatbiketeileVan,
    wachtwoord: () => process.env.FATBIKETEILE_MAIL_WACHTWOORD || (zelfdeDomeinAlsFatbikehulp() ? process.env.MAIL_WACHTWOORD || "" : ""),
    gebruiker: () => process.env.FATBIKETEILE_MAIL_GEBRUIKER || (zelfdeDomeinAlsFatbikehulp() ? process.env.MAIL_GEBRUIKER || "" : ""),
    // Er komen (nog) geen nieuwe Fatbiketeile-orders binnen, alleen het archief.
    autoBevestiging: () => false
  }
};
/** Winkel van een order; orders zonder winkel zijn van Fatbikehulp. */
function winkelVan(o) { return o && WINKELS[o.winkel] ? o.winkel : "fatbikehulp"; }
function gekoppeld(k) {
  if (k === "deskna") return desknaAan();
  if (k === "fatbiketeile") return archief().some((o) => o.winkel === k);
  return true;
}
function winkelInfo() {
  const uit = {};
  for (const [k, w] of Object.entries(WINKELS)) {
    uit[k] = { naam: w.naam, mailAan: mailAan(k), afzender: kaalAdres(w.van()), autoBevestiging: w.autoBevestiging(), gekoppeld: gekoppeld(k) };
  }
  return uit;
}

// ---------- mail ----------
const MAIL_API = "https://api.forwardemail.net/v1/emails";
function mailVan(winkel) { return WINKELS[WINKELS[winkel] ? winkel : "fatbikehulp"].van(); }
function kaalAdres(van) {
  const m = /<([^>]+)>\s*$/.exec(van);
  return (m ? m[1] : van).trim();
}
function apiSleutel() { return process.env.FORWARDEMAIL_API_SLEUTEL || ""; }
function mailAan(winkel) {
  const w = WINKELS[WINKELS[winkel] ? winkel : "fatbikehulp"];
  return (!!w.wachtwoord() || !!apiSleutel()) && geldigAdres(kaalAdres(w.van()));
}

/**
 * Inloggen bij Forward Email. Heeft de winkel een eigen wachtwoord, dan dat (standaard het
 * verzamelwachtwoord van het domein, gebruiker *@domein); anders de API-sleutel van het account
 * (gebruiker = sleutel, leeg wachtwoord).
 */
function mailInlog(w) {
  if (w.wachtwoord()) return (w.gebruiker() || "*@" + kaalAdres(w.van()).split("@")[1]) + ":" + w.wachtwoord();
  return apiSleutel() + ":";
}

async function verstuur({ aan, onderwerp, tekst, html, winkel }) {
  const w = WINKELS[WINKELS[winkel] ? winkel : "fatbikehulp"];
  if (!mailAan(winkel)) throw new Error("Mailen staat voor " + w.naam + " nog uit: er is geen wachtwoord of API-sleutel van Forward Email");
  if (!geldigAdres(aan)) throw new Error("Het e-mailadres van de klant klopt niet");
  const r = await fetch(MAIL_API, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(mailInlog(w)).toString("base64"),
      "Content-Type": "application/json", Accept: "application/json"
    },
    body: JSON.stringify({ from: w.van(), to: aan, subject: onderwerp, text: tekst, html }),
    signal: AbortSignal.timeout(10000)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && (j.message || j.error)) || "Forward Email gaf " + r.status);
  return { id: (j && j.id) || "" };
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function euro(n) { return "€ " + (Number(n) || 0).toFixed(2).replace(".", ","); }
// Vaste woorden in de mail, per taal van de winkel.
const WOORDEN = {
  nl: { bestelling: "Bestelling", verzending: "Verzending", totaal: "Totaal", bijLevering: "Te betalen bij levering", afhaalpunt: "Afhaalpunt",
    groet: "Met vriendelijke groet,", hoi: "Hoi", klant: "klant", volgcode: "Volgcode" },
  de: { bestelling: "Bestellung", verzending: "Versand", totaal: "Gesamt", bijLevering: "Bei Lieferung zu zahlen", afhaalpunt: "Abholstelle",
    groet: "Viele Grüße", hoi: "Hallo", klant: "", volgcode: "Sendungsnummer" }
};
function woorden(o) { return WOORDEN[WINKELS[winkelVan(o)].taal || "nl"]; }
function voornaam(o) { return String(o.customerName || "").trim().split(/\s+/)[0] || woorden(o).klant; }
function adresRegels(o) {
  const a = o.shippingAddress || {};
  if (o.parcelShop && o.parcelShop.name) {
    const p = o.parcelShop.address || {};
    return [woorden(o).afhaalpunt + ": " + o.parcelShop.name, [p.street, p.number].filter(Boolean).join(" "), [p.zipCode, p.city].filter(Boolean).join(" ")].filter(Boolean);
  }
  return [a.streetAndNumber || [a.street, a.houseNumber].filter(Boolean).join(" "), [a.postalCode, a.city].filter(Boolean).join(" ")].filter(Boolean);
}
function volgLink(o) {
  const c = String(o.trackTrace || "").trim();
  if (!c) return "";
  if (/^https?:\/\//i.test(c)) return c;
  // Volgcode uit het oude CRM: daar hoort de volglink bij die toen is gemaakt (DHL of UPS).
  if (o.volgUrl && c === o.volgCode && /^https:\/\//i.test(o.volgUrl)) return o.volgUrl;
  // Fatbikehulp verstuurt altijd met DHL; bij de andere winkels alleen een herkenbare DHL-code
  // (bv. van een label uit de CRM), anders telt daar alleen een volledige link.
  if (winkelVan(o) !== "fatbikehulp" && !/^(JVGL|JJD|3S)[A-Z0-9]{8,}$/i.test(c)) return "";
  const pc = String((o.shippingAddress || {}).postalCode || "").replace(/\s/g, "").toUpperCase();
  return "https://my.dhlecommerce.nl/home/tracktrace/" + encodeURIComponent(c) + (pc ? "/" + encodeURIComponent(pc) : "");
}

/**
 * De html van een mail: kop in de kleur van de winkel, de tekst, bij een verzendbericht een
 * kaart met de volgcode en een grote knop, en daaronder de bestelling en het adres.
 * Opgebouwd met tabellen en vaste stijlen per element, want dat is wat mailprogramma's
 * (Outlook, Gmail, Apple Mail) betrouwbaar tonen.
 */
function opmaak(titel, alineas, o, knop, volgcode) {
  const w = WINKELS[winkelVan(o)];
  const t = woorden(o);
  const lettertype = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const cel = "padding:10px 0;border-bottom:1px solid #eceef1;font-size:14px;line-height:1.45;color:#1f2933";
  const regels = (o.items || []).map((i) =>
    '<tr><td style="' + cel + '"><span style="color:#6b7280">' + esc(i.quantity) + " ×</span> " + esc(i.name) + '</td><td style="' + cel + ';text-align:right;white-space:nowrap;padding-left:12px">' + esc(euro((Number(i.price) || 0) * (Number(i.quantity) || 1))) + "</td></tr>").join("");
  const som = (naam, bedrag, vet) => '<tr><td style="padding:8px 0 0;font-size:14px;color:' + (vet ? "#111827;font-weight:700" : "#6b7280") + '">' + esc(naam) + '</td><td style="padding:8px 0 0;font-size:14px;text-align:right;white-space:nowrap;color:' + (vet ? "#111827;font-weight:700" : "#6b7280") + '">' + esc(bedrag) + "</td></tr>";
  // De volgcode staat in de kaart; de losse regel "Volgcode: ..." hoeft er dan niet nog eens te staan.
  const tekst = alineas.filter((a) => !(volgcode && String(a).startsWith(t.volgcode + ":")));
  const knopHtml = (k) => '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:10px;background:' + w.kleur + '"><a href="' + esc(k.url) + '" style="display:inline-block;padding:13px 26px;' + lettertype + ';font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">' + esc(k.tekst) + " &rarr;</a></td></tr></table>";
  const volgKaart = volgcode
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 24px;border:1px solid #e5e7eb;border-radius:14px;background:#fafbfc"><tr><td style="padding:20px 22px">' +
      '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;font-weight:600;margin:0 0 6px">' + esc(t.volgcode) + "</div>" +
      '<div style="font-family:SFMono-Regular,Consolas,\'Liberation Mono\',Menlo,monospace;font-size:19px;font-weight:700;color:#111827;letter-spacing:.02em;word-break:break-all;margin:0' + (knop ? " 0 16px" : "") + '">' + esc(volgcode) + "</div>" +
      (knop ? knopHtml(knop) : "") + "</td></tr></table>"
    : knop ? '<div style="margin:6px 0 24px">' + knopHtml(knop) + "</div>" : "";
  return '<div style="margin:0;padding:28px 12px;background:#f3f4f6;' + lettertype + '">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e7eb">' +
    '<tr><td style="background:' + w.kleur + ';padding:22px 32px;' + lettertype + ';font-size:17px;font-weight:700;letter-spacing:-.01em;color:#ffffff">' + esc(w.naam) + "</td></tr>" +
    '<tr><td style="padding:34px 32px 8px;' + lettertype + ';color:#1f2933">' +
    '<h1 style="margin:0 0 18px;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-.02em;color:#111827">' + esc(titel) + "</h1>" +
    tekst.map((a) => '<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151">' + esc(a).replace(/\n/g, "<br>") + "</p>").join("") +
    volgKaart +
    '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;font-weight:600;margin:8px 0 2px">' + esc(t.bestelling) + " " + esc(o.id) + "</div>" +
    (regels ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">' + regels +
      (o.shippingCost ? som(t.verzending, euro(o.shippingCost)) : "") + som(t.totaal, euro(o.amount), true) +
      (o.openBijLevering > 0 ? som(t.bijLevering, euro(o.openBijLevering)) : "") + "</table>" : "") +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0"><tr><td style="padding:16px 18px;background:#f9fafb;border-radius:12px;font-size:14px;line-height:1.55;color:#4b5563">' + adresRegels(o).map(esc).join("<br>") + "</td></tr></table>" +
    "</td></tr>" +
    '<tr><td style="padding:26px 32px 30px;' + lettertype + ';font-size:14px;line-height:1.6;color:#6b7280">' + esc(t.groet) + '<br><span style="color:#111827;font-weight:600">Team ' + esc(w.naam) + "</span></td></tr>" +
    '<tr><td style="padding:18px 32px;border-top:1px solid #eceef1;background:#fafbfc;' + lettertype + ';font-size:12.5px;color:#9ca3af"><a href="' + esc(w.site) + '" style="color:#6b7280;text-decoration:none;font-weight:600">' + esc(w.site.replace(/^https?:\/\//, "")) + "</a></td></tr>" +
    "</table></div>";
}
function platteTekst(alineas, o, knop) {
  const t = woorden(o);
  const regels = (o.items || []).map((i) => "- " + i.quantity + " x " + i.name);
  return [...alineas, knop ? knop.tekst + ": " + knop.url : "", t.bestelling + " " + o.id, ...regels, t.totaal + ": " + euro(o.amount),
    o.openBijLevering > 0 ? t.bijLevering + ": " + euro(o.openBijLevering) : "", "", ...adresRegels(o), "", t.groet, "Team " + WINKELS[winkelVan(o)].naam].filter((x) => x !== "").join("\n");
}

/** Duitse mail voor Fatbiketeile (je-vorm, net als de Nederlandse mails). */
function maakDuitseMail(o, soort, hoi) {
  if (soort === "bevestiging") {
    return { onderwerp: "Vielen Dank für deine Bestellung " + o.id, titel: "Vielen Dank für deine Bestellung!", knop: null,
      alineas: [hoi, "Wir haben deine Bestellung und deine Zahlung erhalten. Wir machen dein Paket so schnell wie möglich fertig.", "Sobald es unterwegs ist, schicken wir dir eine E-Mail mit der Sendungsnummer."] };
  }
  const link = volgLink(o);
  const alineas = [hoi, "Gute Nachricht: deine Bestellung wurde verschickt."];
  let knop = null;
  if (String(o.trackTrace || "").trim()) alineas.push("Sendungsnummer: " + String(o.trackTrace).trim());
  if (link) knop = { url: link, tekst: "Sendung verfolgen" };
  alineas.push("Hast du eine Frage zu deiner Bestellung? Antworte einfach auf diese E-Mail.");
  return { onderwerp: "Deine Bestellung " + o.id + " ist unterwegs", titel: "Dein Paket ist unterwegs", alineas, knop };
}

/** Maakt de mail voor een order. soort: bevestiging | verzonden | vrij */
function maakMail(o, soort, vrij) {
  const t = woorden(o);
  const naam = voornaam(o);
  const hoi = naam ? t.hoi + " " + naam + "," : t.hoi + ",";
  let onderwerp, titel, alineas, knop = null;
  if (WINKELS[winkelVan(o)].taal === "de" && (soort === "bevestiging" || soort === "verzonden")) {
    ({ onderwerp, titel, alineas, knop } = maakDuitseMail(o, soort, hoi));
  } else if (soort === "bevestiging") {
    onderwerp = "Bedankt voor je bestelling " + o.id;
    titel = "Bedankt voor je bestelling!";
    if (winkelVan(o) === "deskna") {
      // Deskna kent ook aanbetalen en betalen bij levering; de tekst volgt wat er echt betaald is.
      const ontvangen = o.openBijLevering > 0 && o.aanbetaald > 0
        ? "We hebben je bestelling en je aanbetaling van " + euro(o.aanbetaald) + " ontvangen. Het restbedrag van " + euro(o.openBijLevering) + " betaal je bij levering."
        : o.openBijLevering > 0
          ? "We hebben je bestelling ontvangen. Je betaalt " + euro(o.openBijLevering) + " bij levering."
          : "We hebben je bestelling en betaling ontvangen.";
      alineas = [hoi, ontvangen + " We maken je bestelling zo snel mogelijk klaar voor verzending.", "Zodra je bestelling onderweg is, krijg je van ons bericht."];
    } else {
      alineas = [hoi, "We hebben je bestelling en betaling ontvangen. We maken je pakket zo snel mogelijk klaar.", "Zodra het onderweg is, krijg je van ons een mail met de volgcode."];
    }
  } else if (soort === "verzonden") {
    onderwerp = "Je bestelling " + o.id + " is onderweg";
    titel = winkelVan(o) === "deskna" ? "Je bestelling is onderweg" : "Je pakket is onderweg";
    const link = volgLink(o);
    alineas = [hoi, "Goed nieuws: je bestelling is verzonden."];
    if (link) { alineas.push("Volgcode: " + o.trackTrace); knop = { url: link, tekst: "Volg je pakket" }; }
    else if (String(o.trackTrace || "").trim()) alineas.push("Volgcode: " + String(o.trackTrace).trim());
    alineas.push("Heb je een vraag over je bestelling? Beantwoord dan gewoon deze mail.");
  } else if (soort === "vrij") {
    onderwerp = String((vrij && vrij.onderwerp) || "").trim().slice(0, 200);
    const t = String((vrij && vrij.tekst) || "").trim().slice(0, 6000);
    if (!onderwerp || !t) throw new Error("Vul een onderwerp en een bericht in");
    titel = onderwerp;
    alineas = t.split(/\n{2,}/);
  } else throw new Error("Onbekend soort mail");
  // Bij een verzendbericht komt de volgcode in een eigen kaart (niet als de "code" zelf al een link is).
  const code = String(o.trackTrace || "").trim();
  const volgcode = soort === "verzonden" && code && !/^https?:\/\//i.test(code) ? code : "";
  return { winkel: winkelVan(o), aan: o.customerEmail, onderwerp, html: opmaak(titel, alineas, o, knop, volgcode), tekst: platteTekst(alineas, o, knop) };
}

function meldingMail(o, aan) {
  const alineas = ["Nieuwe betaalde bestelling van " + (o.customerName || "onbekend") + " (" + (o.customerEmail || "geen e-mail") + (o.customerPhone ? ", " + o.customerPhone : "") + ")."];
  return { winkel: winkelVan(o), aan, onderwerp: "Nieuwe bestelling " + o.id + " (" + euro(o.amount) + ")", html: opmaak("Nieuwe bestelling", alineas, o, null), tekst: platteTekst(alineas, o, null) };
}

module.exports = {
  DAG, kv, opslagAan, alleOrders, alleOrdersMetMeldingen, eenOrder, pasAan, logMail, logboek, leesLog, verschillen, schoon, samengevoegd, isBetaald,
  wachtwoordKlopt, maakCookie, ingelogd, bewaak, mailAan, mailVan, kaalAdres, verstuur, maakMail, meldingMail,
  geldigAdres, volgLink, VERZENDSTATUSSEN, WINKELS, winkelVan, winkelInfo, vanDeskna, desknaAan, archief, koppelArchief
};
