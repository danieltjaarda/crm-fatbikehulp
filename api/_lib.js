// Gedeelde code voor de CRM van fatbikehulp.nl.
//
// Bestellingen komen uit de site (BRON_URL, standaard de order-API van
// fatbikehulp.nl). De CRM schrijft daar nooit naartoe: alles wat je hier
// bewerkt staat als "wijziging per order" in de eigen opslag van de CRM en
// wordt bij het tonen over de order uit de site heen gelegd. De webshop kan
// dus niet stuk door iets wat hier gebeurt.
//
//   CRM_WACHTWOORD    wachtwoord om in te loggen
//   CRM_GEHEIM        sleutel waarmee de inlogcookie is ondertekend
//   KV_REST_API_URL / KV_REST_API_TOKEN   eigen opslag (Upstash Redis)
//   MAIL_VAN          afzender, standaard "Fatbikehulp <info@fatbikehulp.nl>"
//   MAIL_WACHTWOORD   wachtwoord van die alias in Forward Email; zonder staat mailen uit
//   MAIL_MELDINGEN    optioneel: adres dat een melding krijgt bij een nieuwe bestelling
//   CRON_SECRET       door Vercel meegestuurd bij de automatische controle

const crypto = require("node:crypto");

const BRON_URL = process.env.BRON_URL || "https://www.fatbikehulp.nl/api/web-orders";
const DAG = 24 * 60 * 60 * 1000;

// ---------- opslag ----------
function kvUrl() { return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || ""; }
function kvToken() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""; }
function opslagAan() { return !!(kvUrl() && kvToken()); }

