// Test het archief van het oude CRM: dubbele orders herkennen, aanvullen,
// bewerken, mailen (ook in het Duits) en nooit automatisch mailen.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const oudCrm = (nummer, extra) => ({ nummer, status: "verzonden", betaalstatus: "paid", aangenomen: false, handmatig: false, ...extra });
const ARCHIEF = [
  // Staat ook in de Deskna-webshop (zelfde Stripe-sessie): webshop telt, archief vult aan.
  { id: "#2449", bron: "archief", winkel: "deskna", customerName: "Kees Bureau", customerEmail: "kees@example.com", amount: 178, shippingCost: 29, items: [{ name: "DeskOne", quantity: 1, price: 149 }],
    paid: true, status: "betaald", siteStatus: "paid", createdAt: "2026-07-01T10:00:00Z", paidAt: "2026-07-01T10:00:00Z", fulfillmentStatus: "geannuleerd",
    stripeSessionId: "cs_live_dubbel", trackTrace: "1Z999", volgCode: "1Z999", volgUrl: "https://www.ups.com/track?tracknum=1Z999", oudCrm: oudCrm(2449, { status: "geannuleerd" }) },
  // Handmatig ingevoerd in het oude CRM en ook als order in de webshop: herkend op klant, bedrag en dag.
  { id: "#2500", bron: "archief", winkel: "deskna", customerName: "Anna", customerEmail: "Anna@Example.com", amount: 238, items: [], paid: false, status: "open", siteStatus: "open",
    createdAt: "2026-08-02T09:00:00Z", fulfillmentStatus: "verzonden", oudCrm: oudCrm(2500, { betaalstatus: "open", handmatig: true }) },
  // Alleen in het oude CRM.
  { id: "#3049", bron: "archief", winkel: "fatbiketeile", customerName: "Amjad Al-jadawi", customerEmail: "amjad@example.com", amount: 68.99, shippingCost: 15.99,
    items: [{ name: "Kenda - Reifen - Fatbike - 20x4.0", quantity: 1, price: 53 }], shippingAddress: { street: "Steinbeisstraße", houseNumber: "19/1", postalCode: "70771", city: "Leinfelden-Echterdingen", country: "DE" },
    paid: true, status: "betaald", siteStatus: "paid", createdAt: "2026-10-07T01:38:37Z", paidAt: "2026-10-07T01:38:37Z", fulfillmentStatus: "verzonden",
    stripeSessionId: "cs_live_teile", trackTrace: "JVGL0802", volgCode: "JVGL0802", volgUrl: "https://my.dhlparcel.nl/home/tracktrace/JVGL0802/70771", oudCrm: oudCrm(3049) },
  { id: "#2600", bron: "archief", winkel: "fatbikehulp", customerName: "Jan", customerEmail: "jan@example.com", amount: 44.95, shippingCost: 7.95, items: [{ name: "Rem", quantity: 1, price: 37 }],
    paid: false, status: "refunded", siteStatus: "refunded", createdAt: "2026-06-01T10:00:00Z", fulfillmentStatus: "verzonden", stripeSessionId: "cs_live_terug", oudCrm: oudCrm(2600, { betaalstatus: "refunded" }) }
];
const map = fs.mkdtempSync(path.join(os.tmpdir(), "crm-archief-"));
process.env.CRM_ARCHIEF_BESTAND = path.join(map, "archief.json");
fs.writeFileSync(process.env.CRM_ARCHIEF_BESTAND, JSON.stringify({ orders: ARCHIEF }));
process.env.CRM_GEHEIM = "test-geheim"; process.env.CRM_WACHTWOORD = "juist";
const lib = require("../api/_lib");

