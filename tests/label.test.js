const test = require("node:test");
const assert = require("node:assert");
process.env.CRM_GEHEIM = "test-geheim"; process.env.CRM_WACHTWOORD = "juist";
process.env.CRM_ARCHIEF_BESTAND = require("node:path").join(__dirname, "fixtures", "archief-leeg.json");
process.env.KV_REST_API_URL = "http://opslag.test"; process.env.KV_REST_API_TOKEN = "t";
process.env.LABEL_BOT_SLEUTEL = "bot-sleutel-van-minstens-24-tekens";
process.env.SEINTJE_URL = "http://seintje.test/in/sleutel";

// Opslag en Seintje nagebootst in het geheugen.
const opslag = {};
const pushes = [];
global.fetch = async (url, opties) => {
  const body = JSON.parse(opties.body);
  if (String(url).startsWith("http://seintje.test")) { pushes.push(body); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  const [cmd, sleutel, veld, waarde] = body;
  const h = (opslag[sleutel] = opslag[sleutel] || {});
  let result = null;
  if (cmd === "HSET") { h[veld] = waarde; result = 1; }
  else if (cmd === "HGET") result = h[veld] === undefined ? null : h[veld];
  else if (cmd === "HGETALL") result = Object.entries(h).flat();
  else throw new Error("onbekend opslagcommando " + cmd);
  return { ok: true, status: 200, json: async () => ({ result }) };
};
const label = require("../api/_label");

const order = (extra) => ({ id: "ORD-1", customerName: "Jan de Vries", customerEmail: "jan@example.com", shippingAddress: { street: "Dorpsstraat", houseNumber: "12a", postalCode: "8501 ab", city: "Joure", country: "NL" }, ...extra });
const bot = { headers: { authorization: "Bearer bot-sleutel-van-minstens-24-tekens" } };

test("ontvanger: naam, postcode en huisnummer met toevoeging", () => {
  assert.deepStrictEqual(label.ontvanger(order()), { voornaam: "Jan", achternaam: "de Vries", postcode: "8501AB", huisnummer: "12", toevoeging: "a", email: "jan@example.com" });
  assert.deepStrictEqual(label.splitsHuisnummer("7-2"), { nummer: "7", toevoeging: "2" });
  assert.strictEqual(label.splitsHuisnummer("twaalf"), null);
});
test("ontvanger: huisnummer achter de straat (Deskna) en één naam", () => {
  const o = label.ontvanger(order({ customerName: "Cher", shippingAddress: { street: "Lange Nieuwstraat 104 B", houseNumber: "", postalCode: "3512PN" } }));
  assert.strictEqual(o.huisnummer, "104"); assert.strictEqual(o.toevoeging, "B");
  assert.strictEqual(o.voornaam, "Cher"); assert.strictEqual(o.achternaam, "Cher");
});
test("ontvanger: buitenland, foute postcode en ontbrekend e-mailadres worden geweigerd", () => {
  assert.throws(() => label.ontvanger(order({ shippingAddress: { street: "Rue", houseNumber: "1", postalCode: "1000", country: "BE" } })), /Nederland/);
  assert.throws(() => label.ontvanger(order({ shippingAddress: { street: "A", houseNumber: "1", postalCode: "12 AB" } })), /postcode/);
  assert.throws(() => label.ontvanger(order({ shippingAddress: { street: "Dorpsstraat", houseNumber: "", postalCode: "8501AB" } })), /huisnummer/);
  assert.throws(() => label.ontvanger(order({ customerEmail: "" })), /e-mailadres/);
});
test("alleen de bot met de juiste sleutel komt erin", () => {
  assert.strictEqual(label.isBot(bot), true);
  assert.strictEqual(label.isBot({ headers: { authorization: "Bearer fout" } }), false);
  assert.strictEqual(label.isBot({ headers: {} }), false);
});

test("van aanvraag tot volgcode: bot pakt één keer op, betaallink gaat naar de telefoon, volgcode komt bij de order", async () => {
  await assert.rejects(label.vraagAan(order(), { formaat: "REUS" }), /formaat/);
  const j = await label.vraagAan(order(), { formaat: "SMALL", bezorging: "deur" });
  assert.strictEqual(j.status, "wacht"); assert.strictEqual(j.id, undefined); assert.strictEqual(j.ontvanger, undefined);
  await assert.rejects(label.vraagAan(order(), { formaat: "SMALL" }), /loopt al/);

  const werk = await label.voorBot();
  assert.strictEqual(werk.opdrachten.length, 1);
  const op = werk.opdrachten[0];
  assert.strictEqual(op.formaat, "SMALL"); assert.strictEqual(op.ontvanger.postcode, "8501AB");
  assert.strictEqual((await label.voorBot()).opdrachten.length, 0, "tweede keer niets meer op te pakken");
  assert.strictEqual((await label.alle())["ORD-1"].status, "bezig");

  await assert.rejects(label.meld({ orderId: "ORD-1", id: op.id, status: "betalen", betaalUrl: "https://nep.example/payment/1" }), /niet van DHL/);
  await assert.rejects(label.meld({ orderId: "ORD-1", id: "andere", status: "mislukt" }), /bestaat niet meer/);
  const link = "https://my.dhlecommerce.nl/payment/start?paymentId=abc";
  const b = await label.meld({ orderId: "ORD-1", id: op.id, status: "betalen", betaalUrl: link, bedrag: 6.55 });
  assert.strictEqual(b.status, "betalen"); assert.strictEqual(b.betaalUrl, link);
  assert.deepStrictEqual(pushes[0], { bron: "Fatbikehulp", titel: "DHL-label betalen € 6,55", tekst: "Pakket tot 5 kg voor Jan de Vries (ORD-1)\nTik om te betalen.", url: link, prioriteit: "hoog" });
  assert.deepStrictEqual((await label.voorBot()).wachtOpBetaling, [op.id]);

  const k = await label.meld({ orderId: "ORD-1", id: op.id, status: "klaar", trackTrace: "JVGL0612345678" });
  assert.strictEqual(k.status, "klaar"); assert.strictEqual(k.betaalUrl, undefined);
  assert.strictEqual(JSON.parse(opslag["crm:orders"]["ORD-1"]).trackTrace, "JVGL0612345678");
  assert.match(pushes[1].titel, /klaar/);
  await assert.rejects(label.meld({ orderId: "ORD-1", id: op.id, status: "mislukt" }), /al klaar/);
  // Daarna mag er een nieuw label voor dezelfde order worden gemaakt.
  assert.strictEqual((await label.vraagAan(order(), { formaat: "XSMALL", bezorging: "punt" })).status, "wacht");
});

test("annuleren stopt een lopend label; stilgevallen opdrachten verlopen", async () => {
  assert.strictEqual((await label.annuleer("ORD-1")).status, "geannuleerd");
  assert.deepStrictEqual(await label.voorBot(), { opdrachten: [], wachtOpBetaling: [] });
  const oud = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.strictEqual(label.metVerloop({ status: "betalen", bijgewerkt: oud }).status, "verlopen");
  assert.strictEqual(label.metVerloop({ status: "bezig", bijgewerkt: oud }).status, "mislukt");
  assert.strictEqual(label.metVerloop({ status: "klaar", bijgewerkt: oud }).status, "klaar");
});
