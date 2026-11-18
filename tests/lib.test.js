const test = require("node:test");
const assert = require("node:assert");
process.env.CRM_GEHEIM = "test-geheim"; process.env.CRM_WACHTWOORD = "juist";
// Leeg archief, zodat de echte orders uit het oude CRM niet meetellen.
process.env.CRM_ARCHIEF_BESTAND = require("node:path").join(__dirname, "fixtures", "archief-leeg.json");
const lib = require("../api/_lib");

const order = { id: "ORD-1", customerName: "Jan <b>Jansen</b>", customerEmail: "jan@example.com", amount: 22.95, shippingCost: 7.95, status: "betaald",
  items: [{ name: "Binnenband 20x4", quantity: 1, price: 15 }], shippingAddress: { street: "Dorpsstraat", houseNumber: "1", postalCode: "1234 ab", city: "Joure" } };

test("wijziging komt over de order, site-velden blijven", () => {
  const s = lib.samengevoegd(order, { verzendstatus: "verzonden", trackTrace: "ABC", shippingAddress: { city: "Sneek" }, status: "gehackt" });
  assert.equal(s.verzendstatus, "verzonden"); assert.equal(s.shippingAddress.city, "Sneek"); assert.equal(s.shippingAddress.street, "Dorpsstraat");
  assert.equal(s.status, "betaald"); assert.equal(s.betaald, true);
});
test("schoon laat alleen toegestane velden door en keurt foute invoer af", () => {
  assert.deepEqual(lib.schoon({ amount: 0, paid: true, notitie: " hoi " }), { notitie: "hoi" });
  assert.throws(() => lib.schoon({ customerEmail: "geen adres" }));
  assert.throws(() => lib.schoon({ verzendstatus: "weg" }));
});
test("mail: html is ontsnapt, verzendbericht heeft volglink met postcode", () => {
  const b = lib.maakMail(order, "bevestiging");
  assert.ok(!b.html.includes("<b>Jansen")); assert.equal(b.aan, "jan@example.com"); assert.match(b.html, /22,95/);
  const v = lib.maakMail({ ...order, trackTrace: "JVGL123" }, "verzonden");
  assert.match(v.html, /tracktrace\/JVGL123\/1234AB/);
  assert.throws(() => lib.maakMail(order, "vrij", { onderwerp: "", tekst: "" }));
});
test("inloggen: juiste cookie werkt, vervalste niet", () => {
  assert.equal(lib.wachtwoordKlopt("juist"), true); assert.equal(lib.wachtwoordKlopt("fout"), false);
  const c = lib.maakCookie().split(";")[0];
  assert.equal(lib.ingelogd({ headers: { cookie: c } }), true);
  assert.equal(lib.ingelogd({ headers: { cookie: c.slice(0, -2) + "xx" } }), false);
  assert.equal(lib.ingelogd({ headers: { cookie: "crm=" + (Date.now() + 1e9) + ".nep" } }), false);
  assert.equal(lib.ingelogd({ headers: {} }), false);
});

// ---------- Deskna ----------
const deskna = (extra) => ({
  id: "DESKNA-ABC-1", status: "paid", paymentMethod: "ideal", total: 208, shipping: 29, createdAt: "2026-11-12T10:00:00.000Z", paidAt: "2026-11-12T10:05:00.000Z",
  lineItems: [{ productName: "DeskOne Bureau", quantity: 1, unitPrice: 179, selectedOptions: [{ name: "Grootte", value: "140x70 cm" }, { name: "Tafelblad kleur", value: "Eiken" }] }],
  shippingInfo: { firstName: "Piet", lastName: "de Vries", email: "piet@example.com", phone: "0612345678", address: "Kade 5", zipCode: "8501 TV", city: "Joure", country: "Nederland" },
  ...extra
});
const START = Date.parse("2026-11-10T12:00:00.000Z");

