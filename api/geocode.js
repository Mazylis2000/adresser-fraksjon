export default async function handler(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const url =
      "https://nominatim.openstreetmap.org/search" +
      "?format=json&limit=1" +
      "&countrycodes=no" +
      "&addressdetails=1" +
      "&accept-language=no" +
      "&q=" +
      encodeURIComponent(q);

    const r = await fetch(url, {
      headers: {
        // Server-side čia galima:
        "User-Agent": "adresser-fraksjon/1.0 (vercel)",
        "Accept": "application/json",
      },
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(502).json({ error: `Nominatim ${r.status}`, detail: txt.slice(0, 200) });
    }

    const data = await r.json();
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ item: data?.[0] ?? null });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
