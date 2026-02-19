import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    // 1) GET: status (kad naršyklėje matytum, jog viskas gyva)
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        message: "API is alive. Use POST to import.",
        env: {
          SUPABASE_URL: !!process.env.SUPABASE_URL,
          SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
          SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY
        }
      });
    }

    // 2) Tik POST leidžiam importui
    if (req.method !== "POST") {
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    // 3) (kol kas) paprastas testas: ar galim prisijungti prie Supabase
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel env vars."
      });
    }

    const supabase = createClient(url, serviceKey);

    // Minimalus DB testas (jei turi lentelę profiles / addresses dar nesvarbu)
    // Čia tiesiog grąžinam OK, kad POST pasiekė funkciją
    return res.status(200).json({
      ok: true,
      message: "POST received. Supabase client created OK.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
      stack: err?.stack || null
    });
  }
}