test("Deskna-order wordt omgezet naar de vorm van de CRM", () => {
  const o = lib.samengevoegd(lib.vanDeskna(deskna(), START), {});
  assert.equal(o.winkel, "deskna"); assert.equal(o.betaald, true); assert.equal(o.customerName, "Piet de Vries");
  assert.equal(o.amount, 208); assert.equal(o.shippingCost, 29); assert.equal(o.items[0].name, "DeskOne Bureau (140x70 cm / Eiken)");
  assert.equal(o.shippingAddress.street, "Kade 5"); assert.equal(o.shippingAddress.postalCode, "8501 TV");
  assert.equal(o.fulfillmentStatus, undefined); assert.equal(o.openBijLevering, 0);
});
test("Deskna: oude bestellingen zijn afgehandeld, onbetaalde blijven open", () => {
  assert.equal(lib.vanDeskna(deskna({ createdAt: "2026-10-07T09:00:00.000Z" }), START).fulfillmentStatus, "afgeleverd");
  const verlopen = lib.samengevoegd(lib.vanDeskna(deskna({ status: "expired", createdAt: "2026-10-07T09:00:00.000Z" }), START), {});
  assert.equal(verlopen.betaald, false); assert.equal(verlopen.fulfillmentStatus, undefined); assert.equal(verlopen.siteStatus, "expired");
});
test("Deskna: aanbetaling en betalen bij levering tellen als bevestigd met open bedrag", () => {
  const aan = lib.samengevoegd(lib.vanDeskna(deskna({ status: "deposit_paid", paymentPlan: "deposit", amountDueNow: 62.4, amountDueOnDelivery: 145.6, paidAt: undefined, depositPaidAt: "2026-11-12T10:05:00.000Z" }), START), {});
  assert.equal(aan.betaald, true); assert.equal(aan.aanbetaald, 62.4); assert.equal(aan.openBijLevering, 145.6); assert.equal(aan.paidAt, "2026-11-12T10:05:00.000Z");
  const lev = lib.samengevoegd(lib.vanDeskna(deskna({ status: "on_delivery", paymentPlan: "on_delivery", amountDueNow: 0, amountDueOnDelivery: 208, paidAt: undefined }), START), {});
  assert.equal(lev.betaald, true); assert.equal(lev.openBijLevering, 208); assert.equal(lev.paidAt, "2026-11-12T10:00:00.000Z");
  assert.match(lib.maakMail(aan, "bevestiging").tekst, /aanbetaling van € 62,40.*restbedrag van € 145,60/);
  assert.match(lib.maakMail(lev, "bevestiging").tekst, /Je betaalt € 208,00 bij levering/);
});
test("mail per winkel: Deskna-klant krijgt nooit Fatbikehulp-opmaak en andersom", () => {
  const d = lib.maakMail(lib.samengevoegd(lib.vanDeskna(deskna(), START), {}), "bevestiging");
  assert.equal(d.winkel, "deskna"); assert.ok(!/fatbikehulp/i.test(d.html + d.tekst)); assert.match(d.html, /Team Deskna/); assert.match(d.html, /www\.deskna\.nl/);
  const f = lib.maakMail(order, "bevestiging");
  assert.equal(f.winkel, "fatbikehulp"); assert.ok(!/deskna/i.test(f.html + f.tekst)); assert.match(f.html, /Team Fatbikehulp/);
  // Een losse volgcode wordt bij Deskna geen DHL-link.
  const v = lib.maakMail({ ...lib.vanDeskna(deskna(), START), trackTrace: "RH123" }, "verzonden");
  assert.ok(!/dhlecommerce/.test(v.html)); assert.match(v.tekst, /Volgcode: RH123/);
});
test("mailen staat per winkel aan of uit; Deskna-bevestiging is standaard uit", async () => {
  delete process.env.MAIL_WACHTWOORD; delete process.env.DESKNA_MAIL_WACHTWOORD; delete process.env.DESKNA_AUTO_BEVESTIGING;
  assert.equal(lib.mailAan("fatbikehulp"), false); assert.equal(lib.mailAan("deskna"), false);
  process.env.MAIL_WACHTWOORD = "x";
  assert.equal(lib.mailAan("fatbikehulp"), true); assert.equal(lib.mailAan(), true); assert.equal(lib.mailAan("deskna"), false);
  await assert.rejects(lib.verstuur({ winkel: "deskna", aan: "piet@example.com", onderwerp: "x", tekst: "x", html: "x" }), /Deskna nog uit/);
  assert.equal(lib.WINKELS.fatbikehulp.autoBevestiging(), true); assert.equal(lib.WINKELS.deskna.autoBevestiging(), false);
  process.env.DESKNA_AUTO_BEVESTIGING = "1"; assert.equal(lib.WINKELS.deskna.autoBevestiging(), true);
  delete process.env.MAIL_WACHTWOORD; delete process.env.DESKNA_AUTO_BEVESTIGING;
});
test("met de API-sleutel mailt een winkel zonder eigen wachtwoord; een eigen wachtwoord gaat voor", async () => {
  delete process.env.MAIL_WACHTWOORD; delete process.env.DESKNA_MAIL_WACHTWOORD; delete process.env.DESKNA_AUTO_BEVESTIGING;
  process.env.FORWARDEMAIL_API_SLEUTEL = "sleutel123";
  const echt = global.fetch;
  const verzoeken = [];
  global.fetch = async (url, o) => { verzoeken.push({ url, o }); return { ok: true, json: async () => ({ id: "m1" }) }; };
  try {
    assert.equal(lib.mailAan("deskna"), true);
    assert.equal(lib.WINKELS.deskna.autoBevestiging(), false);
    await lib.verstuur({ winkel: "deskna", aan: "piet@example.com", onderwerp: "x", tekst: "x", html: "x" });
    assert.equal(verzoeken[0].o.headers.Authorization, "Basic " + Buffer.from("sleutel123:").toString("base64"));
    assert.match(JSON.parse(verzoeken[0].o.body).from, /info@deskna\.nl/);
    process.env.MAIL_WACHTWOORD = "eigen";
    await lib.verstuur({ winkel: "fatbikehulp", aan: "piet@example.com", onderwerp: "x", tekst: "x", html: "x" });
    assert.equal(verzoeken[1].o.headers.Authorization, "Basic " + Buffer.from("*@fatbikehulp.nl:eigen").toString("base64"));
  } finally {
    global.fetch = echt;
    delete process.env.FORWARDEMAIL_API_SLEUTEL; delete process.env.MAIL_WACHTWOORD;
  }
});
