const { DAG, kv, opslagAan, alleOrders, mailAan, verstuur, maakMail, meldingMail, logMail, geldigAdres, ingelogd } = require("./_lib");

// Loopt elke 5 minuten: stuurt bij elke nieuwe betaalde bestelling één keer een
// bevestiging naar de klant (en een melding naar MAIL_MELDINGEN als die is gezet).
//
// Veiligheid tegen ongewenste mail:
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
    if (!mailAan()) return res.status(200).json({ overgeslagen: "mail staat uit", start: new Date(start).toISOString() });

    const nu = Date.now();
    const orders = await alleOrders();
    const verstuurd = [], mislukt = [];
    for (const o of orders) {
      if (!o.betaald) continue;
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
    res.status(200).json({ verstuurd, mislukt });
  } catch (e) {
    res.status(500).json({ fout: e.message });
  }
};
