const { bewaak, eenOrder } = require("./_lib");
const label = require("./_label");

// DHL-label voor één order.
//  Scherm (ingelogd):  GET = alle labelopdrachten, GET ?pdf=<order> = het label zelf,
//                      POST = label aanvragen, DELETE ?id= = annuleren.
//  Bot (Authorization: Bearer LABEL_BOT_SLEUTEL):  GET = opdrachten ophalen, PUT = voortgang melden.
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (label.isBot(req)) {
      if (req.method === "GET") return res.status(200).json(await label.voorBot());
      if (req.method === "PUT") return res.status(200).json({ label: await label.meld(req.body) });
      return res.status(405).json({ fout: "Niet toegestaan" });
    }
    if (!bewaak(req, res)) return;
    // ?pdf=<order> geeft het label zelf, om te openen en te printen.
    if (req.method === "GET" && req.query && req.query.pdf) {
      const pdf = await label.leesPdf(String(req.query.pdf));
      if (!pdf) return res.status(404).json({ fout: "Dit label is niet (meer) bewaard. Kijk in de mail van DHL." });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="dhl-label-' + String(req.query.pdf).replace(/[^\w-]/g, "_") + '.pdf"');
      res.statusCode = 200;
      return res.end(pdf);
    }
    if (req.method === "GET") return res.status(200).json({ aan: label.labelsAan(), labels: await label.alle(), formaten: label.FORMATEN, bezorging: label.BEZORGING });
    if (req.method === "POST") {
      const { id, formaat, bezorging, nietBijBuren } = req.body || {};
      const o = typeof id === "string" ? await eenOrder(id) : null;
      if (!o) return res.status(404).json({ fout: "Order niet gevonden" });
      return res.status(200).json({ label: await label.vraagAan(o, { formaat, bezorging, nietBijBuren }) });
    }
    if (req.method === "DELETE") {
      const id = String((req.query && req.query.id) || "");
      if (!id) return res.status(400).json({ fout: "Order ontbreekt" });
      return res.status(200).json({ label: await label.annuleer(id) });
    }
    res.status(405).json({ fout: "Niet toegestaan" });
  } catch (e) {
    res.status(e.status || 400).json({ fout: e.message || "Er ging iets mis" });
  }
};
