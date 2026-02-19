// api/admin/import.js
import { createClient } from "@supabase/supabase-js";
import formidable from "formidable";
import * as XLSX from "xlsx";

export const config = {
  api: {
    bodyParser: false, // required for formidable
  },
};

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function cleanDigits(v) {
  return String(v ?? "").replace(/\D+/g, "");
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
    const postnumr = cleanDigits(
      pickField(r, ["Postnumr", "Postnummer", "Postnr", "Postkode"])
    );
    const gate = String(
      pickField(r, ["Gate/vei", "Gate", "Vei", "Adresse", "Gatevei"]) ?? ""
    ).trim();
    const husnumr = String(
      pickField(r, ["Husnumr", "Husnummer", "Husnr"]) ?? ""
    ).trim();
    const sted = String(pickField(r, ["Sted", "By", "Poststed"]) ?? "").trim();
    const avfall = cleanDigits(pickField(r, ["Avfall", "Fraksjon", "Avfallskode"]));
    const ukedag = Number(cleanDigits(pickField(r, ["Ukedag", "UkeDag", "Dag"])) || 0);

    if (!postnumr && !gate && !husnumr && !sted) continue;

    // stable key (so we can upsert)
    const key = `${postnumr}|${gate.toLowerCase()}|${husnumr.toLowerCase()}|${sted.toLowerCase()}|${avfall}`;

    out.push({
      key,                 // unique key
      postnumr,
      postprefix3: postnumr ? postnumr.slice(0, 3) : "",
      gate,
      husnumr,
      sted,
      avfall,
      ukedag,
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
  // formidable v2/v3: fileObj.filepath
  const fs = await import("fs/promises");
  const path = fileObj?.filepath;
  if (!path) throw new Error("No filepath on uploaded file");
  return fs.readFile(path);
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return json(res, 200, {
        ok: true,
        message: "API is alive. Use POST multipart/form-data with field name: file",
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
      return json(res, 500, { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
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
      return json(res, 400, { ok: false, error: "No file uploaded. Use field name 'file'." });
    }

    const buf = await readUploadedFileBuffer(file);
    const { sheetName, rows } = buildRowsFromXlsx(buf);

    if (rows.length === 0) {
      return json(res, 400, { ok: false, error: "No rows parsed from Excel (check columns / sheet)." });
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

    // IMPORTANT: create table "addresses" with unique key on "key"
    // Upsert in chunks to avoid payload limits
    const chunkSize = 1000;
    let upserted = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error, data } = await supabase
        .from("addresses")
        .upsert(chunk, { onConflict: "key" })
        .select("key");

      if (error) throw error;
      upserted += data?.length ?? 0;
    }

    return json(res, 200, {
      ok: true,
      sheetName,
      parsedRows: rows.length,
      upserted,
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
}