const desknaOrder = (id, extra) => JSON.stringify({
  id, status: "paid", total: 178, shipping: 29, createdAt: "2026-07-01T09:59:00.000Z", paidAt: "2026-07-01T10:00:00.000Z",
  lineItems: [{ productName: "DeskOne Bureau", quantity: 1, unitPrice: 149 }],
  shippingInfo: { firstName: "Kees", lastName: "Bureau", email: "kees@example.com", address: "Kade 5", zipCode: "8501 TV", city: "Joure", country: "Nederland" }, ...extra
});
const opslag = {
  crm: {
    orders: JSON.stringify([{ id: "ORD-1", customerName: "Piet", customerEmail: "piet@example.com", amount: 22.95, status: "betaald", createdAt: "2026-11-09T08:00:00.000Z", items: [] }]),
    "crm:deskna:start": "2026-11-10T12:00:00.000Z",
    "crm:start": "2026-11-09T00:00:00.000Z"
  },
  deskna: {
    "order:DESKNA-A": desknaOrder("DESKNA-A", { paymentId: "cs_live_dubbel" }),
    "order:DESKNA-B": desknaOrder("DESKNA-B", { total: 238, createdAt: "2026-08-03T12:00:00.000Z", paidAt: undefined, status: "on_delivery",
      shippingInfo: { firstName: "Anna", lastName: "", email: "anna@example.com", address: "Plein 1", zipCode: "1000 AA", city: "Amsterdam", country: "Nederland" } })
  }
};
const hashes = { "crm:orders": {}, "crm:bevestigd": {} };
let desknaStuk = false;
function voerUit(naam, cmd) {
  const db = opslag[naam];
  const [c, ...a] = cmd;
  if (naam === "deskna" && !["SCAN", "MGET", "GET"].includes(c)) return { error: "NOPERM alleen lezen" };
  if (c === "GET") return { result: db[a[0]] ?? null };
  if (c === "SETNX") { if (a[0] in db) return { result: 0 }; db[a[0]] = a[1]; return { result: 1 }; }
  if (c === "HGETALL") return { result: Object.entries(hashes[a[0]] || {}).flat() };
  if (c === "HGET") return { result: (hashes[a[0]] || {})[a[1]] ?? null };
  if (c === "HSET") { hashes[a[0]][a[1]] = a[2]; return { result: 1 }; }
  if (c === "HSETNX") { if (a[1] in hashes[a[0]]) return { result: 0 }; hashes[a[0]][a[1]] = a[2]; return { result: 1 }; }
  if (c === "HDEL") { delete hashes[a[0]][a[1]]; return { result: 1 }; }
  if (c === "MGET") return { result: a.map((k) => db[k] ?? null) };
  if (c === "SCAN") return { result: ["0", Object.keys(db).filter((k) => k.startsWith("order:"))] };
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
test.after(() => { server.close(); fs.rmSync(map, { recursive: true, force: true }); });

test("archief komt erbij; dubbele orders staan één keer in de lijst, met de gegevens uit het oude CRM", async () => {
  const { orders, meldingen, archief } = await lib.alleOrdersMetMeldingen();
  assert.deepEqual(meldingen, []);
  assert.deepEqual(archief, { totaal: 4, los: 2, gekoppeld: 2 });
  assert.deepEqual(orders.map((o) => o.id).sort(), ["#2600", "#3049", "DESKNA-A", "DESKNA-B", "ORD-1"]);
  const per = Object.fromEntries(orders.map((o) => [o.id, o]));
  // Zelfde Stripe-sessie: de webshoporder krijgt volgcode, oud nummer en de echte status (geannuleerd i.p.v. aangenomen afgeleverd).
  assert.equal(per["DESKNA-A"].oudCrm.nummer, 2449); assert.equal(per["DESKNA-A"].trackTrace, "1Z999");
  assert.equal(per["DESKNA-A"].fulfillmentStatus, "geannuleerd"); assert.equal(per["DESKNA-A"].afgeleverdAangenomen, undefined);
  // Handmatige order: herkend op klant (hoofdletters maken niet uit), bedrag en dag.
  assert.equal(per["DESKNA-B"].oudCrm.nummer, 2500); assert.equal(per["DESKNA-B"].fulfillmentStatus, "verzonden");
  assert.equal(per["#3049"].winkel, "fatbiketeile"); assert.equal(per["#3049"].betaald, true);
  assert.equal(per["#2600"].betaald, false); assert.equal(per["#2600"].siteStatus, "refunded");
  assert.equal(lib.winkelInfo().fatbiketeile.gekoppeld, true);
});

test("valt Deskna uit, dan ook geen Deskna-orders uit het archief (anders zouden ze dubbel lijken)", async () => {
  desknaStuk = true;
  const { orders, archief } = await lib.alleOrdersMetMeldingen();
  desknaStuk = false;
  assert.deepEqual(orders.map((o) => o.id).sort(), ["#2600", "#3049", "ORD-1"]);
  assert.equal(archief.totaal, 2);
});

test("archieforder openen en bewerken werkt; het archief zelf verandert niet", async () => {
  const o = await lib.eenOrder("#3049");
  assert.equal(o.customerName, "Amjad Al-jadawi");
  await lib.pasAan("#3049", { verzendstatus: "afgeleverd", notitie: "klant gebeld" });
  const na = await lib.eenOrder("#3049");
  assert.equal(na.verzendstatus, "afgeleverd"); assert.equal(na.notitie, "klant gebeld");
  assert.equal(lib.archief().find((x) => x.id === "#3049").verzendstatus, undefined);
  assert.equal(await lib.eenOrder("#1"), null);
  // Een losse webshoporder ophalen vult ook aan uit het archief.
  assert.equal((await lib.eenOrder("DESKNA-A")).oudCrm.nummer, 2449);
});

test("Fatbiketeile mailt in het Duits, vanaf fatbikehulp.nl, met de volglink uit het oude CRM", () => {
  delete process.env.FATBIKETEILE_MAIL_VAN; delete process.env.FATBIKETEILE_MAIL_WACHTWOORD;
  const o = lib.samengevoegd(ARCHIEF[2], {});
  const v = lib.maakMail(o, "verzonden");
  assert.equal(v.winkel, "fatbiketeile");
  assert.equal(v.onderwerp, "Deine Bestellung #3049 ist unterwegs");
  assert.match(v.tekst, /^Hallo Amjad,/); assert.match(v.tekst, /Sendungsnummer: JVGL0802/); assert.match(v.tekst, /Viele Grüße\nTeam Fatbiketeile/);
  assert.match(v.html, /href="https:\/\/my\.dhlparcel\.nl\/home\/tracktrace\/JVGL0802\/70771"/);
  assert.match(v.html, /Versand/); assert.ok(!/Verzending|Met vriendelijke groet/.test(v.html));
  const b = lib.maakMail(o, "bevestiging");
  assert.equal(b.onderwerp, "Vielen Dank für deine Bestellung #3049");
  // Andere volgcode ingevuld: dan geen oude link meer.
  assert.ok(!/dhlparcel/.test(lib.maakMail({ ...o, trackTrace: "NIEUW1" }, "verzonden").html));
  // Mailen: met het wachtwoord van fatbikehulp.nl, want de afzender zit op dat domein.
  delete process.env.MAIL_WACHTWOORD;
  assert.equal(lib.mailAan("fatbiketeile"), false);
  process.env.MAIL_WACHTWOORD = "x";
  assert.equal(lib.mailAan("fatbiketeile"), true); assert.equal(lib.mailVan("fatbiketeile"), "Fatbiketeile.de <info@fatbikehulp.nl>");
  // Eigen domein ingesteld zonder eigen wachtwoord: dan staat mailen uit.
  process.env.FATBIKETEILE_MAIL_VAN = "Fatbiketeile <info@fatbiketeile.de>";
  assert.equal(lib.mailAan("fatbiketeile"), false);
  delete process.env.FATBIKETEILE_MAIL_VAN; delete process.env.MAIL_WACHTWOORD;
  assert.equal(lib.WINKELS.fatbiketeile.autoBevestiging(), false);
});

test("de automatische bevestiging slaat archieforders over, ook als ze recent lijken", async () => {
  // Doe alsof #3049 net betaald is en Fatbiketeile automatisch zou bevestigen.
  const oud = ARCHIEF[2].paidAt;
  lib.archief().find((x) => x.id === "#3049").paidAt = new Date().toISOString();
  const auto = lib.WINKELS.fatbiketeile.autoBevestiging;
  lib.WINKELS.fatbiketeile.autoBevestiging = () => true;
  process.env.MAIL_WACHTWOORD = "x"; process.env.CRON_SECRET = "cron";
  const echteFetch = global.fetch;
  const mails = [];
  global.fetch = (url, opt) => (String(url).startsWith("https://api.forwardemail.net") ? (mails.push(JSON.parse(opt.body)), Promise.resolve(new Response("{}"))) : echteFetch(url, opt));
  try {
    const cron = require("../api/cron");
    let uit;
    await cron({ headers: { authorization: "Bearer cron" } }, { status: () => ({ json: (j) => (uit = j) }) });
    assert.deepEqual(uit.verstuurd, []); assert.deepEqual(mails, []);
    assert.equal(hashes["crm:bevestigd"]["#3049"], undefined);
  } finally {
    global.fetch = echteFetch; lib.WINKELS.fatbiketeile.autoBevestiging = auto;
    lib.archief().find((x) => x.id === "#3049").paidAt = oud;
    delete process.env.MAIL_WACHTWOORD; delete process.env.CRON_SECRET;
  }
});
