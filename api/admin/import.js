import { createClient } from "@supabase/supabase-js";

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE) {
      return res.status(500).json({ error: "Missing env vars in Vercel" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    // 1) Verify user from JWT (use anon client)
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: userErr } = await anon.auth.getUser();
    if (userErr || !userData?.user) return res.status(401).json({ error: "Invalid token" });

    const userId = userData.user.id;

    // 2) Admin check + upsert using service role
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: prof, error: profErr } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", userId)
      .single();

    if (profErr || prof?.role !== "admin") {
      return res.status(403).json({ error: "Forbidden: admin only" });
    }

    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "rows[] is empty" });

    // basic validation
    for (const r of rows) {
      if (!r.postnumr || !r.post_prefix3 || !r.sted || !r.gate || !r.avfall_code) {
        return res.status(400).json({ error: "Invalid row shape (missing fields)" });
      }
      if (!(Number(r.ukedag) >= 1 && Number(r.ukedag) <= 7)) {
        return res.status(400).json({ error: "Invalid ukedag" });
      }
    }

    // chunk upserts to avoid payload/timeouts
    const parts = chunk(rows, 500);
    let upserted = 0;

    for (const part of parts) {
      const { error: upErr } = await admin
        .from("addresses")
        .upsert(part, {
          onConflict: "postnumr,sted,gate,husnumr,avfall_code,ukedag"
        });

      if (upErr) return res.status(500).json({ error: upErr.message });
      upserted += part.length;
    }

    return res.status(200).json({ ok: true, upserted, chunks: parts.length });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
