// api/admin/import.js
import { createClient } from "@supabase/supabase-js";

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

function normStr(v) {
  return String(v ?? "").trim();
}

function makeKey(row) {
  // stabilus raktas upsert'ui
  const post = padPostnummer4(row.Postnummer || row.postnumr);
  const gate = normStr(row["Gate/vei"] || row.gate).toLowerCase();
  const hus = normStr(row.Husnummer || row.husnumr).toLowerCase();
  const sted = normStr(row.Sted || row.sted).toLowerCase();
  const avfall = cleanDigits(row.Avfall || row.avfall_code);
  const ukedag = Number(cleanDigits(row.Ukedag || row.ukedag) || 0);
  return [post, gate, hus, sted, avfall, ukedag].join("|");
}

function normalizeIncomingRows(rows) {
  const out = [];

  for (const r of rows || []) {
    const Postnummer = padPostnummer4(r.Postnummer ?? r.postnumr);
    const Sted = normStr(r.Sted ?? r.sted);
    const GateVei = normStr(r["Gate/vei"] ?? r.gate);
    const Husnummer = normStr(r.Husnummer ?? r.husnumr);
    const Avfall = cleanDigits(r.Avfall ?? r.avfall_code);
    const Ukedag = Number(cleanDigits(r.Ukedag ?? r.ukedag) || 0);

    // praleidžiam tuščias / neteisingas eilutes
    if (!Postnummer || !Sted || !GateVei || !Avfall) continue;
    if (!(Ukedag >= 1 && Ukedag <= 7)) continue;

    const post_prefix3 = Postnummer.slice(0, 3);

    // papildomi laukai iš Excel (jei yra)
    const Rute = normStr(r.Rute);
    const Sekvens = normStr(r.Sekvens);
    const Kunde = normStr(r.Kunde);
    const Navn = normStr(r.Navn);
    const BetegnelseTeknPl = normStr(r["Betegnelse tekn. pl."]);
    const UkentligIntervall = normStr(r["Ukentlig intervall"]);
    const AntallBeholdere = normStr(r["Antall beholdere"]);
    const Beholdertype = normStr(r.Beholdertype);

    const row = {
      // privalomi mūsų DB logikai:
      key: makeKey({
        Postnummer,
        "Gate/vei": GateVei,
        Husnummer,
        Sted,
        Avfall,
        Ukedag,
      }),
      post_prefix3,

      // originalūs stulpeliai (pagal tavo reikalavimą):
      Rute,
      Sekvens,
      Kunde,
      Navn,
      "Betegnelse tekn. pl.": BetegnelseTeknPl,
      "Gate/vei": GateVei,
      Husnummer,
      Sted,
      Postnummer,
      "Ukentlig intervall": UkentligIntervall,
      "Antall beholdere": AntallBeholdere,
      Beholdertype,
      Avfall,
      Ukedag,
    };

    out.push(row);
  }

  return out;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return json(res, 200, {
        ok: true,
        message: "POST JSON: { rows: [...] } to import into Supabase.",
        env: {
          SUPABASE_URL: !!process.env.SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
      });
    }

    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return json(res, 500, {
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel env",
      });
    }

    // bodyParser turi būti įjungtas šitam endpointui (jei pas tave globaliai išjungtas, pasakyk)
    const body = req.body || {};
    const incoming = Array.isArray(body.rows) ? body.rows : [];

    if (!incoming.length) {
      return json(res, 400, { ok: false, error: "No rows in request body" });
    }

    const rows = normalizeIncomingRows(incoming);
    if (!rows.length) {
      return json(res, 400, {
        ok: false,
        error: "0 valid rows after normalization (check headers/values).",
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const chunkSize = 1000;
    let upserted = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);

      const { data, error } = await supabase
        .from("adresai") // <-- jei tavo lentelė vadinasi kitaip, pakeisk čia
        .upsert(chunk, { onConflict: "key" })
        .select("key");

      if (error) throw error;
      upserted += data?.length ?? 0;
    }

    return json(res, 200, {
      ok: true,
      parsedRows: incoming.length,
      validRows: rows.length,
      upserted,
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
}
