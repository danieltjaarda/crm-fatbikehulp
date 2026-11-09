const test = require("node:test");
const assert = require("node:assert");
process.env.CRM_GEHEIM = "test-geheim"; process.env.CRM_WACHTWOORD = "juist";
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
