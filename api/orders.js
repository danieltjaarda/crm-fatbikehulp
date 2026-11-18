const { bewaak, alleOrdersMetMeldingen, eenOrder, pasAan, winkelInfo, opslagAan, logboek, leesLog, verschillen } = require("./_lib");

module.exports = async (req, res) => {
  if (!bewaak(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    // ?log=<order> geeft het logboek van één order
    if (req.method === "GET" && req.query && req.query.log) return res.status(200).json({ log: await leesLog(String(req.query.log)) });
    if (req.method === "GET") {
      const { orders, meldingen } = await alleOrdersMetMeldingen();
      return res.status(200).json({ orders, meldingen, winkels: winkelInfo(), opslagAan: opslagAan() });
    }
    if (req.method === "PUT") {
      const { id, wijzigingen } = req.body || {};
      if (typeof id !== "string" || !id) return res.status(400).json({ fout: "Order ontbreekt" });
      const voor = await eenOrder(id);
      if (!voor) return res.status(404).json({ fout: "Order niet gevonden" });
      await pasAan(id, wijzigingen);
      const na = await eenOrder(id);
      // Elke wijziging komt met de oude en de nieuwe waarde in het logboek.
      for (const regel of verschillen(voor, na)) await logboek(id, regel);
      return res.status(200).json({ order: na });
    }
    res.status(405).json({ fout: "Niet toegestaan" });
  } catch (e) {
    res.status(500).json({ fout: e.message || "Er ging iets mis" });
  }
};
