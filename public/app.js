// app.js (CLEAN, for table: public.adresai)

// =========================
// CONFIG (fill these 2)
// =========================
const SUPABASE_URL = "https://dvwatiyiwpsrtdkbwkhj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_R-sBV_gQ6AO9yRXYt2a6dA_dgT-Yop8";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Grupė -> Avfall kodai (čia tu pildysi)
const FRAKSJON_CODES = {
  MAT: new Set(["111101", "111102"]),
  REST: new Set(["119901", "119911", "119912", "119902", "119903"]),
  PAPP: new Set(["122106", "122110", "125102"]),
  GLASSMET: new Set(["132201"]),
  PLAST: new Set(["171194"]),
  FPLASTFOLIE: new Set(["171103"]),
  KPLASTFOLIE: new Set(["171101"]),
};

window.addEventListener("load", async () => {
  // ---------- MAP ----------
  const map = L.map("map", { zoomControl: true }).setView([59.9139, 10.7522], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  let marker = null;
  const nearbyLayer = L.layerGroup().addTo(map);
  const geoCache = new Map();

  // ---------- UI helpers ----------
  const el = (id) => document.getElementById(id);
  const setText = (id, t) => (el(id).textContent = t);

  const dayNameNO = (d) =>
    ({
      1: "Mandag",
      2: "Tirsdag",
      3: "Onsdag",
      4: "Torsdag",
      5: "Fredag",
      6: "Lørdag",
      7: "Søndag",
    }[d] || null);

  function cleanDigits(s) {
    return String(s ?? "").replace(/\D+/g, "");
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function renderResult(text) {
    setText("resultText", text);
  }

  function showLogin(msg) {
    el("loginBox").classList.remove("hide");
    el("appBox").classList.add("hide");
    setText("loginMsg", msg || "Logg Inn.");
  }
  function showApp() {
    el("loginBox").classList.add("hide");
    el("appBox").classList.remove("hide");
  }

  async function refreshAuthUI() {
    const {
      data: { session },
    } = await sb.auth.getSession();

    if (!session) {
      setText("authStatus", "Auth: ikke logget inn");
      setText("roleStatus", "Role: -");
      el("adminBox").classList.add("hide");
      showLogin();
      return;
    }

    setText("authStatus", `Auth: ${session.user.email}`);

    // fetch role
    const { data: prof, error: perr } = await sb
      .from("profiles")
      .select("role")
      .eq("user_id", session.user.id)
      .single();

    const role = perr ? "user" : prof?.role || "user";
    setText("roleStatus", `Role: ${role}`);

    if (role === "admin") el("adminBox").classList.remove("hide");
    else el("adminBox").classList.add("hide");

    showApp();
  }

  // ---------- Auth actions ----------
  async function doLogin() {
    const email = (el("loginEmail").value || "").trim();
    const pass = (el("loginPass").value || "").trim();
    if (!email || !pass) return setText("loginMsg", "Įvesk email + password.");

    setText("loginMsg", "Logger inn…");
    const { error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) return setText("loginMsg", `Login error: ${error.message}`);
    await refreshAuthUI();
  }

  el("btnLogin").addEventListener("click", doLogin);

  ["loginEmail", "loginPass"].forEach((id) => {
    el(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doLogin();
      }
    });
  });

  el("btnLogout").addEventListener("click", async () => {
    await sb.auth.signOut();
    await refreshAuthUI();
  });

  // ---------- Geocode (Norway only) ----------
  async function geocode(query) {
    const q = `${query}, Norge`;

    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error("Geocode proxy error: " + res.status);

    const json = await res.json();
    return json?.item ?? null;
  }

  function markerTooltip(addr, daysArr) {
    const days = (daysArr || []).map(dayNameNO).filter(Boolean);
    return `<b>${addr}</b><br>Ukedag: ${days.length ? days.join(" / ") : "-"}`;
  }

  async function geocodeCached(key, query) {
    if (geoCache.has(key)) return geoCache.get(key);
    const g = await geocode(query);
    if (!g) return null;
    const p = { lat: Number(g.lat), lon: Number(g.lon) };
    geoCache.set(key, p);
    return p;
  }

  async function plotNearbyAddressesGrouped(rows, maxMarkers = 5) {
    nearbyLayer.clearLayers();
    if (!rows || rows.length === 0) return { plotted: 0, tried: 0 };

    const subset = rows.slice(0, Math.min(rows.length, 150));
    const byAddr = new Map(); // addr -> { days:Set }

    for (const r of subset) {
      const addr = `${r.gate} ${r.husnumr || ""}, ${r.postnumr} ${r.sted}`
        .replace(/\s+/g, " ")
        .trim();

      if (!byAddr.has(addr)) byAddr.set(addr, { days: new Set() });
      if (r.ukedag >= 1 && r.ukedag <= 7) byAddr.get(addr).days.add(r.ukedag);
    }

    const entries = Array.from(byAddr.entries()).slice(0, maxMarkers);
    let plotted = 0;

    for (const [addr, obj] of entries) {
      try {
        const key = addr.toLowerCase();
        const p = await geocodeCached(key, addr);
        if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
          const daysArr = Array.from(obj.days).sort((a, b) => a - b);
          L.circleMarker([p.lat, p.lon], {
            radius: 6,
            color: "rgba(239,68,68,0.75)",
            weight: 2,
            fillColor: "rgba(239,68,68,0.25)",
            fillOpacity: 0.25,
          })
            .bindTooltip(markerTooltip(addr, daysArr), { direction: "top" })
            .addTo(nearbyLayer);

          plotted++;
        }
      } catch (_) {}
      await sleep(1100); // Nominatim polite delay
    }

    return { plotted, tried: entries.length };
  }

  // ---------- Search from DB ----------
  function readForm() {
    return {
      postkode: cleanDigits(el("postkode").value).trim(),
      by: (el("by").value || "").trim(),
      adresse: (el("adresse").value || "").trim(),
      fraksjonGroup: (el("fraksjon").value || "").trim(),
      fraksjonLabel: el("fraksjon").selectedOptions?.[0]?.textContent || "",
    };
  }

  // Variant A: søker kun eksakt postkode (4 siffer) + avfall-koder
  async function findDaysForAreaFromDB(input) {
    if (!input.fraksjonGroup) return { ok: false, message: "Velg fraksjon først." };

    const post4 = cleanDigits(input.postkode).padStart(4, "0").slice(0, 4);
    if (post4.length !== 4 || post4 === "0000") {
      return { ok: false, message: "Postkode må være 4 siffer (f.eks. 0372)." };
    }

    const prefix3 = post4.slice(0, 3);

    const codes = FRAKSJON_CODES[input.fraksjonGroup];
    if (!codes || codes.size === 0) {
      return { ok: false, message: "Ingen fraksjon-koder satt i FRAKSJON_CODES." };
    }
    const codeArr = Array.from(codes);

    const { data, error } = await sb
      .from("adresai")
      .select('postnummer_txt, Sted, "Gate/vei", Husnummer, Avfall, Ukedag')
      .eq("postnummer_txt", post4)
      .in("Avfall", codeArr)
      .limit(5000);

    if (error) return { ok: false, message: `DB error: ${error.message}` };

    const wideRows = (data || []).map((r) => ({
      postnumr: String(r.postnummer_txt || "").trim(), // <-- 4 siffer fra tekstkolonnen
      sted: String(r.Sted || "").trim(),
      gate: String(r["Gate/vei"] || "").trim(),
      husnumr: String(r.Husnummer || "").trim(),
      avfall_code: String(r.Avfall || "").trim(),
      ukedag: Number(r.Ukedag || 0),
    }));

    const wideDays = Array.from(
      new Set(wideRows.map((r) => r.ukedag).filter((d) => d >= 1 && d <= 7))
    ).sort((a, b) => a - b);

    return { ok: true, prefix3, post4, wideRows, wideDays, count: wideRows.length };
  }

  // ---------- Buttons ----------
  el("btnClear").addEventListener("click", () => {
    el("postkode").value = "";
    el("by").value = "";
    el("adresse").value = "";
    el("fraksjon").value = "";
    if (marker) {
      marker.remove();
      marker = null;
    }
    nearbyLayer.clearLayers();
    map.setView([59.9139, 10.7522], 12);
    renderResult("Klar.");
  });

  el("btnSearch").addEventListener("click", async () => {
    const f = readForm();

    const post4 = cleanDigits(f.postkode).padStart(4, "0").slice(0, 4);
    const hasPost = post4.length === 4 && post4 !== "0000";

    // geocode query (fungerer også når man kun skriver postkode)
    const query = [f.adresse, hasPost ? post4 : null, f.by].filter(Boolean).join(", ");
    if (!query) return renderResult("Skriv minst postkode eller adresse.");

    renderResult("Geokoder adresse…");

    try {
      const g = await geocode(query);
      if (!g) return renderResult("Adressen ble ikke funnet i geokoder.");

      const lat = Number(g.lat),
        lon = Number(g.lon);

      if (marker) marker.remove();
      marker = L.marker([lat, lon]).addTo(map);
      map.setView([lat, lon], 15);

      const res = await findDaysForAreaFromDB({ ...f, postkode: hasPost ? post4 : f.postkode });

      // --- LOG SEARCH (search_logs) ---
      try {
        const {
          data: { session },
        } = await sb.auth.getSession();

        const codesSet = FRAKSJON_CODES[f.fraksjonGroup] || new Set();
        const avfall_codes = Array.from(codesSet);

        await sb.from("search_logs").insert([
          {
            user_id: session?.user?.id || null,
            postkode: hasPost ? post4 : (f.postkode || null),
            sted: f.by || null,
            adresse: f.adresse || null,
            fraksjon: f.fraksjonGroup || null,
            post_prefix3: hasPost ? post4.slice(0, 3) : (cleanDigits(f.postkode).slice(0, 3) || null),
            avfall_codes,
            results_count: Number(res?.count || 0),
            lat: Number.isFinite(lat) ? lat : null,
            lon: Number.isFinite(lon) ? lon : null,
          },
        ]);
      } catch (e) {
        console.warn("search_logs insert failed:", e);
      }
      // --- END LOG ---

      if (!res.ok) {
        return renderResult(
          `Kart: ${g.display_name}\nKoordinater: ${lat.toFixed(5)}, ${lon.toFixed(5)}\n\n${res.message}`
        );
      }

      console.log("DB count:", res.count, "sample:", res.wideRows?.[0]);

      const frText = (f.fraksjonLabel || "Fraksjon").trim();
      const wideNames = res.wideDays.map(dayNameNO).filter(Boolean);
      const line = wideNames.length
        ? `${frText} i området kan tømmes ${wideNames.join(" / ")}`
        : `${frText} i området: ingen ukedager funnet (sjekk koder/DB).`;

      renderResult(
        `Kart: ${g.display_name}\n` +
          `Koordinater: ${lat.toFixed(5)}, ${lon.toFixed(5)}\n\n` +
          `${line}\n\n` +
          `Postkode brukt: ${res.post4}\n` +
          `Treff i DB (postkode + fraksjon-koder): ${res.count}\n` +
          `Kartmarkører: laster…`
      );

      plotNearbyAddressesGrouped(res.wideRows, 5).then((pi) => {
        renderResult(
          `Kart: ${g.display_name}\n` +
            `Koordinater: ${lat.toFixed(5)}, ${lon.toFixed(5)}\n\n` +
            `${line}\n\n` +
            `Postkode brukt: ${res.post4}\n` +
            `Treff i DB (postkode + fraksjon-koder): ${res.count}\n` +
            `Kartmarkører: ${pi.plotted}/${pi.tried} vist.`
        );
      });
    } catch (e) {
      console.error(e);
      renderResult("Feil:\n" + String(e?.message || e));
    }
  });

  // ---------- ADMIN IMPORT (browser reads Excel -> POST JSON to API) ----------
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

  function padPostnumr4(v) {
    const d = cleanDigits(v);
    if (!d) return "";
    return d.padStart(4, "0").slice(0, 4);
  }

  function buildRowsFromSheet(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const out = [];

    for (const r of rows) {
      const postnumr = padPostnumr4(pickField(r, ["Postnummer", "Postnumr", "Postnr", "Postkode"]));
      const gate = String(pickField(r, ["Gate/vei", "Gate", "Vei", "Adresse"]) ?? "").trim();
      const hus = String(pickField(r, ["Husnummer", "Husnumr", "Husnr"]) ?? "").trim();
      const sted = String(pickField(r, ["Sted", "By", "Poststed"]) ?? "").trim();
      const avfall_code = cleanDigits(pickField(r, ["Avfall", "Fraksjon", "Avfallskode"]));
      const ukedag = Number(cleanDigits(pickField(r, ["Ukedag", "UkeDag", "Dag"])) || 0);

      if (!postnumr || !gate || !sted || !avfall_code || !(ukedag >= 1 && ukedag <= 7)) continue;

      out.push({
        postnumr,
        post_prefix3: postnumr.slice(0, 3),
        sted,
        gate,
        husnumr: hus || null,
        avfall_code,
        ukedag,
      });
    }

    return out;
  }

  async function adminImportExcel(file) {
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (!session) throw new Error("Not logged in.");

    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const dataSheetName =
      wb.SheetNames.find((n) => String(n).trim().toLowerCase() === "data") || wb.SheetNames[0];
    const sheet = wb.Sheets[dataSheetName];

    const rows = buildRowsFromSheet(sheet);
    if (!rows.length) throw new Error("Excel parsed 0 valid rows (check headers & data).");

    const resp = await fetch("/api/admin/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ rows }),
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(json?.error || `Import failed (${resp.status})`);
    return json;
  }

  el("btnAdminPick").addEventListener("click", () => el("adminFile").click());
  el("btnAdminReimport").addEventListener("click", () => el("adminFile").click());

  el("adminFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setText("adminMsg", "Importing…");
    try {
      const res = await adminImportExcel(file);
      setText("adminMsg", `OK. Upserted: ${res.upserted ?? "?"} rows.`);
    } catch (err) {
      setText("adminMsg", "ERROR: " + String(err?.message || err));
    } finally {
      el("adminFile").value = "";
    }
  });

  // initial UI
  await refreshAuthUI();

  // keep UI in sync on auth changes
  sb.auth.onAuthStateChange(async () => {
    await refreshAuthUI();
  });
});