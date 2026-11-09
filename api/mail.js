const { bewaak, eenOrder, maakMail, verstuur, logMail } = require("./_lib");

// Mail naar de klant van één order: bevestiging, verzendbericht of een eigen bericht.
// Met voorbeeld: true wordt er niets verstuurd en krijg je de mail terug om te bekijken.
module.exports = async (req, res) => {
  if (!bewaak(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ fout: "Niet toegestaan" });
  try {
    const { id, soort, onderwerp, tekst, voorbeeld } = req.body || {};
    const o = typeof id === "string" ? await eenOrder(id) : null;
    if (!o) return res.status(404).json({ fout: "Order niet gevonden" });
    const mail = maakMail(o, soort, { onderwerp, tekst });
    if (voorbeeld) return res.status(200).json({ aan: mail.aan, onderwerp: mail.onderwerp, html: mail.html });
    await verstuur(mail);
    await logMail(id, { soort, aan: mail.aan, onderwerp: mail.onderwerp });
    res.status(200).json({ order: await eenOrder(id) });
  } catch (e) {
    res.status(400).json({ fout: e.message || "Mail versturen mislukt" });
  }
};
