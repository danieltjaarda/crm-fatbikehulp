const { bewaak, alleOrders, eenOrder, pasAan, mailAan, mailVan, kaalAdres, opslagAan } = require("./_lib");

module.exports = async (req, res) => {
  if (!bewaak(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const orders = await alleOrders();
      return res.status(200).json({ orders, mailAan: mailAan(), afzender: kaalAdres(mailVan()), opslagAan: opslagAan() });
    }
    if (req.method === "PUT") {
      const { id, wijzigingen } = req.body || {};
      if (typeof id !== "string" || !id) return res.status(400).json({ fout: "Order ontbreekt" });
      if (!(await eenOrder(id))) return res.status(404).json({ fout: "Order niet gevonden" });
      await pasAan(id, wijzigingen);
      return res.status(200).json({ order: await eenOrder(id) });
    }
    res.status(405).json({ fout: "Niet toegestaan" });
  } catch (e) {
    res.status(500).json({ fout: e.message || "Er ging iets mis" });
  }
};
