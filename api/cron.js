const seintje = require("./_seintje");
const { DAG, kv, opslagAan, alleOrdersMetMeldingen, mailAan, verstuur, maakMail, meldingMail, logMail, geldigAdres, ingelogd, WINKELS, winkelVan } = require("./_lib");

// Loopt elke minuut: stuurt een pushmelding (Seintje) en bij elke nieuwe betaalde bestelling één keer een
// bevestiging naar de klant (en een melding naar MAIL_MELDINGEN als die is gezet).
//
// Veiligheid tegen ongewenste mail:
// - alleen voor winkels waar mailen aan staat én de automatische bevestiging aan staat
//   (Fatbikehulp standaard aan, Deskna alleen met DESKNA_AUTO_BEVESTIGING=1);
// - bestellingen van vóór het moment dat de CRM voor het eerst liep krijgen niets;
// - alleen bestellingen die in de afgelopen 2 dagen zijn betaald;
// - per order wordt eerst vastgelegd dat hij aan de beurt is (HSETNX), dus nooit dubbel.
module.exports = async (req, res) => {
  const geheim = process.env.CRON_SECRET || "";
  const mag = (geheim && req.headers.authorization === "Bearer " + geheim) || ingelogd(req);
  if (!mag) return res.status(401).json({ fout: "Niet toegestaan" });
  if (!opslagAan()) return res.status(200).json({ overgeslagen: "opslag niet gekoppeld" });
  try {
    await kv("SETNX", "crm:start", new Date().toISOString());
    const start = Date.parse(await kv("GET", "crm:start"));
    const automatisch = (winkel) => mailAan(winkel) && WINKELS[winkel].autoBevestiging();

    const nu = Date.now();
    const { orders, meldingen, archief } = await alleOrdersMetMeldingen();
    // Pushmelding op de iPhone (Seintje), los van de mail; mag nooit de ronde breken.
    let push;
    try { push = await seintje.meldNieuwe(orders); } catch (e) { push = { fout: e.message }; }
    if (push && (push.gemeld || []).length) console.log("cron: seintje " + push.gemeld.join(", "));
    if (!Object.keys(WINKELS).some(automatisch)) return res.status(200).json({ overgeslagen: "mail staat uit", push, start: new Date(start).toISOString() });
    // Eén regel in het logboek per ronde (alleen aantallen): zo is te zien dat alle winkels binnenkomen.
    const aantallen = {};
    for (const o of orders) aantallen[winkelVan(o)] = (aantallen[winkelVan(o)] || 0) + 1;
    console.log("cron: bestellingen per winkel " + JSON.stringify(aantallen) + " | archief " + JSON.stringify(archief) + (meldingen.length ? " | storing: " + meldingen.join("; ") : ""));
    const verstuurd = [], mislukt = [];
    for (const o of orders) {
      // Orders uit het oude CRM zijn al lang afgehandeld: nooit automatisch mailen.
      if (o.bron === "archief") continue;
      if (!o.betaald) continue;
      if (!automatisch(winkelVan(o))) continue;
      const t = Date.parse(o.paidAt || o.createdAt || "");
      if (!t || t < start || nu - t > 2 * DAG) continue;
      if ((await kv("HSETNX", "crm:bevestigd", o.id, new Date().toISOString())) !== 1) continue;
      try {
        await verstuur(maakMail(o, "bevestiging"));
        await logMail(o.id, { soort: "bevestiging", aan: o.customerEmail, automatisch: true });
        verstuurd.push(o.id);
      } catch (e) {
        // Vrijgeven, zodat de volgende ronde het opnieuw probeert (tot 2 dagen na betaling).
        await kv("HDEL", "crm:bevestigd", o.id);
        mislukt.push({ id: o.id, fout: e.message });
        continue;
      }
      const meld = process.env.MAIL_MELDINGEN || "";
      if (geldigAdres(meld)) { try { await verstuur(meldingMail(o, meld)); } catch (e) { /* melding is bijzaak */ } }
    }
    res.status(200).json({ verstuurd, mislukt, aantallen, archief, meldingen, push });
  } catch (e) {
    res.status(500).json({ fout: e.message });
  }
};
