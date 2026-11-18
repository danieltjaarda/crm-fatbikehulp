// Pushmelding naar Daniels iPhone via Seintje (eigen app) bij elke nieuwe betaalde
// bestelling. SEINTJE_URL is de volledige webhook-URL inclusief sleutel
// (https://seintje-lyart.vercel.app/in/<sleutel>); zonder die env gebeurt er niets.
// SEINTJE_WINKELS (komma's) bepaalt voor welke winkels; standaard fatbikehulp en deskna.
const { DAG, kv, winkelVan, WINKELS } = require("./_lib");

const CRM_URL = process.env.CRM_URL || "https://fatbikehulp-crm.vercel.app";

function euro(n) { return "€ " + (Number(n) || 0).toFixed(2).replace(".", ","); }

function winkels() {
  return String(process.env.SEINTJE_WINKELS || "fatbikehulp,deskna").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Titel en tekst van de melding. */
function bericht(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  const regels = items.slice(0, 6).map((i) => (Number(i.quantity) > 1 ? i.quantity + "× " : "") + String(i.name || "").slice(0, 80));
  if (items.length > 6) regels.push("… en nog " + (items.length - 6));
  const a = o.shippingAddress || {};
  const plaats = [a.city, a.country && a.country !== "NL" ? a.country : ""].filter(Boolean).join(", ");
  const wie = (o.customerName || "Onbekende klant") + (plaats ? " uit " + plaats : "");
  // Deskna: aanbetaling of betalen bij levering
  if (Number(o.openBijLevering) > 0) regels.push((Number(o.aanbetaald) > 0 ? "Aanbetaald " + euro(o.aanbetaald) + ", " : "") + euro(o.openBijLevering) + " bij levering");
  return {
    titel: "Nieuwe bestelling " + euro(o.amount),
    tekst: [wie, ...regels].join("\n").slice(0, 900)
  };
}

async function stuur(o) {
  const url = String(process.env.SEINTJE_URL || "").trim();
  if (!url) return false;
  const b = bericht(o);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bron: (WINKELS[winkelVan(o)] || {}).naam || winkelVan(o), titel: b.titel, tekst: b.tekst, url: CRM_URL }),
    signal: AbortSignal.timeout(4000)
  });
  if (!r.ok) throw new Error("Seintje gaf " + r.status);
  return true;
}

/**
 * Eén melding per betaalde bestelling, alleen voor bestellingen betaald nadat
 * dit voor het eerst liep (crm:seintje:start) en hooguit 2 dagen oud.
 * Vastleggen gaat vóór het versturen (HSETNX), dus nooit dubbel; mislukt het
 * versturen, dan wordt het vrijgegeven voor de volgende ronde.
 */
async function meldNieuwe(orders) {
  if (!String(process.env.SEINTJE_URL || "").trim()) return { overgeslagen: "SEINTJE_URL ontbreekt" };
  await kv("SETNX", "crm:seintje:start", new Date().toISOString());
  const start = Date.parse(await kv("GET", "crm:seintje:start"));
  const aan = winkels();
  const nu = Date.now();
  const gemeld = [], mislukt = [];
  for (const o of orders) {
    if (o.bron === "archief" || !o.betaald || o.verborgen) continue;
    if (aan.indexOf(winkelVan(o)) < 0) continue;
    const t = Date.parse(o.paidAt || o.createdAt || "");
    if (!t || t < start || nu - t > 2 * DAG) continue;
    if ((await kv("HSETNX", "crm:seintje", o.id, new Date().toISOString())) !== 1) continue;
    try {
      await stuur(o);
      gemeld.push(o.id);
    } catch (e) {
      await kv("HDEL", "crm:seintje", o.id);
      mislukt.push({ id: o.id, fout: e.message });
    }
  }
  return { gemeld, mislukt };
}

module.exports = { bericht, stuur, meldNieuwe };
