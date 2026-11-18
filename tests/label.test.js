const test = require("node:test");
const assert = require("node:assert");
process.env.CRM_GEHEIM = "test-geheim"; process.env.CRM_WACHTWOORD = "juist";
process.env.CRM_ARCHIEF_BESTAND = require("node:path").join(__dirname, "fixtures", "archief-leeg.json");
process.env.KV_REST_API_URL = "http://opslag.test"; process.env.KV_REST_API_TOKEN = "t";
process.env.LABEL_BOT_SLEUTEL = "bot-sleutel-van-minstens-24-tekens";
process.env.SEINTJE_URL = "http://seintje.test/in/sleutel";

process.env.MAIL_WACHTWOORD = "mailwachtwoord";

// Opslag, Seintje en de mailserver nagebootst in het geheugen.
const opslag = {};
const pushes = [], mails = [];
global.fetch = async (url, opties) => {
  const body = JSON.parse(opties.body);
  if (String(url).startsWith("http://seintje.test")) { pushes.push(body); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  if (String(url).startsWith("https://api.forwardemail.net")) { mails.push(body); return { ok: true, status: 200, json: async () => ({ id: "m1" }) }; }
  const [cmd, sleutel, veld, waarde] = body;
  const h = (opslag[sleutel] = opslag[sleutel] || {});
  let result = null;
  if (cmd === "HSET") { h[veld] = waarde; result = 1; }
  else if (cmd === "HGET") result = h[veld] === undefined ? null : h[veld];
  else if (cmd === "HGETALL") result = Object.entries(h).flat();
  else if (cmd === "SET") { opslag[sleutel] = veld; result = "OK"; }
  else if (cmd === "GET") result = typeof opslag[sleutel] === "string" ? opslag[sleutel] : null;
  else if (cmd === "RPUSH") { (opslag[sleutel] = Array.isArray(opslag[sleutel]) ? opslag[sleutel] : []).push(veld); result = opslag[sleutel].length; }
  else if (cmd === "LRANGE") result = Array.isArray(opslag[sleutel]) ? opslag[sleutel] : [];
  else throw new Error("onbekend opslagcommando " + cmd);
  return { ok: true, status: 200, json: async () => ({ result }) };
};
const label = require("../api/_label");
const lib = require("../api/_lib");
const logTeksten = async (id) => (await lib.leesLog(id)).map((r) => r.tekst);

const order =(extra) => ({ id: "ORD-1", customerName: "Jan de Vries", customerEmail: "jan@example.com", shippingAddress: { street: "Dorpsstraat", houseNumber: "12a", postalCode: "8501 ab", city: "Joure", country: "NL" }, ...extra });
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
  opslag.orders = JSON.stringify([{ ...order(), amount: 20, status: "betaald", items: [{ name: "Binnenband", quantity: 1, price: 20 }] }]);
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

  const pdf = Buffer.from("%PDF-1.4 proeflabel");
  const k = await label.meld({ orderId: "ORD-1", id: op.id, status: "klaar", trackTrace: "JVGL0612345678", labelPdf: pdf.toString("base64") });
  assert.strictEqual(k.status, "klaar"); assert.strictEqual(k.betaalUrl, undefined);
  assert.strictEqual(k.heeftPdf, true, "het label is bewaard"); assert.strictEqual(k.pdfId, op.id);
  assert.deepStrictEqual(await label.leesPdf("ORD-1", op.id), pdf);
  assert.strictEqual(await label.leesPdf("ORD-1", "een-ander-label"), null);
  assert.strictEqual(await label.bewaarPdf("ORD-2", "label-0001", Buffer.from("<html>geen pdf").toString("base64")), false, "alleen een echte pdf wordt bewaard");
  // De order gaat op Verzonden en de klant krijgt één keer het verzendbericht met de volglink.
  const w = JSON.parse(opslag["crm:orders"]["ORD-1"]);
  assert.strictEqual(w.trackTrace, "JVGL0612345678"); assert.strictEqual(w.verzendstatus, "verzonden");
  assert.strictEqual(k.klantMail, "verstuurd"); assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, "jan@example.com"); assert.match(mails[0].html, /tracktrace\/JVGL0612345678\/8501AB/);
  assert.strictEqual(w.mails[0].soort, "verzonden"); assert.strictEqual(w.mails[0].automatisch, true);
  assert.strictEqual(await label.mailKlant("ORD-1"), "had al een verzendbericht");
  assert.match(pushes[1].titel, /klaar/); assert.match(pushes[1].tekst, /verzendbericht gekregen/);
  await assert.rejects(label.meld({ orderId: "ORD-1", id: op.id, status: "mislukt" }), /al klaar/);
  // Alles staat in het logboek, in volgorde.
  const log = await lib.leesLog("ORD-1");
  assert.deepStrictEqual(log.map((r) => r.tekst), [
    "DHL-label aangevraagd: Pakket tot 5 kg, thuisbezorgen, naar 8501AB 12 a",
    "DHL-formulier ingevuld, betaallink van € 6,55 naar de telefoon gestuurd",
    "DHL-label betaald en gemaakt (Pakket tot 5 kg, thuisbezorgen, € 6,55), volgcode JVGL0612345678",
    "Volgcode JVGL0612345678 ingevuld en status op Verzonden gezet",
    "Verzendbericht gemaild naar jan@example.com"
  ]);
  assert.strictEqual(log[2].pdf, op.id); assert.strictEqual(log[2].door, "bot"); assert.strictEqual(log[4].door, "automatisch");
  // Daarna mag er een nieuw label voor dezelfde order worden gemaakt; het eerste label blijft bewaard.
  assert.strictEqual((await label.vraagAan(order(), { formaat: "XSMALL", bezorging: "punt" })).status, "wacht");
  assert.deepStrictEqual(await label.leesPdf("ORD-1", op.id), pdf);
});

