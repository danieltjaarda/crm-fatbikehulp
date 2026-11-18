// Test het ophalen van bestellingen uit beide winkels tegen een nagebootste
// Upstash-opslag (zelfde REST-protocol: POST met het commando als JSON-lijst).
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

process.env.CRM_GEHEIM = "test-geheim"; process.env.CRM_WACHTWOORD = "juist";
// Leeg archief, zodat de echte orders uit het oude CRM niet meetellen.
process.env.CRM_ARCHIEF_BESTAND = require("node:path").join(__dirname, "fixtures", "archief-leeg.json");
const lib = require("../api/_lib");

const desknaOrder = (id, status, createdAt) => JSON.stringify({
  id, status, total: 208, shipping: 29, createdAt, paidAt: status === "paid" ? createdAt : undefined,
  lineItems: [{ productName: "DeskOne Bureau", quantity: 1, unitPrice: 179 }],
  shippingInfo: { firstName: "Piet", lastName: "de Vries", email: "piet@example.com", address: "Kade 5", zipCode: "8501 TV", city: "Joure", country: "Nederland" }
});

// Twee opslagen in één nepserver: het pad bepaalt welke (crm of deskna).
const opslag = {
  crm: {
    "orders": JSON.stringify([{ id: "ORD-1", customerName: "Jan", customerEmail: "jan@example.com", amount: 22.95, status: "betaald", createdAt: "2026-11-09T08:00:00.000Z", items: [] }]),
    "crm:deskna:start": "2026-11-10T12:00:00.000Z"
  },
  deskna: {
    "order:DESKNA-OUD": desknaOrder("DESKNA-OUD", "paid", "2026-10-07T09:00:00.000Z"),
    "order:DESKNA-NIEUW": desknaOrder("DESKNA-NIEUW", "paid", "2026-11-12T10:00:00.000Z"),
    "order:DESKNA-VERLOPEN": desknaOrder("DESKNA-VERLOPEN", "expired", "2026-11-11T10:00:00.000Z"),
    "order_payment:cs_live_x": "DESKNA-NIEUW",
    "order_stripe:cs_live_x": "DESKNA-NIEUW",
    "product:1": JSON.stringify({ id: "1", name: "geen order" })
  }
};
const geschreven = [];
let desknaStuk = false;

function voerUit(naam, cmd) {
  const db = opslag[naam];
  const [c, ...a] = cmd;
  if (naam === "deskna" && !["SCAN", "MGET", "GET"].includes(c)) { geschreven.push(cmd); return { error: "NOPERM alleen lezen" }; }
  if (c === "GET") return { result: db[a[0]] ?? null };
  if (c === "SETNX") { if (a[0] in db) return { result: 0 }; db[a[0]] = a[1]; return { result: 1 }; }
  if (c === "HGETALL") return { result: [] };
  if (c === "HGET") return { result: null };
  if (c === "MGET") return { result: a.map((k) => db[k] ?? null) };
  if (c === "SCAN") {
    // In twee stukken, zodat het doorlopen met de cursor ook getest wordt.
    const patroon = a[a.indexOf("MATCH") + 1].replace("*", "");
    const sleutels = Object.keys(db).filter((k) => k.startsWith(patroon));
    const helft = Math.ceil(sleutels.length / 2);
    return a[0] === "0" ? { result: ["7", sleutels.slice(0, helft)] } : { result: ["0", sleutels.slice(helft)] };
  }
  return { error: "onbekend commando " + c };
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const naam = req.url.includes("deskna") ? "deskna" : "crm";
    if (naam === "deskna" && desknaStuk) { res.writeHead(500); return res.end("{}"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(voerUit(naam, JSON.parse(body))));
  });
});

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const basis = "http://127.0.0.1:" + server.address().port;
  process.env.KV_REST_API_URL = basis + "/crm"; process.env.KV_REST_API_TOKEN = "crm-token";
  process.env.DESKNA_KV_REST_API_URL = basis + "/deskna"; process.env.DESKNA_KV_REST_API_READ_ONLY_TOKEN = "lees-token";
});
test.after(() => server.close());

test("bestellingen van beide winkels komen samen, nieuwste eerst", async () => {
  const { orders, meldingen } = await lib.alleOrdersMetMeldingen();
  assert.deepEqual(meldingen, []);
  assert.deepEqual(orders.map((o) => o.id), ["DESKNA-NIEUW", "DESKNA-VERLOPEN", "ORD-1", "DESKNA-OUD"]);
  const per = Object.fromEntries(orders.map((o) => [o.id, o]));
  assert.equal(per["ORD-1"].winkel, "fatbikehulp"); assert.equal(per["DESKNA-NIEUW"].winkel, "deskna");
  // Alleen echte orders: de indexsleutels en producten uit de Deskna-opslag tellen niet mee.
  assert.equal(orders.filter((o) => o.winkel === "deskna").length, 3);
  // Van vóór de koppeling = afgehandeld; daarna = te verzenden; verlopen = niet betaald.
  assert.equal(per["DESKNA-OUD"].fulfillmentStatus, "afgeleverd");
  assert.equal(per["DESKNA-NIEUW"].fulfillmentStatus, undefined); assert.equal(per["DESKNA-NIEUW"].betaald, true);
  assert.equal(per["DESKNA-VERLOPEN"].betaald, false);
});

test("één Deskna-order ophalen gaat rechtstreeks, en de CRM schrijft nooit in de Deskna-opslag", async () => {
  const o = await lib.eenOrder("DESKNA-NIEUW");
  assert.equal(o.customerName, "Piet de Vries"); assert.equal(o.winkel, "deskna");
  assert.equal(await lib.eenOrder("DESKNA-BESTAAT-NIET"), null);
  assert.equal((await lib.eenOrder("ORD-1")).winkel, "fatbikehulp");
  assert.deepEqual(geschreven, []);
});

test("valt Deskna uit, dan blijven de Fatbikehulp-bestellingen zichtbaar met een melding", async () => {
  desknaStuk = true;
  const { orders, meldingen } = await lib.alleOrdersMetMeldingen();
  desknaStuk = false;
  assert.deepEqual(orders.map((o) => o.id), ["ORD-1"]);
  assert.equal(meldingen.length, 1); assert.match(meldingen[0], /^Deskna kon niet worden opgehaald/);
});
