// Zet de orders uit het oude CRM (Express + SQLite, draaide tot 14 okt 2026 op
// de Mac mini M4) om naar data/archief.json, in de vorm die deze CRM gebruikt.
//
//   node scripts/archief-maken.js <pad naar crm.sqlite> [uitvoerbestand]
//
// Werk op een kopie van crm.sqlite (met -wal/-shm erbij), niet op de backup zelf.
// Het archief bevat klantgegevens: het staat in .gitignore en gaat alleen mee
// in de deploy (niet in public/, dus niet van buiten op te vragen).
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const bron = process.argv[2];
const uitvoer = process.argv[3] || path.join(__dirname, "..", "data", "archief.json");
if (!bron) { console.error("Gebruik: node scripts/archief-maken.js <crm.sqlite> [uitvoer.json]"); process.exit(1); }

// Orders die in het oude CRM nog op nieuw/verwerkt stonden maar ouder zijn dan
// dit moment, gelden als afgehandeld (betaald, nooit teruggedraaid). Recentere
// komen in "Te verzenden", zodat je ze kunt nalopen.
const NALOPEN_VANAF = "2026-09-14T00:00:00Z";

const db = new DatabaseSync(bron, { readOnly: true });
const alles = (sql) => db.prepare(sql).all();
const leesJson = (s, anders) => { if (!s) return anders; try { return JSON.parse(s); } catch (e) { return anders; } };
const tijd = (s) => (s ? String(s).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z") : undefined);
const euro = (c) => Math.round(Number(c) || 0) / 100;
const VERZEND_RE = /^(verzendkosten|versandkosten|verzending|versand|shipping)\b/i;
const STATUS = { nieuw: "nieuw", verwerkt: "verwerkt", verzonden: "verzonden", afgerond: "afgeleverd", geannuleerd: "geannuleerd" };
const BETAALD = ["paid", "partially_refunded", "chargeback"];

const perOrder = (rows, sleutel = "order_id") => {
  const m = new Map();
  for (const r of rows) { if (!m.has(r[sleutel])) m.set(r[sleutel], []); m.get(r[sleutel]).push(r); }
  return m;
};
const geschiedenis = perOrder(alles("SELECT order_id, old_status, new_status, note, changed_at FROM order_status_history ORDER BY changed_at, id"));
const mails = perOrder(alles("SELECT order_id, created_at, recipient, subject, status, error FROM email_log ORDER BY created_at, id"));
const retouren = perOrder(alles("SELECT order_id, created_at, reason, status, admin_status, admin_note, amount, tracking_code, tracking_url, processed_at FROM returns ORDER BY created_at"));
const betaalmeldingen = perOrder(alles("SELECT order_id, created_at, type, amount, reason, dispute_status, resolved_at FROM payment_alerts ORDER BY created_at"));

const rijen = alles(`SELECT o.*, c.name AS c_name, c.email AS c_email, c.phone AS c_phone, c.address_line1 AS c_adres,
  c.postal_code AS c_postcode, c.city AS c_plaats, c.country AS c_land
  FROM orders o LEFT JOIN customers c ON c.id = o.customer_id ORDER BY o.id`);

const orders = [];
const overgeslagen = [];
const afwijkingen = [];
for (const r of rijen) {
  const meta = leesJson(r.metadata, {});
  if (meta.test === true) { overgeslagen.push("#" + r.id + " (test)"); continue; }

  const regels = leesJson(r.items, []);
  const verzend = regels.filter((l) => VERZEND_RE.test(String(l.description || "")));
  const producten = regels.filter((l) => !VERZEND_RE.test(String(l.description || "")));
  let items = producten.map((l) => {
    const q = Number(l.quantity) || 1;
    return { name: String(l.description || ""), quantity: q, price: Math.round((Number(l.amount) || 0) / q) / 100 };
  });
  // Handmatige orders hebben soms geen Stripe-regels; dan de producten uit de metadata.
  if (!items.length) {
    items = leesJson(meta.items, []).filter((x) => x && x.name).map((x) => ({ name: String(x.name), quantity: Number(x.quantity) || 1, price: Number(x.price) || 0 }));
  }
  const somRegels = regels.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  let shippingCost = euro(verzend.reduce((s, l) => s + (Number(l.amount) || 0), 0));
  // Deskna rekende verzending (€ 29) via Stripe-verzendopties: die staat niet als regel in de order.
  if (!verzend.length && regels.length && r.amount > somRegels) shippingCost = euro(r.amount - somRegels);
  else if (regels.length && somRegels !== r.amount) afwijkingen.push("#" + r.id + ": regels " + somRegels + " ≠ totaal " + r.amount);

  const sa = leesJson(meta.shippingAddress, null);
  const shippingAddress = sa && (sa.street || sa.postalCode)
    ? { street: sa.street || "", houseNumber: sa.houseNumber || "", postalCode: sa.postalCode || "", city: sa.city || "", country: sa.country || "" }
    : { street: r.c_adres || "", houseNumber: "", postalCode: r.c_postcode || "", city: r.c_plaats || "", country: r.c_land || "" };
  // Het oude CRM plakte het huisnummer soms ook achter de straat ("Steinbeisstraße 19/1 19/1").
  if (shippingAddress.houseNumber && shippingAddress.street.endsWith(" " + shippingAddress.houseNumber + " " + shippingAddress.houseNumber)) {
    shippingAddress.street = shippingAddress.street.slice(0, -(shippingAddress.houseNumber.length + 1));
  }
  const ps = leesJson(meta.parcelShop, null);

  const createdAt = tijd(r.created_at);
  const betaald = BETAALD.includes(r.payment_status);
  let fulfillmentStatus = STATUS[r.status] || "nieuw";
  let aangenomen = false;
  if ((fulfillmentStatus === "nieuw" || fulfillmentStatus === "verwerkt") && betaald && createdAt < NALOPEN_VANAF) {
    fulfillmentStatus = "afgeleverd"; aangenomen = true;
  }
  const code = r.tracking_code || r.ups_tracking_code || "";
  const url = r.tracking_url || r.ups_tracking_url || "";
  const stripe = /^cs_/.test(r.stripe_checkout_id || "");

  const o = {
    id: "#" + r.id,
    bron: "archief",
    winkel: r.stripe_account,
    customerName: (sa && sa.name) || r.shipping_name || r.c_name || "",
    customerEmail: r.c_email || "",
    customerPhone: r.c_phone || (sa && sa.phone) || "",
    amount: euro(r.amount),
    currency: r.currency || "eur",
    shippingCost,
    items,
    shippingAddress,
    paid: betaald,
    status: betaald ? "betaald" : r.payment_status,
    siteStatus: r.payment_status,
    paymentMethod: r.payment_method || "",
    createdAt,
    fulfillmentStatus,
    oudCrm: { nummer: r.id, status: r.status, betaalstatus: r.payment_status, aangenomen, handmatig: !stripe }
  };
  if (betaald) o.paidAt = createdAt;
  if (stripe) o.stripeSessionId = r.stripe_checkout_id;
  if (r.stripe_payment_intent) o.stripePaymentIntentId = r.stripe_payment_intent;
  if (meta.deliveryType) o.deliveryType = meta.deliveryType;
  if (meta.deliveryDate) o.deliveryDate = meta.deliveryDate;
  if (ps && ps.name) o.parcelShop = ps;
  if (code) { o.trackTrace = code; o.volgCode = code; }
  if (url) o.volgUrl = url;
  if (r.desired_delivery_date) o.oudCrm.gewensteLeverdatum = r.desired_delivery_date;

  const g = (geschiedenis.get(r.id) || []).map((h) => ({ tijd: tijd(h.changed_at), status: h.new_status, notitie: h.note || "" }));
  if (g.length) o.oudCrm.geschiedenis = g;
  const m = (mails.get(r.id) || []).map((e) => ({ tijd: tijd(e.created_at), aan: e.recipient || "", onderwerp: e.subject || "", ...(e.status === "sent" ? {} : { mislukt: e.error || e.status || "mislukt" }) }));
  if (m.length) o.oudCrm.mails = m;
  const rt = (retouren.get(r.id) || []).map((x) => ({ tijd: tijd(x.created_at), reden: x.reason || "", status: x.status || "", afhandeling: x.admin_status || "", notitie: x.admin_note || "", bedrag: euro(x.amount), trackTrace: x.tracking_code || "", volgUrl: x.tracking_url || "", verwerkt: tijd(x.processed_at) }));
  if (rt.length) o.oudCrm.retouren = rt;
  const b = (betaalmeldingen.get(r.id) || []).map((x) => ({ tijd: tijd(x.created_at), soort: x.type, bedrag: euro(x.amount), reden: x.reason || "", status: x.dispute_status || "", opgelost: tijd(x.resolved_at) }));
  if (b.length) o.oudCrm.betaalmeldingen = b;
  orders.push(o);
}

fs.mkdirSync(path.dirname(uitvoer), { recursive: true });
const inhoud = { gemaakt: new Date().toISOString(), bron: "Oud CRM (Mac mini M4), database van 14 okt 2026", nalopenVanaf: NALOPEN_VANAF, orders };
fs.writeFileSync(uitvoer, JSON.stringify(inhoud));

const per = {};
for (const o of orders) {
  const p = (per[o.winkel] = per[o.winkel] || { orders: 0, betaald: 0, teVerzenden: 0, aangenomen: 0, volgcode: 0 });
  p.orders++; if (o.paid) p.betaald++;
  if (o.paid && (o.fulfillmentStatus === "nieuw" || o.fulfillmentStatus === "verwerkt")) p.teVerzenden++;
  if (o.oudCrm.aangenomen) p.aangenomen++;
  if (o.trackTrace) p.volgcode++;
}
console.log("Geschreven:", uitvoer, (fs.statSync(uitvoer).size / 1024).toFixed(0) + " kB");
console.table(per);
console.log("Overgeslagen:", overgeslagen.join(", ") || "geen");
console.log("Regels die niet optellen tot het totaal:", afwijkingen.length, afwijkingen.slice(0, 5).join("; "));