async function kv(...cmd) {
  if (!opslagAan()) throw new Error("De opslag van de CRM is nog niet gekoppeld");
  const r = await fetch(kvUrl(), {
    method: "POST",
    headers: { Authorization: "Bearer " + kvToken(), "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error("Opslag: " + ((j && j.error) || r.status));
  return j.result;
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

function isBetaald(o) { return o.paid === true || o.status === "betaald" || o.status === "paid"; }

/** Order uit de site met de CRM-wijziging eroverheen. */
function samengevoegd(o, w) {
  w = w || {};
  const uit = { ...o };
  for (const k of BEWERKBAAR) if (k !== "shippingAddress" && w[k] !== undefined) uit[k] = w[k];
  if (w.shippingAddress) uit.shippingAddress = { ...(o.shippingAddress || {}), ...w.shippingAddress };
  uit.betaald = isBetaald(o);
  uit.mails = w.mails || [];
  uit.bewerktOp = w.bewerktOp || null;
  return uit;
}

async function alleOrders() {
  const [orders, w] = await Promise.all([bronOrders(), alleWijzigingen()]);
  return orders.map((o) => samengevoegd(o, w[o.id]));
}
async function eenOrder(id) {
  const orders = await bronOrders();
  const o = orders.find((x) => x.id === id);
  if (!o) return null;
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

async function logMail(id, regel) {
  const w = await wijziging(id);
  w.mails = [...(w.mails || []), { ...regel, tijd: new Date().toISOString() }].slice(-50);
  await bewaarWijziging(id, w);
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

// ---------- mail ----------
const MAIL_API = "https://api.forwardemail.net/v1/emails";
function mailVan() { return process.env.MAIL_VAN || "Fatbikehulp <info@fatbikehulp.nl>"; }
function kaalAdres(van) {
  const m = /<([^>]+)>\s*$/.exec(van);
  return (m ? m[1] : van).trim();
}
function mailAan() { return !!process.env.MAIL_WACHTWOORD && geldigAdres(kaalAdres(mailVan())); }

async function verstuur({ aan, onderwerp, tekst, html }) {
  if (!mailAan()) throw new Error("Mailen staat nog uit: het wachtwoord van de mailalias ontbreekt");
  if (!geldigAdres(aan)) throw new Error("Het e-mailadres van de klant klopt niet");
  const gebruiker = kaalAdres(mailVan());
  const r = await fetch(MAIL_API, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(gebruiker + ":" + process.env.MAIL_WACHTWOORD).toString("base64"),
      "Content-Type": "application/json", Accept: "application/json"
    },
    body: JSON.stringify({ from: mailVan(), to: aan, subject: onderwerp, text: tekst, html }),
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
function voornaam(o) { return String(o.customerName || "").trim().split(/\s+/)[0] || "klant"; }
function adresRegels(o) {
  const a = o.shippingAddress || {};
  if (o.parcelShop && o.parcelShop.name) {
    const p = o.parcelShop.address || {};
    return ["Afhaalpunt: " + o.parcelShop.name, [p.street, p.number].filter(Boolean).join(" "), [p.zipCode, p.city].filter(Boolean).join(" ")].filter(Boolean);
  }
  return [a.streetAndNumber || [a.street, a.houseNumber].filter(Boolean).join(" "), [a.postalCode, a.city].filter(Boolean).join(" ")].filter(Boolean);
}
function volgLink(o) {
  const c = String(o.trackTrace || "").trim();
  if (!c) return "";
  if (/^https?:\/\//i.test(c)) return c;
  const pc = String((o.shippingAddress || {}).postalCode || "").replace(/\s/g, "").toUpperCase();
  return "https://my.dhlecommerce.nl/home/tracktrace/" + encodeURIComponent(c) + (pc ? "/" + encodeURIComponent(pc) : "");
}

function opmaak(titel, alineas, o, knop) {
  const regels = (o.items || []).map((i) =>
    '<tr><td style="padding:6px 0;border-bottom:1px solid #eee">' + esc(i.quantity) + " × " + esc(i.name) + '</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">' + esc(euro((Number(i.price) || 0) * (Number(i.quantity) || 1))) + "</td></tr>").join("");
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222;font-size:15px;line-height:1.5">' +
    '<h1 style="font-size:20px;color:#234C6A;margin:0 0 16px">' + esc(titel) + "</h1>" +
    alineas.map((a) => '<p style="margin:0 0 14px">' + esc(a).replace(/\n/g, "<br>") + "</p>").join("") +
    (knop ? '<p style="margin:0 0 18px"><a href="' + esc(knop.url) + '" style="background:#234C6A;color:#fff;padding:11px 18px;border-radius:6px;text-decoration:none;display:inline-block">' + esc(knop.tekst) + "</a></p>" : "") +
    '<div style="background:#f6f7f8;border-radius:8px;padding:16px;margin:0 0 18px">' +
    '<p style="margin:0 0 8px"><strong>Bestelling ' + esc(o.id) + "</strong></p>" +
    (regels ? '<table style="width:100%;border-collapse:collapse;font-size:14px">' + regels +
      (o.shippingCost ? '<tr><td style="padding:6px 0">Verzending</td><td style="padding:6px 0;text-align:right">' + esc(euro(o.shippingCost)) + "</td></tr>" : "") +
      '<tr><td style="padding:6px 0"><strong>Totaal</strong></td><td style="padding:6px 0;text-align:right"><strong>' + esc(euro(o.amount)) + "</strong></td></tr></table>" : "") +
    '<p style="margin:12px 0 0;font-size:14px;color:#555">' + adresRegels(o).map(esc).join("<br>") + "</p></div>" +
    '<p style="margin:0;color:#555">Met vriendelijke groet,<br>Team Fatbikehulp<br><a href="https://www.fatbikehulp.nl" style="color:#234C6A">www.fatbikehulp.nl</a></p></div>';
}
function platteTekst(alineas, o, knop) {
  const regels = (o.items || []).map((i) => "- " + i.quantity + " x " + i.name);
  return [...alineas, knop ? knop.tekst + ": " + knop.url : "", "Bestelling " + o.id, ...regels, "Totaal: " + euro(o.amount), "", ...adresRegels(o), "", "Met vriendelijke groet,", "Team Fatbikehulp"].filter((x) => x !== "").join("\n");
}

/** Maakt de mail voor een order. soort: bevestiging | verzonden | vrij */
function maakMail(o, soort, vrij) {
  const hoi = "Hoi " + voornaam(o) + ",";
  let onderwerp, titel, alineas, knop = null;
  if (soort === "bevestiging") {
    onderwerp = "Bedankt voor je bestelling " + o.id;
    titel = "Bedankt voor je bestelling!";
    alineas = [hoi, "We hebben je bestelling en betaling ontvangen. We maken je pakket zo snel mogelijk klaar.", "Zodra het onderweg is, krijg je van ons een mail met de volgcode."];
  } else if (soort === "verzonden") {
    onderwerp = "Je bestelling " + o.id + " is onderweg";
    titel = "Je pakket is onderweg";
    const link = volgLink(o);
    alineas = [hoi, "Goed nieuws: je bestelling is verzonden."];
    if (link) { alineas.push("Volgcode: " + o.trackTrace); knop = { url: link, tekst: "Volg je pakket" }; }
    alineas.push("Heb je een vraag over je bestelling? Beantwoord dan gewoon deze mail.");
  } else if (soort === "vrij") {
    onderwerp = String((vrij && vrij.onderwerp) || "").trim().slice(0, 200);
    const t = String((vrij && vrij.tekst) || "").trim().slice(0, 6000);
    if (!onderwerp || !t) throw new Error("Vul een onderwerp en een bericht in");
    titel = onderwerp;
    alineas = t.split(/\n{2,}/);
  } else throw new Error("Onbekend soort mail");
  return { aan: o.customerEmail, onderwerp, html: opmaak(titel, alineas, o, knop), tekst: platteTekst(alineas, o, knop) };
}

function meldingMail(o, aan) {
  const alineas = ["Nieuwe betaalde bestelling van " + (o.customerName || "onbekend") + " (" + (o.customerEmail || "geen e-mail") + (o.customerPhone ? ", " + o.customerPhone : "") + ")."];
  return { aan, onderwerp: "Nieuwe bestelling " + o.id + " (" + euro(o.amount) + ")", html: opmaak("Nieuwe bestelling", alineas, o, null), tekst: platteTekst(alineas, o, null) };
}

module.exports = {
  DAG, kv, opslagAan, alleOrders, eenOrder, pasAan, logMail, schoon, samengevoegd, isBetaald,
  wachtwoordKlopt, maakCookie, ingelogd, bewaak, mailAan, mailVan, kaalAdres, verstuur, maakMail, meldingMail,
  geldigAdres, volgLink, VERZENDSTATUSSEN
};
