// api/admin/import.js
import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import * as XLSX from "xlsx";

export const config = {
  api: { bodyParser: false }, // required for formidable
};

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function cleanDigits(v) {
  return String(v ?? "").replace(/\D+/g, "");
}

function padPostnumr4(v) {
  const d = cleanDigits(v);
  if (!d) return "";
  // Norway postnummer = 4 digits. If Excel gave 3 digits, pad left with 0.
  return d.padStart(4, "0").slice(0, 4);
}

function normalizeHeaderKey(k) {
  return String(k ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[._-]/g, "");
}

function pickField(obj, candidates) {
  const keys = Object.keys(obj);
  for (const c of candidates) {
    const nc = normalizeHeaderKey(c);
    const hit = keys.find((k) => normalizeHeaderKey(k) === nc);
    if (hit !== undefined) return obj[hit];
  }
  return undefined;
}

function buildRowsFromXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });

  const dataSheetName =
    wb.SheetNames.find((n) => String(n).trim().toLowerCase() === "data") ||
    wb.SheetNames[0];

  const sheet = wb.Sheets[dataSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const out = [];
  for (const r of rows) {
    const postnumr = padPostnumr4(
      pickField(r, ["Postnumr", "Postnummer", "Postnr", "Postkode"])
    );

    const gate = String(
      pickField(r, ["Gate/vei", "Gate", "Vei", "Adresse", "Gatevei"]) ?? ""
    ).trim();

    const husnumr = String(
      pickField(r, ["Husnumr", "Husnummer", "Husnr"]) ?? ""
    ).trim();

    const sted = String(
      pickField(r, ["Sted", "By", "Poststed"]) ?? ""
    ).trim();

    const avfall_code = cleanDigits(
      pickField(r, ["Avfall", "Fraksjon", "Avfallskode", "Avfall_code"])
    );

    const ukedag = Number(
      cleanDigits(pickField(r, ["Ukedag", "UkeDag", "Dag"])) || 0
    );

    // skip empty rows
    if (!postnumr && !gate && !husnumr && !sted && !avfall_code) continue;

    const post_prefix3 = postnumr ? postnumr.slice(0, 3) : "";

    // stable key for upsert
    // (include ukedag if you want separate rows per weekday; if not, remove ukedag from key)
    const key = [
      postnumr,
      gate.toLowerCase(),
      husnumr.toLowerCase(),
      sted.toLowerCase(),
      avfall_code,
      String(ukedag || 0),
    ].join("|");

    out.push({
      key,
      postnumr,
      post_prefix3,
      sted,
      gate,
      husnumr,
      avfall_code,
      ukedag, // if your table doesn't have this column, we auto-fallback later
    });
  }

  return { sheetName: dataSheetName, rows: out };
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      maxFileSize: 25 * 1024 * 1024, // 25MB
    });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

async function readUploadedFileBuffer(fileObj) {
  const fs = await import("fs/promises");
  const path = fileObj?.filepath;
  if (!path) throw new Error("No filepath on uploaded file");
  return fs.readFile(path);
}

async function upsertChunk(supabase, chunk) {
  // 1) try with ukedag
  let { data, error } = await supabase
    .from("addresses")
    .upsert(chunk, { onConflict: "key" })
    .select("key");

  if (!error) return { data, usedUkedag: true };

  // 2) if ukedag column doesn't exist, retry without it
  const msg = String(error?.message || error);
  if (msg.toLowerCase().includes("column") && msg.toLowerCase().includes("ukedag")) {
    const chunk2 = chunk.map(({ ukedag, ...rest }) => rest);
    const r2 = await supabase
      .from("addresses")
      .upsert(chunk2, { onConflict: "key" })
      .select("key");
    if (r2.error) throw r2.error;
    return { data: r2.data, usedUkedag: false };
  }

  // other errors -> throw
  throw error;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return json(res, 200, {
        ok: true,
        message:
          "API is alive. Use POST multipart/form-data with field name: file (optionally dryRun=1).",
        env: {
          SUPABASE_URL: !!process.env.SUPABASE_URL,
          SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
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
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const { fields, files } = await parseMultipart(req);
    const dryRun = String(fields?.dryRun ?? "").trim() === "1";

    const file = files?.file;
    if (!file) {
      return json(res, 400, {
        ok: false,
        error: "No file uploaded. Use field name 'file'.",
      });
    }

    const buf = await readUploadedFileBuffer(file);
    const { sheetName, rows } = buildRowsFromXlsx(buf);

    if (rows.length === 0) {
      return json(res, 400, {
        ok: false,
        error: "No rows parsed from Excel (check columns / sheet).",
      });
    }

    if (dryRun) {
      return json(res, 200, {
        ok: true,
        dryRun: true,
        sheetName,
        parsedRows: rows.length,
        sample: rows.slice(0, 3),
      });
    }

    const chunkSize = 1000;
    let upserted = 0;
    let usedUkedag = null;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const r = await upsertChunk(supabase, chunk);
      upserted += r.data?.length ?? 0;
      if (usedUkedag === null) usedUkedag = r.usedUkedag;
    }

    return json(res, 200, {
      ok: true,
      sheetName,
      parsedRows: rows.length,
      upserted,
      note: usedUkedag === false
        ? "Upsert done WITHOUT ukedag (column not found in table)."
        : "Upsert done WITH ukedag.",
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
}