test("zonder volgcode: geen status Verzonden en geen mail naar de klant", async () => {
  opslag.orders = JSON.stringify([{ ...order({ id: "ORD-9" }), amount: 20, status: "betaald" }]);
  await label.vraagAan(order({ id: "ORD-9" }), { formaat: "SMALL" });
  const op = (await label.voorBot()).opdrachten.find((x) => x.orderId === "ORD-9");
  await label.meld({ orderId: "ORD-9", id: op.id, status: "betalen", betaalUrl: "https://my.dhlecommerce.nl/payment/start?paymentId=x", bedrag: 6.55 });
  const voor = mails.length;
  const k = await label.meld({ orderId: "ORD-9", id: op.id, status: "klaar", trackTrace: "" });
  assert.strictEqual(k.klantMail, "geen volgcode"); assert.strictEqual(mails.length, voor);
  assert.strictEqual((opslag["crm:orders"] || {})["ORD-9"], undefined);
  assert.match((await logTeksten("ORD-9")).pop(), /met de hand/);
});

test("logboek: wijzigingen met oude en nieuwe waarde", () => {
  const voor = { betaald: true, trackTrace: "", customerName: "Jan", notitie: "", shippingAddress: { city: "Joure", postalCode: "8501AB" } };
  const na = { verzendstatus: "verzonden", trackTrace: "JVGL1", customerName: "Jan", notitie: "bellen", verborgen: true, shippingAddress: { city: "Sneek", postalCode: "8501AB" } };
  assert.deepStrictEqual(lib.verschillen(voor, na), ["Status: Te verzenden → Verzonden", "Volgcode: leeg → JVGL1", "Plaats: Joure → Sneek", "Notitie aangepast", "Verborgen uit de lijst"]);
  assert.deepStrictEqual(lib.verschillen(voor, voor), []);
});

test("annuleren stopt een lopend label; stilgevallen opdrachten verlopen", async () => {
  assert.strictEqual((await label.annuleer("ORD-1")).status, "geannuleerd");
  assert.match((await logTeksten("ORD-1")).pop(), /geannuleerd/);
  assert.deepStrictEqual(await label.voorBot(), { opdrachten: [], wachtOpBetaling: [] });
  const oud = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.strictEqual(label.metVerloop({ status: "betalen", bijgewerkt: oud }).status, "verlopen");
  assert.strictEqual(label.metVerloop({ status: "bezig", bijgewerkt: oud }).status, "mislukt");
  assert.strictEqual(label.metVerloop({ status: "klaar", bijgewerkt: oud }).status, "klaar");
});
