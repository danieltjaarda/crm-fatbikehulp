const { wachtwoordKlopt, maakCookie, ingelogd } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ ingelogd: ingelogd(req) });
  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", "crm=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    return res.status(200).json({ ok: true });
  }
  if (req.method !== "POST") return res.status(405).json({ fout: "Niet toegestaan" });
  // Vaste vertraging: raden van het wachtwoord gaat hierdoor traag.
  await new Promise((r) => setTimeout(r, 700));
  if (!wachtwoordKlopt((req.body || {}).wachtwoord)) return res.status(401).json({ fout: "Wachtwoord klopt niet" });
  res.setHeader("Set-Cookie", maakCookie());
  res.status(200).json({ ok: true });
};
