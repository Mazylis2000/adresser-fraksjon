// api/admin/import.js
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function cleanDigits(v) {
  return String(v ?? "").replace(/\D+/g, "");
}

function padPostnummer4(v) {
  const d = cleanDigits(v);
  if (!d) return "";
  return d.padStart(4, "0").slice(0, 4);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function buildKey({ Postnummer, Sted, GateVei, Husnummer, Avfall, Ukedag }) {
  // stabilus key, kad upsert nerašytų dublikatų
  return [
    Postnummer,
    String(Sted || "").trim().toLowerCase(),
    String(GateVei || "").trim().toLowerCase(),
    String(Husnummer || "").trim().toLowerCase(),
    String(Avfall || ""),
    String(Ukedag || 0),
  ].join("|");
}

function mapRowsFromApp(rows) {
  // tikimasi, kad ateina iš app.js tokie laukai:
  // { postnumr, post_prefix3, sted, gate, husnumr, avfall_code, ukedag }
  const out = [];

  for (const r of rows || []) {
    const Postnummer = padPostnummer4(r.postnumr);
    const Sted = String(r.sted ?? "").trim();
    const GateVei = String(r.gate ?? "").trim();
    const Husnummer = String(r.husnumr ?? "").trim();
    const Avfall = cleanDigits(r.avfall_code);
    const Ukedag = Number(cleanDigits(r.ukedag) || 0);

    if (!Postnummer || !Sted || !GateVei || !Avfall) continue;
    if (!(Ukedag >= 1 && Ukedag <= 7)) continue;

    const post_prefix3 =
      (r.post_prefix3 ? cleanDigits(r.post_prefix3) : Postnummer.slice(0, 3)).slice(0, 3);

    const key = buildKey({ Postnummer, Sted, GateVei, Husnummer, Avfall, Ukedag });

    // ČIA svarbiausia: DB stulpelių pavadinimai
    out.push({
      key,
      post_prefix3,

      "Postnummer": Postnummer,
      "Sted": Sted,
      "Gate/vei": GateVei,
      "Husnummer": Husnummer || null,
      "Avfall": Avfall,
      "Ukedag": Ukedag,
    });
  }

  return out;
}

async function upsertInChunks(sb, rows, chunkSize = 1000) {
  let upserted = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);

    const { data, error } = await sb
      .from("adresai")
      .upsert(chunk, { onConflict: "key" })
      .select("key");

    if (error) throw error;
    upserted += (data?.length ?? 0);
  }

  return upserted;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return json(res, 200, {
        ok: true,
        message: "POST JSON: { rows:[...] } į /api/admin/import",
        env: {
          SUPABASE_URL: !!process.env.SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
      });
    }

    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("application/json")) {
      return json(res, 415, {
        ok: false,
        error: "Unsupported content-type. Send application/json.",
      });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return json(res, 500, {
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel env.",
      });
    }

    // (nebūtina, bet gerai turėti) – tikrinam, ar bent jau yra prisijungęs useris
    const auth = String(req.headers.authorization || "");
    if (!auth.toLowerCase().startsWith("bearer ")) {
      return json(res, 401, { ok: false, error: "Missing Authorization: Bearer <token>" });
    }

    const body = await readJsonBody(req);
    const dryRun = String(body?.dryRun ?? "").trim() === "1";

    const mapped = mapRowsFromApp(body?.rows || []);
    if (!mapped.length) {
      return json(res, 400, {
        ok: false,
        error: "0 valid rows after mapping. Check headers/data in Excel and parsing in app.js.",
      });
    }

    if (dryRun) {
      return json(res, 200, {
        ok: true,
        dryRun: true,
        parsedRows: mapped.length,
        sample: mapped.slice(0, 3),
      });
    }

    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const upserted = await upsertInChunks(sb, mapped, 1000);

    return json(res, 200, {
      ok: true,
      parsedRows: mapped.length,
      upserted,
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
}
