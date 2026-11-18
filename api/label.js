const { bewaak, eenOrder, logboek } = require("./_lib");
const label = require("./_label");

// DHL-label voor één order.
//  Scherm (ingelogd):  GET = alle labelopdrachten, GET ?pdf=<order>&label=<label> = het label zelf,
//                      GET ?print=<id> = hoe ver een printopdracht is,
//                      POST = label aanvragen, POST { print: <order>, label } = printen op de labelprinter,
//                      DELETE ?id= = annuleren.
//  Bot (Authorization: Bearer LABEL_BOT_SLEUTEL):  GET = opdrachten ophalen, GET ?pdf=&label= = het label,
//                      PUT = voortgang melden (PUT { print: <id>, status } voor een printopdracht).
function stuurPdf(res, pdf, orderId) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="dhl-label-' + String(orderId).replace(/[^\w-]/g, "_") + '.pdf"');
  res.statusCode = 200;
  res.end(pdf);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  try {
    if (label.isBot(req)) {
      if (req.method === "GET" && q.pdf) {
        const pdf = await label.leesPdf(String(q.pdf), String(q.label || ""));
        return pdf ? stuurPdf(res, pdf, q.pdf) : res.status(404).json({ fout: "Label niet gevonden" });
      }
      if (req.method === "GET") return res.status(200).json(await label.voorBot());
      if (req.method === "PUT" && req.body && req.body.print) return res.status(200).json({ print: await label.meldPrint(req.body) });
      if (req.method === "PUT") return res.status(200).json({ label: await label.meld(req.body) });
      return res.status(405).json({ fout: "Niet toegestaan" });
    }
    if (!bewaak(req, res)) return;
    // ?pdf=<order>&label=<label> geeft het label zelf, om te openen en te printen.
    if (req.method === "GET" && q.pdf) {
      const pdf = await label.leesPdf(String(q.pdf), String(q.label || ""));
      if (!pdf) return res.status(404).json({ fout: "Dit label is niet bewaard. Kijk in de mail van DHL." });
      await logboek(String(q.pdf), "DHL-label geopend");
      return stuurPdf(res, pdf, q.pdf);
    }
    if (req.method === "GET" && q.print) {
      const p = await label.leesPrint(q.print);
      return p ? res.status(200).json({ print: p }) : res.status(404).json({ fout: "Printopdracht niet gevonden" });
    }
    if (req.method === "GET") return res.status(200).json({ aan: label.labelsAan(), labels: await label.alle(), formaten: label.FORMATEN, bezorging: label.BEZORGING });
    if (req.method === "POST" && req.body && req.body.print) {
      return res.status(200).json({ print: await label.vraagPrint(String(req.body.print), String(req.body.label || "")) });
    }
    if (req.method === "POST") {
      const { id, formaat, bezorging, nietBijBuren } = req.body || {};
      const o = typeof id === "string" ? await eenOrder(id) : null;
      if (!o) return res.status(404).json({ fout: "Order niet gevonden" });
      return res.status(200).json({ label: await label.vraagAan(o, { formaat, bezorging, nietBijBuren }) });
    }
    if (req.method === "DELETE") {
      const id = String(q.id || "");
      if (!id) return res.status(400).json({ fout: "Order ontbreekt" });
      return res.status(200).json({ label: await label.annuleer(id) });
    }
    res.status(405).json({ fout: "Niet toegestaan" });
  } catch (e) {
    res.status(e.status || 400).json({ fout: e.message || "Er ging iets mis" });
  }
};
