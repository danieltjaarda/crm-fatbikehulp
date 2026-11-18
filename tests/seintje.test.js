const test = require("node:test");
const assert = require("node:assert");
const { bericht, meldNieuwe } = require("../api/_seintje");

test("bericht: bedrag, klant, plaats en artikelen", () => {
  const b = bericht({ amount: 89.5, customerName: "Jan Jansen", shippingAddress: { city: "Utrecht", country: "NL" },
    items: [{ name: "Remschijf 180mm", quantity: 2 }, { name: "Binnenband 20x4.0", quantity: 1 }] });
  assert.strictEqual(b.titel, "Nieuwe bestelling € 89,50");
  assert.strictEqual(b.tekst, "Jan Jansen uit Utrecht\n2× Remschijf 180mm\nBinnenband 20x4.0");
});

test("bericht: buitenland en lange lijst", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ name: "Artikel " + i, quantity: 1 }));
  const b = bericht({ amount: 10, customerName: "Anna", shippingAddress: { city: "Gent", country: "BE" }, items });
  assert.match(b.tekst, /^Anna uit Gent, BE\n/);
  assert.match(b.tekst, /… en nog 2$/);
});

test("bericht: Deskna met aanbetaling", () => {
  const b = bericht({ winkel: "deskna", amount: 1299, customerName: "Piet", shippingAddress: { city: "Zwolle" },
    items: [{ name: "Zit-sta bureau (160x80 / Zwart)", quantity: 1 }], aanbetaald: 300, openBijLevering: 999 });
  assert.strictEqual(b.titel, "Nieuwe bestelling € 1299,00");
  assert.strictEqual(b.tekst, "Piet uit Zwolle\nZit-sta bureau (160x80 / Zwart)\nAanbetaald € 300,00, € 999,00 bij levering");
});

test("meldNieuwe doet niets zonder SEINTJE_URL", async () => {
  delete process.env.SEINTJE_URL;
  assert.deepStrictEqual(await meldNieuwe([{ id: "x", betaald: true }]), { overgeslagen: "SEINTJE_URL ontbreekt" });
});
