import React, { useState, useCallback, createContext, useContext, useRef, useEffect, useMemo } from "react";

const APP_VERSION = "5.4.4";

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SUPABASE CONFIG (v2.0) ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const SB_URL = "https://vspjqlgaxzscalthwxfp.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzcGpxbGdheHpzY2FsdGh3eGZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNTk2NTMsImV4cCI6MjA5MTkzNTY1M30.4c2Hq-110UFEQR1VuCIDALs_pDg1GdXjuVB4nTYfkyw";

const SB_H = {
  "apikey": SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

// Fetch with timeout to prevent infinite hangs
const fetchWithTimeout = (url, options = {}, ms = 25000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
};

const sb = {
  async select(table, q = "") {
    try {
      const r = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}${q}`, { headers: SB_H });
      if (!r.ok) return [];
      return await r.json();
    } catch { return []; }
  },
  async upsert(table, data, onConflict = "") {
    try {
      const qs = onConflict ? `?on_conflict=${onConflict}` : "";
      const r = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}${qs}`, {
        method: "POST",
        headers: { ...SB_H, "Prefer": "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(data),
      });
      if (!r.ok) {
        const err = await r.text();
        console.error(`Supabase upsert error on ${table}:`, r.status, err);
        return null;
      }
      return await r.json();
    } catch (e) { console.error("Supabase upsert exception:", e); return null; }
  },
  async insert(table, data) {
    try {
      const r = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...SB_H, "Prefer": "return=representation" },
        body: JSON.stringify(data),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  },
  async remove(table, col, val) {
    try {
      await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?${col}=eq.${encodeURIComponent(val)}`, {
        method: "DELETE", headers: SB_H,
      });
    } catch {}
  },
};

// ─── Notification helper ──────────────────────────────────────────────────────
const sendNotification = async (adminId, type, title, body, linkType = null, linkId = null) => {
  try {
    await sb.insert("admin_notifications", {
      admin_id: adminId, type, title, body,
      link_type: linkType, link_id: linkId, read: false,
    });
  } catch {}
};

const notifyAllAdmins = async (exceptId, type, title, body, linkType = null, linkId = null) => {
  try {
    const admins = await sb.select("admins", "?select=id");
    if (!admins) return;
    await Promise.all(
      admins.filter(a => a.id !== exceptId).map(a =>
        sendNotification(a.id, type, title, body, linkType, linkId)
      )
    );
  } catch {}
};
const mapCheckinRow = r => {
  // Parse external factors from comment if stored there
  let comment = r.comment || "";
  let externalFactors = r.external_factors || [];
  if (!externalFactors.length && comment.includes("[Factores:")) {
    const match = comment.match(/\[Factores: ([^\]]+)\]/);
    if (match) {
      externalFactors = match[1].split(", ").map(f => f.trim());
      comment = comment.replace(/\n?\[Factores: [^\]]+\]/, "").trim();
    }
  }
  return {
    weight: r.weight_kg ? parseFloat(r.weight_kg) : null,
    photo: r.photo_url || null,
    photoFront: r.photo_url || null,
    photoSide: r.photo_url_side || null,
    photoBack: r.photo_url_back || null,
    dietCompliance: r.diet_compliance ?? 0,
    trainingCompliance: r.training_compliance ?? 0,
    cardioCompliance: r.cardio_compliance ?? 0,
    hunger: r.hunger || "",
    energy: r.energy ?? 5,
    sleep: r.sleep_quality || "",
    trainingFeel: r.training_feel || "",
    discomfort: r.discomfort || "",
    externalFactors,
    comment,
    weekNum: r.week_number,
    savedAt: r.saved_at,
  };
};

const mergeSupabaseIntoDb = (prev, { clients, weights, notes, clientData, checkins }) => {
  const next = { ...prev };

  if (clients?.length) {
    const sbClients = clients.map(c => ({
      id: c.id, userId: c.user_id || c.id,
      name: c.name || "", email: c.email || "", phone: c.phone || "",
      age: c.age || 0, height: c.height_cm || 0, gender: c.gender || "", goal: c.goal || "",
      personalNotes: c.personal_notes || "", injuries: c.injuries || "",
      status: c.status || "active",
      startDate: c.start_date || new Date().toISOString().slice(0, 10),
      avatar: c.avatar || (c.name || "??").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase(),
      password: c.password || "",
      passwordChanged: c.password_changed || false,
    }));
    const ids = new Set(sbClients.map(c => c.id));
    next.clients = [...prev.clients.filter(c => !ids.has(c.id)), ...sbClients];

    // Also populate db.users so clients can login
    const sbUsers = sbClients
      .filter(c => c.email && c.password)
      .map(c => ({
        id: c.userId, email: c.email, password: c.password,
        role: "client", name: c.name, clientId: c.id,
      }));
    const userIds = new Set(sbUsers.map(u => u.id));
    const userEmails = new Set(sbUsers.map(u => u.email));
    next.users = [
      ...prev.users.filter(u => !userIds.has(u.id) && !userEmails.has(u.email)),
      ...sbUsers,
    ];
  }

  if (weights?.length) {
    const wh = {};
    weights.forEach(w => {
      if (!wh[w.client_id]) wh[w.client_id] = [];
      wh[w.client_id].push({ date: w.date, weight: parseFloat(w.weight_kg), _sbId: w.id });
    });
    Object.keys(wh).forEach(cid => { next.weightHistory[cid] = wh[cid].sort((a, b) => a.date.localeCompare(b.date)); });
  }

  if (notes?.length) {
    const cn = {};
    notes.forEach(n => {
      if (!cn[n.client_id]) cn[n.client_id] = [];
      cn[n.client_id].push({ date: (n.created_at || "").slice(0, 10), note: n.note, type: n.type || "general", _sbId: n.id });
    });
    Object.keys(cn).forEach(cid => { next.coachNotes[cid] = cn[cid]; });
  }

  if (clientData?.length) {
    clientData.forEach(cd => {
      if (cd.routine_json) next.routines[cd.client_id] = cd.routine_json;
      if (cd.diet_json)    next.diets[cd.client_id]    = cd.diet_json;
    });
  }

  // Merge check-ins into db.checkins[clientId][weekNum]
  if (checkins?.length) {
    const ci = { ...(next.checkins || {}) };
    checkins.forEach(r => {
      if (!ci[r.client_id]) ci[r.client_id] = {};
      ci[r.client_id][r.week_number] = mapCheckinRow(r);
    });
    next.checkins = ci;
  }

  return next;
};

// ─── TOKENS ───────────────────────────────────────────────────────────────────
const t = {
  bg:          "#05070e",
  bgCard:      "#0a1120",
  bgElevated:  "#0f1928",
  bgInput:     "#0b1422",
  border:      "#14203a",
  borderMid:   "#1a2d4a",
  borderAccent:"rgba(30,155,191,0.3)",
  accent:      "#1E9BBF",
  accentLight: "#29bae0",
  accentDim:   "#14708a",
  accentAlpha: "rgba(30,155,191,0.12)",
  accentGlow:  "rgba(30,155,191,0.28)",
  accentGlow2: "rgba(30,155,191,0.08)",
  text:        "#f0f6ff",
  textSub:     "#6b8ea8",
  textDim:     "#2e4560",
  danger:      "#e05a5a",
  dangerAlpha: "rgba(224,90,90,0.12)",
  warn:        "#f0a030",
  warnAlpha:   "rgba(240,160,48,0.12)",
  success:     "#1E9BBF",
  white:       "#ffffff",
};

// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────
const GlobalStyles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html, body { height: 100%; overscroll-behavior: none; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      background: ${t.bg};
      color: ${t.text};
      -webkit-font-smoothing: antialiased;
    }
    ::-webkit-scrollbar { display: none; }
    input, textarea, button { font-family: inherit; }
    input::placeholder, textarea::placeholder { color: ${t.textDim}; }
    input[type=number]::-webkit-inner-spin-button,
    input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .fade-up { animation: fadeUp 0.3s ease forwards; }
  `}</style>
);

// ─── LOGO ─────────────────────────────────────────────────────────────────────
const GFLogo = ({ size = "md" }) => {
  if (size === "sm") return (
    <span style={{ fontSize: 13, fontWeight: 800, color: t.accent, letterSpacing: "-0.01em" }}>
      Glute Factoryy
    </span>
  );

  // lg / md — full logo with icon
  const scale = size === "lg" ? 1 : 0.8;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <div style={{ width: Math.round(72*scale), height: Math.round(72*scale), borderRadius: Math.round(20*scale), background: "linear-gradient(135deg, #1E9BBF, #0d5f75)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 32px rgba(30,155,191,0.35)" }}>
        <svg width={Math.round(42*scale)} height={Math.round(42*scale)} viewBox="0 0 42 42" fill="none">
          <polyline points="4,30 10,30 15,18 21,34 27,10 33,30 38,30" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
          <polyline points="21,10 21,4 17,8" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      <div style={{ fontSize: Math.round(32*scale), fontWeight: 900, color: t.accent, letterSpacing: "-0.03em", lineHeight: 1 }}>
        Glute Factoryy
      </div>
    </div>
  );
};

// ─── DATABASE ─────────────────────────────────────────────────────────────────
// IDs en formato UUID válido para compatibilidad con Supabase
const ID = {
  c1: "11111111-0001-0001-0001-000000000001",
  c2: "11111111-0002-0002-0002-000000000002",
  c3: "11111111-0003-0003-0003-000000000003",
  u1: "22222222-0001-0001-0001-000000000001",
  u2: "22222222-0002-0002-0002-000000000002",
  u3: "22222222-0003-0003-0003-000000000003",
};

const INITIAL_DB = {
  users: [
    { id: "admin-pol", email: "Pol", password: "12345", role: "superadmin", name: "Pol" },
    { id: ID.u1, email: "carlos", password: "carlos123", role: "client", name: "Carlos Martínez", clientId: ID.c1 },
  ],
  clients: [
    { id:ID.c1, userId:ID.u1, name:"Carlos Martínez", email:"carlos@mail.com", phone:"+34 612 345 678", age:28, height:178, goal:"Hipertrofia muscular", startDate:"2024-01-15", status:"active", avatar:"CM", personalNotes:"Trabaja en oficina, puede entrenar por las tardes.", injuries:"Leve molestia en hombro derecho. Evitar press militar pesado." },
  ],
  weightHistory: {
    [ID.c1]: [{date:"2024-01-15",weight:75.2},{date:"2024-02-01",weight:76.0},{date:"2024-02-15",weight:76.8},{date:"2024-03-01",weight:77.5},{date:"2024-03-15",weight:78.1},{date:"2024-04-01",weight:78.9}],
  },
  routines: {
    [ID.c1]: { name:"Hipertrofia – Upper/Lower Split", days:[
      { id:"d1", name:"Lunes – Tren Superior A", coachTip:"Enfócate en la conexión mente-músculo en cada repetición. No busques el peso máximo hoy, busca la mejor ejecución. Descansa completo entre series para rendir al máximo.", exercises:[
        {name:"Press Banca Plano",sets:4,reps:"8-10",rest:"2min",notes:"Técnica controlada"},
        {name:"Remo con Barra",sets:4,reps:"8-10",rest:"2min",notes:""},
        {name:"Press Inclinado Mancuernas",sets:3,reps:"10-12",rest:"90s",notes:""},
        {name:"Jalón al Pecho",sets:3,reps:"10-12",rest:"90s",notes:"Agarre cerrado"},
        {name:"Curl Bíceps Barra",sets:3,reps:"12",rest:"60s",notes:""},
        {name:"Press Francés",sets:3,reps:"12",rest:"60s",notes:""},
      ]},
      { id:"d2", name:"Martes – Tren Inferior A", coachTip:"Calienta bien rodillas y caderas antes de empezar. En la sentadilla, asegúrate de que las rodillas sigan la dirección de los pies. Si sientes la zona lumbar, reduce el peso y avísame.", exercises:[
        {name:"Sentadilla con Barra",sets:4,reps:"6-8",rest:"3min",notes:"Profundidad completa"},
        {name:"Prensa de Piernas",sets:3,reps:"10-12",rest:"2min",notes:""},
        {name:"Extensión de Cuádriceps",sets:3,reps:"12-15",rest:"90s",notes:""},
        {name:"Curl Femoral Tumbado",sets:3,reps:"12-15",rest:"90s",notes:""},
        {name:"Peso Muerto Rumano",sets:3,reps:"10-12",rest:"2min",notes:""},
        {name:"Gemelo en Máquina",sets:4,reps:"15-20",rest:"60s",notes:""},
      ]},
      { id:"d3", name:"Jueves – Tren Superior B", coachTip:"Recuerda la molestia en el hombro derecho. Evita el press militar pesado y sustituye por press neutro si notas incomodidad. Las dominadas son el ejercicio clave de hoy — dales todo.", exercises:[
        {name:"Press Militar",sets:4,reps:"8-10",rest:"2min",notes:"Cuidado hombro dcho."},
        {name:"Dominadas",sets:4,reps:"Máx",rest:"2min",notes:"Con lastre si >10"},
        {name:"Fondos en Paralelas",sets:3,reps:"10-12",rest:"90s",notes:""},
        {name:"Elevaciones Laterales",sets:4,reps:"15",rest:"60s",notes:""},
      ]},
      { id:"d4", name:"Viernes – Tren Inferior B", coachTip:"El peso muerto es el rey de hoy. Activa el core antes de cada repetición y no redondees la espalda. Las búlgaras son duras — tómate el descanso completo entre series.", exercises:[
        {name:"Peso Muerto Convencional",sets:4,reps:"5-6",rest:"3min",notes:""},
        {name:"Sentadilla Búlgara",sets:3,reps:"10 c/l",rest:"2min",notes:""},
        {name:"Gemelo de Pie",sets:4,reps:"15-20",rest:"60s",notes:""},
      ]},
    ]},
  },
  diets: {},
  coachNotes: {
    [ID.c1]:[
      {date:"2024-04-10",note:"Excelente semana. Superó el récord en press banca (100kg). Subir 2.5kg la próxima sesión.",type:"progress"},
      {date:"2024-03-25",note:"Comentó molestia en hombro derecho. Reducir volumen press militar.",type:"injury"},
      {date:"2024-03-10",note:"Check-in positivo. Buena adherencia a la dieta.",type:"nutrition"},
    ],
  },
  checkins: {}, // populated from Supabase
};

// ─── CONTEXT ──────────────────────────────────────────────────────────────────
const Ctx = createContext(null);
const useApp = () => useContext(Ctx);

// ─── PRIMITIVES ───────────────────────────────────────────────────────────────
const Icon = ({ n, s = 20, style: sx }) => {
  const d = {
    home:    "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10",
    dumbbell:"M6.5 6.5h11 M17.5 6.5v11 M6.5 17.5v-11 M3 9.5h3 M18 9.5h3 M3 14.5h3 M18 14.5h3",
    food:    "M18 8h1a4 4 0 0 1 0 8h-1 M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z M6 1v3 M10 1v3 M14 1v3",
    scale:   "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M4.93 4.93l1.41 1.41 M17.66 17.66l1.41 1.41 M2 12h2 M20 12h2 M6.34 17.66l-1.41 1.41 M19.07 4.93l-1.41 1.41",
    notes:   "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
    logout:  "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",
    plus:    "M12 5v14 M5 12h14",
    edit:    "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
    trash:   "M3 6h18 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6 M9 6V4h6v2",
    search:  "M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
    x:       "M18 6L6 18 M6 6l12 12",
    check:   "M20 6L9 17l-5-5",
    back:    "M19 12H5 M12 19l-7-7 7-7",
    down:    "M6 9l6 6 6-6",
    users:   "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M23 21v-2a4 4 0 0 1-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
    alert:   "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01",
    eye:     "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    eyeoff:  "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94 M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19 M1 1l22 22",
    lightning:"M13 2L3 14h9l-1 8 10-12h-9l1-8z",
    chat:    "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    target:  "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={sx}>
      {(d[n]||"").split(" M").map((seg,i) => <path key={i} d={i===0?seg:"M"+seg}/>)}
    </svg>
  );
};

const Pill = ({ children, color = "default" }) => {
  const map = {
    default: { bg: t.bgElevated,   text: t.textSub,   bd: t.border },
    accent:  { bg: t.accentAlpha,  text: t.accent,    bd: "rgba(30,155,191,0.25)" },
    danger:  { bg: t.dangerAlpha,  text: t.danger,    bd: "rgba(224,90,90,0.25)" },
    warn:    { bg: t.warnAlpha,    text: t.warn,      bd: "rgba(240,160,48,0.25)" },
  };
  const c = map[color] || map.default;
  return (
    <span style={{ background: c.bg, color: c.text, border: `1px solid ${c.bd}`, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em" }}>
      {children}
    </span>
  );
};

const Av = ({ initials, size = 44 }) => (
  <div style={{
    width: size, height: size, borderRadius: size * 0.3, flexShrink: 0,
    background: `linear-gradient(135deg, rgba(30,155,191,0.3) 0%, rgba(20,112,138,0.15) 100%)`,
    border: `1.5px solid rgba(30,155,191,0.4)`,
    boxShadow: `0 4px 14px rgba(30,155,191,0.18)`,
    display: "flex", alignItems: "center", justifyContent: "center",
    color: t.accent, fontSize: size * 0.32, fontWeight: 800, letterSpacing: "0.03em",
  }}>{initials}</div>
);

// ─── INPUT ─────────────────────────────────────────────────────────────────────
const Field = ({ label, value, onChange, type = "text", placeholder = "", multiline, rows = 3, suffix, onKeyDown }) => {
  const [focus, setFocus] = useState(false);
  const [show, setShow] = useState(false);
  const isPass = type === "password";
  const inputType = isPass ? (show ? "text" : "password") : type;
  const base = { width: "100%", background: t.bgInput, border: `1.5px solid ${focus ? t.accent : t.border}`, borderRadius: 12, padding: "13px 16px", color: t.text, fontSize: 15, outline: "none", boxSizing: "border-box", transition: "border-color 0.15s", resize: "vertical" };
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <div style={{ color: t.textSub, fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", marginBottom: 7 }}>{label}</div>}
      <div style={{ position: "relative" }}>
        {multiline
          ? <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows} style={base} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} />
          : <input type={inputType} value={value} onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder} style={{ ...base, paddingRight: (isPass || suffix) ? 44 : 16 }} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} />
        }
        {isPass && (
          <button onClick={() => setShow(s => !s)} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 44, background: "none", border: "none", cursor: "pointer", color: t.textSub, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon n={show ? "eyeoff" : "eye"} s={17} />
          </button>
        )}
        {suffix && !isPass && <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: t.textSub, fontSize: 13 }}>{suffix}</span>}
      </div>
    </div>
  );
};

// ─── BUTTON ───────────────────────────────────────────────────────────────────
const Btn = ({ children, onClick, variant = "primary", size = "md", disabled, full, style: sx = {} }) => {
  const vs = {
    primary: { bg: `linear-gradient(135deg, ${t.accent} 0%, ${t.accentDim} 100%)`, color: "#fff", bd: "none", shadow: `0 4px 16px ${t.accentGlow}` },
    ghost:   { bg: t.bgElevated, color: t.text, bd: `1.5px solid ${t.borderMid}`, shadow: "none" },
    danger:  { bg: t.dangerAlpha, color: t.danger, bd: `1.5px solid rgba(224,90,90,0.2)`, shadow: "none" },
    text:    { bg: "transparent", color: t.accent, bd: "none", shadow: "none" },
  };
  const ss = { sm: { p: "8px 16px", fs: 13 }, md: { p: "13px 22px", fs: 15 }, lg: { p: "16px 28px", fs: 16 } };
  const v = vs[variant], s = ss[size];
  return (
    <button onClick={onClick} disabled={disabled} style={{ background: v.bg, color: v.color, border: v.bd, boxShadow: v.shadow, padding: s.p, fontSize: s.fs, fontWeight: 700, borderRadius: 12, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "transform 0.1s, opacity 0.15s", width: full ? "100%" : undefined, letterSpacing: "0.01em", ...sx }}
      onMouseDown={e => { if (!disabled) e.currentTarget.style.transform = "scale(0.97)"; }}
      onMouseUp={e => { if (!disabled) e.currentTarget.style.transform = "scale(1)"; }}
      onTouchStart={e => { if (!disabled) e.currentTarget.style.transform = "scale(0.97)"; }}
      onTouchEnd={e => { if (!disabled) e.currentTarget.style.transform = "scale(1)"; }}
    >
      {children}
    </button>
  );
};

// ─── CARD ─────────────────────────────────────────────────────────────────────
const Card = ({ children, onClick, style: sx = {}, accent }) => (
  <div onClick={onClick} style={{
    background: accent
      ? `linear-gradient(135deg, rgba(30,155,191,0.1) 0%, ${t.bgCard} 60%)`
      : `linear-gradient(135deg, ${t.bgCard} 0%, #080f1c 100%)`,
    borderRadius: 18,
    padding: 18,
    border: `1.5px solid ${accent ? "rgba(30,155,191,0.3)" : t.border}`,
    boxShadow: accent
      ? `0 4px 24px rgba(30,155,191,0.12), 0 1px 0 rgba(30,155,191,0.15) inset`
      : `0 4px 20px rgba(0,0,0,0.3), 0 1px 0 rgba(255,255,255,0.02) inset`,
    cursor: onClick ? "pointer" : "default",
    transition: "transform 0.12s, border-color 0.15s, box-shadow 0.15s",
    ...sx,
  }}
    onMouseDown={e => { if (onClick) e.currentTarget.style.transform = "scale(0.99)"; }}
    onMouseUp={e => { if (onClick) e.currentTarget.style.transform = "scale(1)"; }}
    onTouchStart={e => { if (onClick) e.currentTarget.style.transform = "scale(0.99)"; }}
    onTouchEnd={e => { if (onClick) { e.currentTarget.style.transform = "scale(1)"; } }}
  >
    {children}
  </div>
);

const Sep = ({ margin = 20 }) => <div style={{ height: 1, background: t.border, margin: `${margin}px 0` }} />;

// ─── WEIGHT CHART ─────────────────────────────────────────────────────────────
const WeightChart = ({ data }) => {
  // Unique IDs per instance to avoid SVG defs collisions when rendered multiple times
  const uid = useMemo(() => Math.random().toString(36).slice(2, 7), []);
  const gradId = `wc-grad-${uid}`;
  const glowId = `wc-glow-${uid}`;

  if (!data || data.length < 2) return (
    <div style={{ textAlign: "center", padding: "30px 0", color: t.textSub, fontSize: 14 }}>Sin suficientes registros</div>
  );
  const vals = data.map(d => d.weight);
  const lo = Math.min(...vals) - 0.8, hi = Math.max(...vals) + 0.8;
  const W = 300, H = 100, px = 12;
  const x = i => px + (i / (data.length - 1)) * (W - px * 2);
  const y = v => H - px - ((v - lo) / (hi - lo)) * (H - px * 2);
  const pts = data.map((d, i) => `${x(i)},${y(d.weight)}`).join(" ");
  const first = data[0].weight, last = data[data.length - 1].weight;
  const diff = (last - first).toFixed(1);
  const up = parseFloat(diff) > 0;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 32, fontWeight: 900, color: t.text, letterSpacing: "-0.04em", lineHeight: 1 }}>
            {last}<span style={{ fontSize: 16, fontWeight: 500, color: t.textSub, marginLeft: 4 }}>kg</span>
          </div>
          <div style={{ fontSize: 13, color: up ? t.warn : t.accent, fontWeight: 600, marginTop: 4 }}>
            {up ? "▲" : "▼"} {Math.abs(diff)} kg desde inicio
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12, color: t.textDim }}>{data.length} registros</div>
          <div style={{ fontSize: 11, color: t.textDim, marginTop: 2 }}>{data[0].date} → {data[data.length-1].date}</div>
        </div>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={t.accent} stopOpacity="0.2"/>
            <stop offset="100%" stopColor={t.accent} stopOpacity="0"/>
          </linearGradient>
          <filter id={glowId}><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <polygon points={`${x(0)},${H-px} ${pts} ${x(data.length-1)},${H-px}`} fill={`url(#${gradId})`}/>
        <polyline points={pts} fill="none" stroke={t.accent} strokeWidth="2.5" strokeLinejoin="round" filter={`url(#${glowId})`}/>
        {data.map((d,i) => (
          <circle key={i} cx={x(i)} cy={y(d.weight)} r={i===data.length-1?4.5:2.5} fill={t.accent} opacity={i===data.length-1?1:0.5}/>
        ))}
      </svg>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── LOGIN ────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const Login = () => {
  const { login } = useApp();
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const go = async () => {
    setLoading(true); setErr("");
    const ok = await login(user, pass);
    if (ok === "blocked") {
      setErr("🔒 Demasiados intentos fallidos. Espera 15 minutos antes de volver a intentarlo.");
    } else if (!ok) {
      setErr("Usuario o contraseña incorrectos");
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: t.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px 20px" }}>
      {/* Ambient */}
      <div style={{ position: "fixed", top: 0, left: "50%", transform: "translateX(-50%)", width: 500, height: 400, background: `radial-gradient(ellipse at 50% 0%, rgba(30,155,191,0.12) 0%, transparent 70%)`, pointerEvents: "none" }}/>

      <div style={{ width: "100%", maxWidth: 380, position: "relative" }}>
        {/* Logo block */}
        <div style={{ textAlign: "center", marginBottom: 44 }}>
          <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            {/* App icon - opción 2: pulso + flecha */}
            <div style={{ width: 72, height: 72, borderRadius: 20, background: `linear-gradient(135deg, #1E9BBF, #0d5f75)`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 8px 32px rgba(30,155,191,0.35)`, marginBottom: 4 }}>
              <svg width="42" height="42" viewBox="0 0 42 42" fill="none">
                <polyline points="4,30 10,30 15,18 21,34 27,10 33,30 38,30" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                <polyline points="21,10 21,4 17,8" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            {/* Single line name */}
            <div style={{ fontSize: 32, fontWeight: 900, color: t.accent, letterSpacing: "-0.03em", lineHeight: 1 }}>Glute Factoryy</div>
            <div style={{ color: t.textSub, fontSize: 13, fontWeight: 500, marginTop: 4 }}>Plataforma de seguimiento personalizado</div>
          </div>
        </div>

        {/* Form */}
        <Card accent style={{ padding: "28px 24px" }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: t.text, marginBottom: 4, letterSpacing: "-0.02em" }}>Bienvenido</div>
          <div style={{ fontSize: 14, color: t.textSub, marginBottom: 24 }}>Bienvenido a la familia de Glute Factoryy.</div>

          <Field label="USUARIO" value={user} onChange={setUser} placeholder="Tu usuario" onKeyDown={e => e.key === "Enter" && go()} />
          <Field label="CONTRASEÑA" value={pass} onChange={setPass} type="password" placeholder="••••••••" onKeyDown={e => e.key === "Enter" && go()} />

          {err && (
            <div style={{ background: t.dangerAlpha, border: `1px solid rgba(224,90,90,0.2)`, borderRadius: 10, padding: "11px 14px", marginBottom: 16, color: t.danger, fontSize: 13, fontWeight: 600 }}>
              {err}
            </div>
          )}

          <Btn onClick={go} disabled={loading} full>
            {loading ? "Verificando..." : "Entrar"}
          </Btn>
        </Card>

        {/* Demo block removed — credentials managed by admin only */}
        <div style={{ textAlign: "center", marginTop: 20 }}>
          <span style={{ fontSize: 11, color: t.textDim, fontWeight: 500 }}>v{APP_VERSION}</span>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ClientChat — shared chat between client and all admins ───────────────────
const ClientChat = ({ client, isAdmin }) => {
  const { currentUser } = useApp();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  const clientId = isAdmin ? client.id : client.id;

  const load = async () => {
    const rows = await sb.select("client_messages", `?client_id=eq.${clientId}&order=created_at`);
    if (rows) setMessages(rows);
    setLoading(false);
  };

  useEffect(() => { load(); }, [clientId]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Mark as read when admin opens chat
  useEffect(() => {
    if (isAdmin && currentUser) {
      const markRead = async () => {
        try {
          const admins = await sb.select("admins", `?id=eq.${currentUser.id}`);
          const lastRead = admins?.[0]?.last_read || {};
          lastRead[clientId] = new Date().toISOString();
          await sb.upsert("admins", { id: currentUser.id, name: currentUser.name, email: currentUser.email, password: currentUser.password, role: currentUser.role, last_read: lastRead });
        } catch {}
      };
      markRead();
    }
  }, [clientId, isAdmin]);

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    await sb.insert("client_messages", {
      client_id: clientId,
      sender_id: currentUser.id,
      sender_name: currentUser.name,
      sender_role: currentUser.role,
      message: text.trim(),
    });
    // If client sends message, notify all admins
    if (!isAdmin) {
      await notifyAllAdmins(null, "chat",
        `💬 Mensaje de ${currentUser.name}`,
        text.trim().substring(0, 80),
        "client", clientId
      );
    }
    setText("");
    await load();
    setSending(false);
  };

  const fmtTime = ts => {
    try {
      const d = new Date(ts);
      return `${d.getDate()}/${d.getMonth()+1} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    } catch { return ""; }
  };

  const isMe = msg => msg.sender_id === currentUser.id;
  const isAdmin_ = msg => msg.sender_role === "admin" || msg.sender_role === "superadmin";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: isAdmin ? "calc(100vh - 280px)" : "calc(100vh - 200px)", minHeight: 300 }}>
      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingBottom: 16 }}>
        {loading && <div style={{ textAlign:"center", color:t.textSub, fontSize:14, padding:20, animation:"pulse 1.5s infinite" }}>Cargando mensajes...</div>}
        {!loading && messages.length === 0 && (
          <div style={{ textAlign:"center", color:t.textSub, fontSize:14, padding:40 }}>
            <div style={{ fontSize:28, marginBottom:8 }}>💬</div>
            Aún no hay mensajes. ¡Empieza la conversación!
          </div>
        )}
        {messages.map(m => {
          const me = isMe(m);
          const adminMsg = isAdmin_(m);
          return (
            <div key={m.id} style={{ display:"flex", flexDirection:"column", alignItems: me ? "flex-end" : "flex-start" }}>
              {!me && (
                <div style={{ fontSize:11, fontWeight:700, marginBottom:3, marginLeft:4, color: adminMsg ? t.accent : t.warn }}>
                  {adminMsg ? "👤 " : "🏋️ "}{m.sender_name}
                </div>
              )}
              <div style={{ maxWidth:"80%", background: me ? `linear-gradient(135deg, ${t.accent}, ${t.accentDim})` : t.bgCard, border: me ? "none" : `1.5px solid ${t.border}`, borderRadius: me ? "16px 16px 4px 16px" : "16px 16px 16px 4px", padding:"10px 14px", boxShadow: me ? `0 4px 14px ${t.accentGlow}` : "0 2px 8px rgba(0,0,0,0.2)" }}>
                <div style={{ fontSize:14, color: me ? "white" : t.text, lineHeight:1.5 }}>{m.message}</div>
              </div>
              <div style={{ fontSize:10, color:t.textDim, marginTop:3, marginLeft:4, marginRight:4 }}>{fmtTime(m.created_at)}</div>
            </div>
          );
        })}
        <div ref={bottomRef}/>
      </div>

      {/* Input */}
      <div style={{ display:"flex", gap:10, paddingTop:12, borderTop:`1px solid ${t.border}` }}>
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Escribe un mensaje..."
          style={{ flex:1, background:t.bgInput, border:`1.5px solid ${t.border}`, borderRadius:12, padding:"12px 16px", color:t.text, fontSize:14, fontFamily:"inherit", outline:"none" }}
          onFocus={e => e.target.style.borderColor = t.accent}
          onBlur={e => e.target.style.borderColor = t.border}
        />
        <button onClick={send} disabled={sending || !text.trim()}
          style={{ background:`linear-gradient(135deg, ${t.accent}, ${t.accentDim})`, border:"none", borderRadius:12, width:48, height:48, display:"flex", alignItems:"center", justifyContent:"center", cursor: text.trim() ? "pointer" : "not-allowed", opacity: text.trim() ? 1 : 0.4, flexShrink:0, fontSize:20 }}>
          ➤
        </button>
      </div>
    </div>
  );
};

// ─── ClientPasswordChange ─────────────────────────────────────────────────────
const ClientPasswordChange = ({ client, db, setDb, onDone }) => {
  const [current, setCurrent] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newPass2, setNewPass2] = useState("");
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setErr("");
    if (!current) { setErr("Introduce tu contraseña actual"); return; }
    const user = db.users.find(u => u.clientId === client.id);
    if (user?.password !== current) { setErr("La contraseña actual no es correcta"); return; }
    if (!newPass) { setErr("Introduce la nueva contraseña"); return; }
    if (newPass.length < 6) { setErr("Mínimo 6 caracteres"); return; }
    if (newPass !== newPass2) { setErr("Las contraseñas no coinciden"); return; }

    setDb(p => ({
      ...p,
      clients: p.clients.map(c => c.id === client.id ? { ...c, password: newPass, passwordChanged: true } : c),
      users: p.users.map(u => u.clientId === client.id ? { ...u, password: newPass } : u),
    }));
    await sb.upsert("clients", { id: client.id, user_id: client.userId, name: client.name, email: client.email, password: newPass, password_changed: true });
    setSaved(true);
    setTimeout(() => { setSaved(false); onDone(); }, 1500);
  };

  return (
    <Card>
      <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 16 }}>CAMBIAR CONTRASEÑA</div>
      <Field label="CONTRASEÑA ACTUAL" value={current} onChange={setCurrent} type="password"/>
      <Field label="NUEVA CONTRASEÑA" value={newPass} onChange={setNewPass} type="password" placeholder="Mínimo 6 caracteres"/>
      <Field label="REPETIR NUEVA CONTRASEÑA" value={newPass2} onChange={setNewPass2} type="password"/>
      {err && <div style={{ color: t.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {saved && <div style={{ color: t.accent, fontSize: 13, marginBottom: 12 }}>✅ Contraseña actualizada</div>}
      <Btn onClick={save} full>{saved ? "✓ Guardada" : "Cambiar contraseña"}</Btn>
    </Card>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CLIENT APP ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const ClientApp = () => {
  const { currentUser, db, setDb, logout } = useApp();
  const [tab, setTab] = useState("home");
  const [showSettings, setShowSettings] = useState(false);
  const [showQuestionnaire, setShowQuestionnaire] = useState(false);
  const [hasQuestionnaire, setHasQuestionnaire] = useState(null); // null = loading
  const client = db.clients.find(c => c.id === currentUser.clientId);

  // Check if questionnaire is filled
  useEffect(() => {
    if (!client) return;
    (async () => {
      try {
        const rows = await sb.select("client_questionnaires", `?client_id=eq.${client.id}`);
        setHasQuestionnaire(rows && rows.length > 0);
      } catch {
        setHasQuestionnaire(false);
      }
    })();
  }, [client?.id]);

  if (!client) return null;

  const weights = db.weightHistory[client.id] || [];
  const routine = db.routines[client.id];
  const diet    = db.diets[client.id];
  const notes   = db.coachNotes[client.id] || [];

  // Show onboarding if profile is incomplete (no goal set)
  const profileComplete = client.goal && client.goal.trim().length > 0;
  if (!profileComplete) {
    return <ClientOnboarding client={client} db={db} setDb={setDb} onDone={() => {}} />;
  }

  // Show questionnaire if open
  if (showQuestionnaire) return <ClientQuestionnaire client={client} onDone={() => { setShowQuestionnaire(false); setHasQuestionnaire(true); }} onBack={() => setShowQuestionnaire(false)}/>;

  // Client settings — change password
  if (showSettings) return (
    <div style={{ minHeight: "100vh", background: t.bg, maxWidth: 430, margin: "0 auto", padding: "52px 20px 40px" }}>
      <button onClick={() => setShowSettings(false)} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", color:t.textSub, fontFamily:"inherit", fontSize:13, fontWeight:600, marginBottom:20, padding:0 }}>
        <Icon n="back" s={16}/> Volver
      </button>
      <div style={{ fontSize: 22, fontWeight: 900, color: t.text, marginBottom: 20 }}>Mis ajustes</div>

      {/* Open/edit questionnaire — always available */}
      <button onClick={() => { setShowSettings(false); setShowQuestionnaire(true); }}
        style={{ width: "100%", background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", fontFamily: "inherit", textAlign: "left", marginBottom: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(240,160,48,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>📋</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>{hasQuestionnaire ? "Editar cuestionario" : "Rellenar cuestionario inicial"}</div>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>{hasQuestionnaire ? "Actualiza tus respuestas" : "Pendiente de rellenar"}</div>
        </div>
        <Icon n="back" s={16} style={{ transform: "rotate(180deg)", color: t.textDim }}/>
      </button>

      <ClientPasswordChange client={client} db={db} setDb={setDb} onDone={() => setShowSettings(false)}/>
    </div>
  );

  const navItems = [
    { id: "home",     icon: "home",      label: "Inicio"  },
    { id: "routine",  icon: "dumbbell",  label: "Rutina"  },
    { id: "diet",     icon: "food",      label: "Dieta"   },
    { id: "weight",   icon: "scale",     label: "Peso"    },
    { id: "notes",    icon: "notes",     label: "Notas"   },
    { id: "tracking", icon: "lightning", label: "Check-in"},
    { id: "chat",     icon: "chat",      label: "Chat"    },
  ];

  return (
    <div style={{ minHeight: "100vh", background: t.bg, maxWidth: 430, margin: "0 auto", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: "calc(90px + env(safe-area-inset-bottom, 0px))" }}>
        <div style={{ padding: "52px 20px 20px", background: `linear-gradient(180deg, rgba(30,155,191,0.08) 0%, transparent 100%)`, borderBottom: `1px solid ${t.border}`, marginBottom: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 12, color: t.textSub, fontWeight: 600, letterSpacing: "0.04em", marginBottom: 2 }}><GFLogo size="sm" /></div>
              {tab === "home" && <div style={{ fontSize: 22, fontWeight: 900, color: t.text, letterSpacing: "-0.03em" }}>Hola, {client.name.split(" ")[0]} 👋</div>}
              {tab === "routine"  && <div style={{ fontSize: 22, fontWeight: 900, color: t.text, letterSpacing: "-0.03em" }}>Mi Rutina</div>}
              {tab === "diet"     && <div style={{ fontSize: 22, fontWeight: 900, color: t.text, letterSpacing: "-0.03em" }}>Mi Dieta</div>}
              {tab === "weight"   && <div style={{ fontSize: 22, fontWeight: 900, color: t.text, letterSpacing: "-0.03em" }}>Evolución</div>}
              {tab === "notes"    && <div style={{ fontSize: 22, fontWeight: 900, color: t.text, letterSpacing: "-0.03em" }}>Seguimiento</div>}
              {tab === "tracking" && <div style={{ fontSize: 22, fontWeight: 900, color: t.text, letterSpacing: "-0.03em" }}>Check-in ⚡</div>}
              {tab === "chat"     && <div style={{ fontSize: 22, fontWeight: 900, color: t.text, letterSpacing: "-0.03em" }}>Chat 💬</div>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setShowSettings(true)} style={{ background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 12, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.textSub, fontSize: 18 }}>⚙️</button>
              <button onClick={logout} style={{ background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 12, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.textSub }}>
                <Icon n="logout" s={17}/>
              </button>
            </div>
          </div>
        </div>

        <div style={{ padding: "16px 16px 0" }} className="fade-up">
          {tab === "home"     && <CHome     client={client} weights={weights} notes={notes} db={db} onGoToCheckin={() => setTab("tracking")} onGoToQuestionnaire={() => setShowQuestionnaire(true)} hasQuestionnaire={hasQuestionnaire !== false} />}
          {tab === "routine"  && <CRoutine  routine={routine} />}
          {tab === "diet"     && <CDiet     diet={diet} />}
          {tab === "weight"   && <CWeight   client={client} weights={weights} db={db} setDb={setDb} />}
          {tab === "notes"    && <CNotes    client={client} notes={notes} />}
          {tab === "tracking" && <CTracking client={client} db={db} setDb={setDb} />}
          {tab === "chat"     && <ClientChat client={client} isAdmin={false}/>}
        </div>
      </div>

      {/* Bottom nav */}
      <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 430, background: "rgba(7,9,15,0.97)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderTop: `1px solid ${t.border}`, display: "flex", paddingTop: 10, paddingBottom: "env(safe-area-inset-bottom, 16px)", zIndex: 100 }}>
        {navItems.map(item => {
          const active = tab === item.id;
          return (
            <button key={item.id} onClick={() => setTab(item.id)} style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "6px 0", fontFamily: "inherit" }}>
              <div style={{ width: 44, height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 10, background: active ? t.accentAlpha : "transparent", transition: "background 0.2s", color: active ? t.accent : t.textDim }}>
                <Icon n={item.icon} s={20}/>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, color: active ? t.accent : t.textDim, letterSpacing: "0.02em", transition: "color 0.2s" }}>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

const CHome = ({ client, weights, notes, db, onGoToCheckin, onGoToQuestionnaire, hasQuestionnaire }) => {
  const lastW = weights.slice(-1)[0];
  const prevW = weights.slice(-2,-1)[0];
  const diff  = lastW && prevW ? (lastW.weight - prevW.weight).toFixed(1) : null;
  const weeks = Math.floor((new Date() - new Date(client.startDate)) / 86400000 / 7);
  const lastNote = notes[0];

  // Check if check-in is pending this week
  const currentWeekKey = getCalWeekKey(new Date());
  const hasCheckin = !!(db?.checkins?.[client.id]?.[currentWeekKey]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* Questionnaire reminder — only if NOT completed */}
      {!hasQuestionnaire && (
        <div style={{ background: "linear-gradient(135deg, rgba(240,160,48,0.12), rgba(240,160,48,0.04))", border: "1.5px solid rgba(240,160,48,0.3)", borderRadius: 16, padding: "16px 18px", display: "flex", gap: 14, alignItems: "flex-start" }}>
          <span style={{ fontSize: 26, flexShrink: 0, marginTop: 2 }}>📋</span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: t.text, marginBottom: 4 }}>Cuestionario inicial pendiente</div>
            <div style={{ fontSize: 13, color: t.textSub, lineHeight: 1.5, marginBottom: 12 }}>Rellena este cuestionario para que tu coach pueda personalizar tu plan al máximo. Son solo unos minutos.</div>
            <button onClick={onGoToQuestionnaire}
              style={{ background: "linear-gradient(135deg, #f0a030, #c07818)", color: "white", border: "none", borderRadius: 10, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 4px 12px rgba(240,160,48,0.3)" }}>
              Rellenar ahora →
            </button>
          </div>
        </div>
      )}

      {/* Check-in reminder banner */}
      {!hasCheckin && (
        <div style={{ background: "linear-gradient(135deg, rgba(30,155,191,0.1), rgba(30,155,191,0.04))", border: "1.5px solid rgba(30,155,191,0.25)", borderRadius: 16, padding: "16px 18px", display: "flex", gap: 14, alignItems: "flex-start" }}>
          <span style={{ fontSize: 26, flexShrink: 0, marginTop: 2 }}>⚡</span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: t.text, marginBottom: 4 }}>Check-in pendiente</div>
            <div style={{ fontSize: 13, color: t.textSub, lineHeight: 1.5, marginBottom: 12 }}>Tu coach está esperando tus datos de esta semana. Solo tarda 2 minutos.</div>
            <button onClick={onGoToCheckin}
              style={{ background: `linear-gradient(135deg, ${t.accent}, ${t.accentDim})`, color: "white", border: "none", borderRadius: 10, padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", boxShadow: `0 4px 12px ${t.accentGlow}` }}>
              Hacer check-in ahora →
            </button>
          </div>
        </div>
      )}

      {/* Goal banner */}
      <div style={{ background: `linear-gradient(135deg, rgba(30,155,191,0.15), rgba(30,155,191,0.05))`, border: `1px solid rgba(30,155,191,0.2)`, borderRadius: 16, padding: "16px 18px", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: t.accentAlpha, display: "flex", alignItems: "center", justifyContent: "center", color: t.accent, flexShrink: 0 }}>
          <Icon n="target" s={20}/>
        </div>
        <div>
          <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.05em", marginBottom: 3 }}>OBJETIVO</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: t.text }}>{client.goal}</div>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Card accent style={{ padding: "18px 16px" }}>
          <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 8 }}>PESO ACTUAL</div>
          <div style={{ fontSize: 30, fontWeight: 900, color: t.text, letterSpacing: "-0.04em", lineHeight: 1 }}>
            {lastW?.weight ?? "—"}
            <span style={{ fontSize: 14, color: t.textSub, fontWeight: 500, marginLeft: 3 }}>kg</span>
          </div>
          {diff && <div style={{ fontSize: 12, marginTop: 6, fontWeight: 600, color: parseFloat(diff) > 0 ? t.warn : t.accent }}>
            {parseFloat(diff) > 0 ? "▲" : "▼"} {Math.abs(diff)} kg esta semana
          </div>}
        </Card>
        <Card style={{ padding: "18px 16px" }}>
          <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 8 }}>SEMANAS</div>
          <div style={{ fontSize: 30, fontWeight: 900, color: t.text, letterSpacing: "-0.04em", lineHeight: 1 }}>{weeks}</div>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 6, fontWeight: 500 }}>desde el inicio</div>
        </Card>
      </div>

      {/* Last note */}
      {lastNote && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em" }}>ÚLTIMA NOTA DEL COACH</div>
            <Pill color={lastNote.type==="injury"?"danger":lastNote.type==="progress"?"accent":"default"}>
              {lastNote.type==="injury"?"Lesión":lastNote.type==="progress"?"Progreso":"General"}
            </Pill>
          </div>
          <div style={{ fontSize: 14, color: t.text, lineHeight: 1.6, marginBottom: 8 }}>{lastNote.note}</div>
          <div style={{ fontSize: 12, color: t.textDim }}>{lastNote.date}</div>
        </Card>
      )}

      {/* Injury alert */}
      {client.injuries && client.injuries !== "Sin lesiones actuales." && (
        <div style={{ background: t.dangerAlpha, border: `1.5px solid rgba(224,90,90,0.2)`, borderRadius: 16, padding: "14px 16px", display: "flex", gap: 12 }}>
          <div style={{ color: t.danger, flexShrink: 0, marginTop: 1 }}><Icon n="alert" s={18}/></div>
          <div>
            <div style={{ fontSize: 10, color: t.danger, fontWeight: 700, letterSpacing: "0.05em", marginBottom: 4 }}>LIMITACIONES ACTUALES</div>
            <div style={{ fontSize: 14, color: t.text, lineHeight: 1.55 }}>{client.injuries}</div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── RoutineDayDetail — full screen day view ──────────────────────────────────
const RoutineDayDetail = ({ day, dayIndex, totalDays, onBack }) => (
  <div style={{ animation: "fadeUp 0.22s ease" }}>
    {/* Back header */}
    <button onClick={onBack}
      style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", color: t.textSub, fontFamily: "inherit", fontSize: 13, fontWeight: 600, marginBottom: 20, padding: 0 }}>
      <Icon n="back" s={16}/> Todos los días
    </button>

    {/* Day header */}
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: t.accentAlpha, border: `1.5px solid rgba(30,155,191,0.3)`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 900, color: t.accent }}>{dayIndex + 1}</span>
        </div>
        <div>
          <div style={{ fontSize: 19, fontWeight: 900, color: t.text, letterSpacing: "-0.02em" }}>{day.name}</div>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 1 }}>{day.exercises.length} ejercicios · Día {dayIndex + 1} de {totalDays}</div>
        </div>
      </div>
    </div>

    {/* Exercise list */}
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
      {day.exercises.map((ex, j) => (
        <div key={j} style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "flex-start", gap: 14 }}>
          {/* Index */}
          <div style={{ width: 28, height: 28, borderRadius: 8, background: t.bgElevated, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: t.textSub }}>{j + 1}</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: t.text, marginBottom: 6 }}>{ex.name}</div>
            {/* Series / Reps / Rest chips */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: ex.notes ? 8 : 0 }}>
              <span style={{ background: t.accentAlpha, border: `1px solid rgba(30,155,191,0.2)`, borderRadius: 20, padding: "4px 10px", fontSize: 12, fontWeight: 700, color: t.accent }}>
                {ex.sets} series
              </span>
              <span style={{ background: t.accentAlpha, border: `1px solid rgba(30,155,191,0.2)`, borderRadius: 20, padding: "4px 10px", fontSize: 12, fontWeight: 700, color: t.accent }}>
                {ex.reps} reps
              </span>
              <span style={{ background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 20, padding: "4px 10px", fontSize: 12, fontWeight: 600, color: t.textSub }}>
                ⏱ {ex.rest}
              </span>
            </div>
            {ex.notes && (
              <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.5, fontStyle: "italic" }}>
                💬 {ex.notes}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>

    {/* Coach tip */}
    {day.coachTip && (
      <div style={{ background: "linear-gradient(135deg, rgba(30,155,191,0.1), rgba(30,155,191,0.04))", border: `1.5px solid rgba(30,155,191,0.22)`, borderRadius: 16, padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 18 }}>💡</span>
          <span style={{ fontSize: 11, color: t.accent, fontWeight: 800, letterSpacing: "0.06em" }}>RECOMENDACIONES DEL COACH</span>
        </div>
        <div style={{ fontSize: 14, color: t.text, lineHeight: 1.7 }}>{day.coachTip}</div>
      </div>
    )}
  </div>
);

// ─── CRoutine — client routine view ──────────────────────────────────────────
const CRoutine = ({ routine }) => {
  const [selectedDay, setSelectedDay] = useState(null);
  if (!routine) return <Empty icon="dumbbell" text="Sin rutina asignada aún" />;

  // Day detail view
  if (selectedDay !== null) {
    const day = routine.days[selectedDay];
    return (
      <RoutineDayDetail
        day={day}
        dayIndex={selectedDay}
        totalDays={routine.days.length}
        onBack={() => setSelectedDay(null)}
      />
    );
  }

  // Day list view
  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 13, color: t.textSub, fontWeight: 600 }}>{routine.name}</div>
        <div style={{ fontSize: 12, color: t.textDim, marginTop: 2 }}>{routine.days.length} días de entrenamiento</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {routine.days.map((day, i) => (
          <button key={day.id} onClick={() => setSelectedDay(i)}
            style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 16, padding: "16px 18px", display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "inherit", textAlign: "left", width: "100%", transition: "border-color 0.15s, transform 0.1s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(30,155,191,0.3)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = t.border; e.currentTarget.style.transform = "none"; }}
            onTouchStart={e => e.currentTarget.style.transform = "scale(0.98)"}
            onTouchEnd={e => e.currentTarget.style.transform = "scale(1)"}
          >
            {/* Day number */}
            <div style={{ width: 44, height: 44, borderRadius: 12, background: t.bgElevated, border: `1.5px solid ${t.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <span style={{ fontSize: 16, fontWeight: 900, color: t.accent }}>{i + 1}</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: t.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{day.name}</div>
              <div style={{ fontSize: 12, color: t.textSub, marginTop: 3 }}>
                {day.exercises.length} ejercicios
                {day.coachTip ? " · 💡 Recomendaciones" : ""}
              </div>
            </div>
            <div style={{ color: t.textDim, flexShrink: 0 }}>
              <Icon n="back" s={16} style={{ transform: "rotate(180deg)" }}/>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

// ─── v1.2 DIET SECTION CONFIG ─────────────────────────────────────────────────
const SECTION_CONFIG = {
  protein:     { label: "Proteína",      color: "#0D8EAD", bg: "rgba(13,142,173,0.10)", border: "rgba(13,142,173,0.25)", emoji: "🥩" },
  carbs:       { label: "Carbohidratos", color: "#a78bfa", bg: "rgba(167,139,250,0.10)", border: "rgba(167,139,250,0.25)", emoji: "🌾" },
  fats:        { label: "Grasas",        color: "#f0a030", bg: "rgba(240,160,48,0.10)",  border: "rgba(240,160,48,0.25)",  emoji: "🫒" },
  extras:      { label: "Adicionales",   color: "#6ee7b7", bg: "rgba(110,231,183,0.10)", border: "rgba(110,231,183,0.25)", emoji: "➕" },
  intraWorkout:{ label: "Intra-Entreno", color: "#38bdf8", bg: "rgba(56,189,248,0.10)",  border: "rgba(56,189,248,0.25)",  emoji: "⚡" },
};

// Section block (protein / carbs / fats / extras / intraWorkout)
const MealSection = ({ section }) => {
  const cfg = SECTION_CONFIG[section.type] || SECTION_CONFIG.extras;
  return (
    <div style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8 }}>
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 15 }}>{cfg.emoji}</span>
        <span style={{ fontSize: 11, fontWeight: 800, color: cfg.color, letterSpacing: "0.07em", textTransform: "uppercase" }}>{section.title || cfg.label}</span>
        {(section.type === "protein" || section.type === "carbs" || section.type === "fats") && (
          <span style={{ fontSize: 10, color: cfg.color, opacity: 0.6, marginLeft: "auto" }}>Elige 1 opción</span>
        )}
      </div>
      {/* Items */}
      <div>
        {section.items.map((item, i) => {
          const hasComponents = item.components && item.components.length > 1;
          return (
            <div key={item.id || i} style={{ padding: "9px 0", borderBottom: i < section.items.length - 1 ? `1px solid rgba(255,255,255,0.05)` : "none" }}>
              {hasComponents ? (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, color: cfg.color, letterSpacing: "0.04em", marginBottom: 6 }}>OPCIÓN {String.fromCharCode(65 + i)} · combinación</div>
                  {item.components.map(comp => (
                    <div key={comp.id} style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 8, marginBottom: 4 }}>
                      <div style={{ width: 28, height: 28, borderRadius: 7, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>
                        {comp.emoji || "🍽️"}
                      </div>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: t.text }}>{comp.name}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: cfg.color }}>{comp.grams}g</div>
                    </div>
                  ))}
                </>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 9, background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                    {item.emoji || "🍽️"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{item.name}</div>
                    {item.notes && <div style={{ fontSize: 11, color: t.textSub, marginTop: 1 }}>{item.notes}</div>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: cfg.color, flexShrink: 0 }}>{item.amount}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Meal card (expandable)
const MealCard = ({ meal, index }) => {
  const [open, setOpen] = useState(index === 0);
  return (
    <div style={{ borderRadius: 18, overflow: "hidden", border: `1.5px solid ${open ? "rgba(13,142,173,0.3)" : t.border}`, background: t.bgCard, marginBottom: 12, transition: "border-color 0.2s" }}>
      {/* Header — always visible, tap to expand */}
      <button onClick={() => setOpen(o => !o)}
        style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "16px 18px", display: "flex", alignItems: "center", gap: 14, fontFamily: "inherit", textAlign: "left" }}>
        {/* Meal number badge */}
        <div style={{ width: 42, height: 42, borderRadius: 12, background: open ? "rgba(13,142,173,0.2)" : "rgba(255,255,255,0.05)", border: `1.5px solid ${open ? "rgba(13,142,173,0.4)" : t.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.2s" }}>
          <span style={{ fontSize: 16, fontWeight: 900, color: open ? t.accent : t.textSub }}>{index + 1}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: t.text, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meal.title}</div>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meal.subtitle}{meal.time ? ` · ${meal.time}` : ""}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
          <Pill>{meal.kcal} kcal</Pill>
          <div style={{ color: open ? t.accent : t.textDim, transition: "transform 0.2s, color 0.2s", transform: open ? "rotate(180deg)" : "none" }}>
            <Icon n="down" s={16}/>
          </div>
        </div>
      </button>

      {/* Body — sections */}
      {open && (
        <div style={{ padding: "0 14px 14px", animation: "fadeUp 0.2s ease" }}>
          <div style={{ height: 1, background: t.border, marginBottom: 14 }}/>
          {meal.sections && meal.sections.map((section, si) => (
            <MealSection key={section.id || si} section={section}/>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── CDiet — main client diet view (v1.2) ─────────────────────────────────────
const CDiet = ({ diet }) => {
  if (!diet) return <Empty icon="food" text="Sin dieta asignada aún" />;

  const macros = [
    { label: "Kcal",     value: diet.calories,        color: t.warn    },
    { label: "Proteína", value: diet.protein + "g",   color: t.accent  },
    { label: "Carbos",   value: diet.carbs + "g",     color: "#a78bfa" },
    { label: "Grasa",    value: diet.fat + "g",       color: t.textSub },
  ];

  return (
    <div>
      {/* Diet name */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: t.textSub, fontWeight: 600 }}>{diet.name}</div>
      </div>

      {/* Macros bar — unchanged from v1.1 */}
      <Card accent style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
          {macros.map(m => (
            <div key={m.label} style={{ textAlign: "center", padding: "10px 4px" }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: m.color, letterSpacing: "-0.02em" }}>{m.value}</div>
              <div style={{ fontSize: 10, color: t.textSub, fontWeight: 600, marginTop: 3 }}>{m.label}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Meal cards */}
      <div>
        {diet.meals.map((meal, i) => (
          <MealCard key={meal.id || i} meal={meal} index={i}/>
        ))}
      </div>
    </div>
  );
};

const CWeight = ({ client, weights, db, setDb }) => {
  const [val, setVal] = useState("");
  const add = async () => {
    const w = parseFloat(val); if (isNaN(w)) return;
    const date = new Date().toISOString().slice(0, 10);
    // Update local state
    setDb(p => ({ ...p, weightHistory: { ...p.weightHistory, [client.id]: [...(p.weightHistory[client.id]||[]), { date, weight: w }] } }));
    setVal("");
    // Sync to Supabase
    await sb.insert("weight_entries", { client_id: client.id, date, weight_kg: w });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card accent><WeightChart data={weights}/></Card>

      {/* Add */}
      <Card>
        <div style={{ fontSize: 11, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 12 }}>REGISTRAR HOY</div>
        <div style={{ display: "flex", gap: 10 }}>
          <input value={val} onChange={e => setVal(e.target.value)} type="number" step="0.1" placeholder="ej: 75.5"
            style={{ flex: 1, background: t.bgInput, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "13px 16px", color: t.text, fontSize: 16, fontFamily: "inherit", outline: "none" }}/>
          <Btn onClick={add} style={{ paddingLeft: 18, paddingRight: 18 }}><Icon n="plus" s={17}/></Btn>
        </div>
      </Card>

      {/* History */}
      <div>
        <div style={{ fontSize: 11, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 10 }}>HISTORIAL</div>
        <Card>
          {[...weights].reverse().slice(0,10).map((w,i,arr) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 0", borderBottom: i < arr.length-1 ? `1px solid ${t.border}` : "none" }}>
              <span style={{ fontSize: 14, color: t.textSub }}>{w.date}</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: t.text }}>{w.weight} <span style={{ fontSize: 12, color: t.textDim, fontWeight: 500 }}>kg</span></span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
};

const CNotes = ({ client, notes }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    {client.injuries && (
      <div style={{ background: t.dangerAlpha, border: `1.5px solid rgba(224,90,90,0.2)`, borderRadius: 16, padding: "16px 18px" }}>
        <div style={{ fontSize: 10, color: t.danger, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 6 }}>LESIONES / LIMITACIONES</div>
        <div style={{ fontSize: 14, color: t.text, lineHeight: 1.6 }}>{client.injuries}</div>
      </div>
    )}
    {client.personalNotes && (
      <Card>
        <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 6 }}>NOTAS PERSONALES</div>
        <div style={{ fontSize: 14, color: t.text, lineHeight: 1.6 }}>{client.personalNotes}</div>
      </Card>
    )}
    <div style={{ fontSize: 11, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em" }}>NOTAS DEL COACH</div>
    {notes.length===0 && <Empty icon="notes" text="Sin notas aún"/>}
    {notes.map((n,i) => (
      <Card key={i}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Pill color={n.type==="injury"?"danger":n.type==="progress"?"accent":n.type==="nutrition"?"accent":"default"}>
            {n.type==="injury"?"Lesión":n.type==="progress"?"Progreso":n.type==="nutrition"?"Nutrición":"General"}
          </Pill>
          <span style={{ fontSize: 12, color: t.textDim }}>{n.date}</span>
        </div>
        <div style={{ fontSize: 14, color: t.text, lineHeight: 1.6 }}>{n.note}</div>
      </Card>
    ))}
  </div>
);

// ─── AdminSettings — change password/username ─────────────────────────────────
const AdminSettings = ({ onBack, onChangelog }) => {
  const { currentUser, db, setDb, setCurrentUser } = useApp();
  const [name, setName] = useState(currentUser.name);
  const [email, setEmail] = useState(currentUser.email);
  const [password, setPassword] = useState("");
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    if (!name.trim() || !email.trim()) { setErr("Nombre y usuario son obligatorios"); return; }
    setErr("");
    const updated = { ...currentUser, name, email, password: password || currentUser.password };
    // Update in Supabase admins table
    await sb.upsert("admins", { id: currentUser.id, name, email, password: password || currentUser.password, role: currentUser.role });
    // Update local state
    setDb(p => ({ ...p, users: p.users.map(u => u.id === currentUser.id ? updated : u) }));
    setCurrentUser(updated);
    setSaved(true); setTimeout(() => setSaved(false), 2000);
    if (password) setPassword("");
  };

  return (
    <div>
      <button onClick={onBack} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", color:t.textSub, fontFamily:"inherit", fontSize:13, fontWeight:600, marginBottom:20, padding:0 }}>
        <Icon n="back" s={16}/> Volver
      </button>
      <div style={{ fontSize: 20, fontWeight: 900, color: t.text, marginBottom: 20 }}>Mis ajustes</div>
      <Card>
        <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 16 }}>MI PERFIL</div>
        <Field label="NOMBRE" value={name} onChange={setName}/>
        <Field label="USUARIO (login)" value={email} onChange={setEmail}/>
        <Field label="NUEVA CONTRASEÑA" value={password} onChange={setPassword} type="password" placeholder="Dejar vacío para no cambiar"/>
        {err && <div style={{ color: t.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <Btn onClick={save} variant={saved?"ghost":"primary"}>
          {saved ? <><Icon n="check" s={14}/> Guardado</> : <><Icon n="edit" s={14}/> Guardar cambios</>}
        </Btn>
      </Card>
      {onChangelog && (
        <button onClick={onChangelog}
          style={{ marginTop: 12, width: "100%", background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 14, padding: "14px 18px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
          <div style={{ width: 40, height: 40, borderRadius: 11, background: t.accentAlpha, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>📋</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>Historial de actualizaciones</div>
            <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>Ver todos los cambios por versión</div>
          </div>
          <Icon n="back" s={16} style={{ transform: "rotate(180deg)", color: t.textDim }}/>
        </button>
      )}
    </div>
  );
};

// ─── AdminBaseDiets — manage editable base diets ─────────────────────────────
const AdminBaseDiets = ({ onBack }) => {
  const { currentUser, customFoods } = useApp();
  const [selectedId, setSelectedId] = useState(null);
  const [diets, setDiets] = useState({});
  const [loading, setLoading] = useState(true);

  const ALL_FOODS = [...FOOD_DB, ...(customFoods || []).map(f => ({
    name: f.name, emoji: f.emoji || "🍽️",
    prot: +f.prot, carb: +f.carb, fat: +f.fat, kcal: +f.kcal,
    cat: f.cat, custom: true,
  }))];

  const load = async () => {
    setLoading(true);
    try {
      const rows = await sb.select("base_diets", "?order=id");
      const map = {};
      (rows || []).forEach(r => { map[r.id] = r; });
      setDiets(map);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  if (selectedId) {
    return <BaseDietEditor baseDietId={selectedId} initialMeals={diets[selectedId]?.meals || []}
      baseDietName={diets[selectedId]?.name || selectedId}
      allFoods={ALL_FOODS} currentUser={currentUser}
      onBack={() => { setSelectedId(null); load(); }}/>;
  }

  const diet1800 = diets["female-1800"];
  const diet3000 = diets["male-3000"];
  const countMeals = d => d?.meals?.length || 0;

  return (
    <div>
      <button onClick={onBack} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", color:t.textSub, fontFamily:"inherit", fontSize:13, fontWeight:600, marginBottom:20, padding:0 }}>
        <Icon n="back" s={16}/> Volver
      </button>
      <div style={{ fontSize: 20, fontWeight: 900, color: t.text, marginBottom: 6 }}>Dietas base</div>
      <div style={{ fontSize: 13, color: t.textSub, marginBottom: 20 }}>Estas son las plantillas que se aplican con "Generar dieta base"</div>

      {loading && <div style={{ textAlign:"center", color:t.textSub, padding:40, animation:"pulse 1.5s infinite" }}>Cargando...</div>}

      {!loading && (
        <>
          <button onClick={() => setSelectedId("female-1800")}
            style={{ width: "100%", background: t.bgCard, border: `1.5px solid rgba(224,90,138,0.25)`, borderRadius: 14, padding: "16px 18px", marginBottom: 12, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg, #e05a8a, #c04070)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: "white", fontWeight: 900 }}>♀</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: t.text }}>Mujer · 1800 kcal</div>
              <div style={{ fontSize: 12, color: t.textSub, marginTop: 3 }}>
                {countMeals(diet1800) === 0 ? "Usando plantilla por defecto" : `${countMeals(diet1800)} comida${countMeals(diet1800) !== 1 ? "s" : ""} · Personalizada`}
              </div>
            </div>
            <Icon n="back" s={16} style={{ transform: "rotate(180deg)", color: t.textDim }}/>
          </button>

          <button onClick={() => setSelectedId("male-3000")}
            style={{ width: "100%", background: t.bgCard, border: `1.5px solid rgba(30,155,191,0.25)`, borderRadius: 14, padding: "16px 18px", marginBottom: 12, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: `linear-gradient(135deg, ${t.accent}, ${t.accentDim})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: "white", fontWeight: 900 }}>♂</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: t.text }}>Hombre · 3000 kcal</div>
              <div style={{ fontSize: 12, color: t.textSub, marginTop: 3 }}>
                {countMeals(diet3000) === 0 ? "Usando plantilla por defecto" : `${countMeals(diet3000)} comida${countMeals(diet3000) !== 1 ? "s" : ""} · Personalizada`}
              </div>
            </div>
            <Icon n="back" s={16} style={{ transform: "rotate(180deg)", color: t.textDim }}/>
          </button>

          <div style={{ fontSize: 11, color: t.textDim, marginTop: 14, lineHeight: 1.6, padding: "12px 14px", background: t.bgElevated, borderRadius: 10 }}>
            💡 Al editar una dieta base, cuando el admin pulse "Generar dieta base" en el perfil de un cliente se aplicará la versión guardada aquí. Si no se edita ninguna, se usa la plantilla por defecto del código.
          </div>
        </>
      )}
    </div>
  );
};

// ─── BaseDietEditor — same editor as AEditDiet but saves to base_diets ───────
const BaseDietEditor = ({ baseDietId, initialMeals, baseDietName, allFoods, currentUser, onBack }) => {
  const [meals, setMeals] = useState(initialMeals);
  const [openMeal, setOpenMeal] = useState(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Defaults helper (reused)
  const mkDefaultMeals = () => {
    if (baseDietId === "female-1800") {
      return [
        { id:"m1", title:"Comida 1", subtitle:"Desayuno", time:"08:00", sections:[
          {id:"s-p-m1",type:"protein",title:"Proteínas",items:[mkItem2("Claras de huevo",200,allFoods),mkItem2("Huevos enteros",100,allFoods)].filter(Boolean)},
          {id:"s-c-m1",type:"carbs",title:"Hidratos",items:[mkItem2("Avena",50,allFoods),mkItem2("Pan",60,allFoods)].filter(Boolean)},
          {id:"s-f-m1",type:"fat",title:"Grasas",items:[mkItem2("Crema cacahuete",15,allFoods),mkItem2("Aguacate",50,allFoods)].filter(Boolean)},
        ]},
        { id:"m2", title:"Comida 2", subtitle:"Almuerzo", time:"14:00", sections:[
          {id:"s-p-m2",type:"protein",title:"Proteínas",items:[mkItem2("Pollo / Pavo",130,allFoods),mkItem2("Ternera (magra)",120,allFoods)].filter(Boolean)},
          {id:"s-c-m2",type:"carbs",title:"Hidratos",items:[mkItem2("Arroz (seco)",70,allFoods),mkItem2("Pasta (seca)",65,allFoods)].filter(Boolean)},
          {id:"s-f-m2",type:"fat",title:"Grasas",items:[mkItem2("AOVE (Aceite)",10,allFoods),mkItem2("Aguacate",60,allFoods)].filter(Boolean)},
        ]},
        { id:"m3", title:"Comida 3", subtitle:"Cena", time:"21:00", sections:[
          {id:"s-p-m3",type:"protein",title:"Proteínas",items:[mkItem2("Pescado blanco",180,allFoods),mkItem2("Salmón ahumado",120,allFoods)].filter(Boolean)},
          {id:"s-c-m3",type:"carbs",title:"Hidratos",items:[mkItem2("Patata",250,allFoods),mkItem2("Boniato",220,allFoods)].filter(Boolean)},
          {id:"s-f-m3",type:"fat",title:"Grasas",items:[mkItem2("AOVE (Aceite)",10,allFoods),mkItem2("Queso Havarti",25,allFoods)].filter(Boolean)},
        ]},
        { id:"m4", title:"Comida Post-Entreno", subtitle:"Después del entrenamiento", time:"18:00", sections:[
          {id:"s-p-m4",type:"protein",title:"Proteínas",items:[mkItem2("Whey Protein",30,allFoods),mkItem2("Yogur de proteína",200,allFoods)].filter(Boolean)},
          {id:"s-c-m4",type:"carbs",title:"Hidratos",items:[mkItem2("Crema de arroz",50,allFoods),mkItem2("Corn Flakes 0%",50,allFoods)].filter(Boolean)},
          {id:"s-f-m4",type:"fat",title:"Grasas",items:[mkItem2("Frutos secos",30,allFoods),mkItem2("Chocolate 85%",20,allFoods)].filter(Boolean)},
        ]},
      ];
    }
    return [
      { id:"m1", title:"Comida 1", subtitle:"Desayuno", time:"08:00", sections:[
        {id:"s-p-m1",type:"protein",title:"Proteínas",items:[mkItem2("Claras de huevo",250,allFoods),mkItem2("Huevos enteros",150,allFoods)].filter(Boolean)},
        {id:"s-c-m1",type:"carbs",title:"Hidratos",items:[mkItem2("Avena",80,allFoods),mkItem2("Pan",100,allFoods)].filter(Boolean)},
        {id:"s-f-m1",type:"fat",title:"Grasas",items:[mkItem2("Crema cacahuete",20,allFoods),mkItem2("Aguacate",70,allFoods)].filter(Boolean)},
      ]},
      { id:"m2", title:"Comida 2", subtitle:"Almuerzo", time:"14:00", sections:[
        {id:"s-p-m2",type:"protein",title:"Proteínas",items:[mkItem2("Pollo / Pavo",250,allFoods),mkItem2("Ternera (magra)",230,allFoods)].filter(Boolean)},
        {id:"s-c-m2",type:"carbs",title:"Hidratos",items:[mkItem2("Arroz (seco)",110,allFoods),mkItem2("Pasta (seca)",100,allFoods)].filter(Boolean)},
        {id:"s-f-m2",type:"fat",title:"Grasas",items:[mkItem2("AOVE (Aceite)",12,allFoods),mkItem2("Aguacate",80,allFoods)].filter(Boolean)},
      ]},
      { id:"m3", title:"Comida 3", subtitle:"Cena", time:"21:00", sections:[
        {id:"s-p-m3",type:"protein",title:"Proteínas",items:[mkItem2("Pescado blanco",300,allFoods),mkItem2("Salmón ahumado",200,allFoods)].filter(Boolean)},
        {id:"s-c-m3",type:"carbs",title:"Hidratos",items:[mkItem2("Patata",450,allFoods),mkItem2("Boniato",400,allFoods)].filter(Boolean)},
        {id:"s-f-m3",type:"fat",title:"Grasas",items:[mkItem2("AOVE (Aceite)",12,allFoods),mkItem2("Queso Havarti",35,allFoods)].filter(Boolean)},
      ]},
      { id:"m4", title:"Comida Post-Entreno", subtitle:"Después del entrenamiento", time:"18:00", sections:[
        {id:"s-p-m4",type:"protein",title:"Proteínas",items:[mkItem2("Whey Protein",60,allFoods),mkItem2("Yogur de proteína",400,allFoods)].filter(Boolean)},
        {id:"s-c-m4",type:"carbs",title:"Hidratos",items:[mkItem2("Crema de arroz",80,allFoods),mkItem2("Corn Flakes 0%",80,allFoods)].filter(Boolean)},
        {id:"s-f-m4",type:"fat",title:"Grasas",items:[mkItem2("Frutos secos",30,allFoods),mkItem2("Chocolate 85%",25,allFoods)].filter(Boolean)},
      ]},
    ];
  };

  useEffect(() => {
    if (!meals || meals.length === 0) {
      setMeals(mkDefaultMeals());
    }
  }, []);

  // Auto-calculate totals — only first option (A) of each section
  const totals = (() => {
    let kcal = 0, prot = 0, carb = 0, fat = 0;
    (meals || []).forEach(m => {
      (m.sections || []).forEach(s => {
        const firstItem = s.items?.[0];
        if (firstItem?.macros) {
          kcal += +firstItem.macros.kcal || 0;
          prot += +firstItem.macros.prot || 0;
          carb += +firstItem.macros.carb || 0;
          fat  += +firstItem.macros.fat  || 0;
        }
      });
    });
    return { kcal: Math.round(kcal), prot: prot.toFixed(0), carb: carb.toFixed(0), fat: fat.toFixed(0) };
  })();

  const save = async () => {
    setSaving(true);
    await sb.upsert("base_diets", {
      id: baseDietId, name: baseDietName, gender: baseDietId.startsWith("female") ? "female" : "male",
      meals, updated_by: currentUser.id, updated_at: new Date().toISOString(),
    });
    setSaved(true); setSaving(false);
    setTimeout(() => setSaved(false), 2000);
  };

  const resetToDefault = () => {
    if (!confirm("Esto eliminará tus cambios y restaurará la plantilla original. ¿Continuar?")) return;
    setMeals(mkDefaultMeals());
  };

  const updMeal = (id, k, v) => setMeals(p => p.map(m => m.id === id ? { ...m, [k]: v } : m));
  const rmMeal = id => setMeals(p => p.filter(m => m.id !== id));
  const addMeal = () => {
    const id = "m" + Date.now();
    setMeals(p => [...p, {
      id, title: `Comida ${p.length + 1}`, subtitle: "", time: "",
      sections: [
        { id: "s-p-" + id, type: "protein", title: "Proteínas", items: [] },
        { id: "s-c-" + id, type: "carbs", title: "Hidratos", items: [] },
        { id: "s-f-" + id, type: "fat", title: "Grasas", items: [] },
      ],
    }]);
    setOpenMeal(id);
  };

  const rmItem = (mealId, secId, iid) => setMeals(p => p.map(m => m.id !== mealId ? m : { ...m, sections: m.sections.map(s => s.id !== secId ? s : { ...s, items: s.items.filter(i => i.id !== iid) }) }));

  const updItemGrams = (mealId, secId, iid, newGrams) => {
    setMeals(p => p.map(m => m.id !== mealId ? m : { ...m, sections: m.sections.map(s => s.id !== secId ? s : { ...s, items: s.items.map(i => {
      if (i.id !== iid) return i;
      const food = allFoods.find(f => f.name === i.foodName);
      if (!food) return { ...i, amount: `${newGrams}g`, grams: +newGrams };
      const g = +newGrams || 0;
      return { ...i, amount: `${g}g`, grams: g, macros: {
        kcal: Math.round((food.kcal * g) / 100),
        prot: ((food.prot * g) / 100).toFixed(1),
        carb: ((food.carb * g) / 100).toFixed(1),
        fat:  ((food.fat  * g) / 100).toFixed(1),
      } };
    }) }) }));
  };

  const addFoodItem = (mealId, secId, food, grams) => {
    const g = +grams || 100;
    const macros = {
      kcal: Math.round((food.kcal * g) / 100),
      prot: ((food.prot * g) / 100).toFixed(1),
      carb: ((food.carb * g) / 100).toFixed(1),
      fat:  ((food.fat  * g) / 100).toFixed(1),
    };
    const iid = "i" + Date.now();
    setMeals(p => p.map(m => m.id !== mealId ? m : { ...m, sections: m.sections.map(s => s.id !== secId ? s : { ...s, items: [...s.items, { id: iid, name: food.name, emoji: food.emoji, amount: `${g}g`, grams: g, foodName: food.name, macros }] }) }));
  };

  const secConfig = {
    protein: { label: "🥩 Proteínas", cat: "proteina",     color: "#e05a5a", border: "rgba(224,90,90,0.25)" },
    carbs:   { label: "🍚 Hidratos",  cat: "carbohidrato", color: "#f0a030", border: "rgba(240,160,48,0.25)" },
    fat:     { label: "🥑 Grasas",    cat: "grasa",        color: "#8ac942", border: "rgba(138,201,66,0.25)" },
  };
  const letters = ["A","B","C","D","E","F","G","H"];
  const si = { background:t.bg, border:`1px solid ${t.border}`, borderRadius:8, padding:"8px 10px", color:t.text, fontSize:12, fontFamily:"inherit", outline:"none" };

  return (
    <div>
      <button onClick={onBack} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", color:t.textSub, fontFamily:"inherit", fontSize:13, fontWeight:600, marginBottom:20, padding:0 }}>
        <Icon n="back" s={16}/> Volver a dietas base
      </button>
      <div style={{ fontSize: 20, fontWeight: 900, color: t.text, marginBottom: 16 }}>{baseDietName}</div>

      {/* Totals */}
      <div style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 14, padding: "14px 16px", marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 4 }}>MACROS TOTALES (Opción A)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, textAlign: "center", marginTop: 10 }}>
          {[["🔥","Kcal",totals.kcal,""],["💪","Prot",totals.prot,"g"],["🌾","Carbs",totals.carb,"g"],["🥑","Grasas",totals.fat,"g"]].map(([ico,lbl,val,unit]) => (
            <div key={lbl} style={{ background: t.bgElevated, borderRadius: 10, padding: "10px 4px" }}>
              <div style={{ fontSize: 16 }}>{ico}</div>
              <div style={{ fontSize: 17, fontWeight: 900, color: t.text }}>{val}{unit}</div>
              <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700 }}>{lbl}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Meals */}
      {(meals || []).map(meal => {
        const isOpen = openMeal === meal.id;
        return (
          <div key={meal.id} style={{ border: `1.5px solid ${isOpen ? "rgba(13,142,173,0.3)" : t.border}`, borderRadius: 14, marginBottom: 10, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", background: isOpen ? "rgba(13,142,173,0.06)" : "transparent" }}>
              <button onClick={() => setOpenMeal(isOpen ? null : meal.id)}
                style={{ flex: 1, background: "none", border: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ color: isOpen ? t.accent : t.textDim, transform: isOpen ? "rotate(180deg)" : "none" }}><Icon n="down" s={15}/></div>
                <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>{meal.title}</div>
              </button>
              <button onClick={() => rmMeal(meal.id)} style={{ background: t.dangerAlpha, border: "none", borderRadius: 8, padding: "0 10px", height: 32, cursor: "pointer", color: t.danger, display: "flex", alignItems: "center" }}><Icon n="trash" s={13}/></button>
            </div>

            {isOpen && (
              <div style={{ padding: "0 14px 14px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
                  <div>
                    <div style={{ color: t.textSub, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>TÍTULO</div>
                    <input value={meal.title} onChange={e => updMeal(meal.id, "title", e.target.value)} style={{ ...si, width: "100%", boxSizing: "border-box" }}/>
                  </div>
                  <div>
                    <div style={{ color: t.textSub, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>SUBTÍTULO</div>
                    <input value={meal.subtitle || ""} onChange={e => updMeal(meal.id, "subtitle", e.target.value)} style={{ ...si, width: "100%", boxSizing: "border-box" }}/>
                  </div>
                  <div>
                    <div style={{ color: t.textSub, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>HORA</div>
                    <input value={meal.time || ""} onChange={e => updMeal(meal.id, "time", e.target.value)} style={{ ...si, width: "100%", boxSizing: "border-box" }}/>
                  </div>
                </div>

                {(meal.sections || []).map(sec => {
                  const cfg = secConfig[sec.type] || secConfig.protein;
                  const foodOptions = allFoods.filter(f => f.cat === cfg.cat);
                  return (
                    <div key={sec.id} style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${cfg.border}`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: cfg.color, marginBottom: 8 }}>{cfg.label}</div>
                      {(sec.items || []).map((item, idx) => (
                        <div key={item.id} style={{ background: t.bg, border: `1px solid ${t.border}`, borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                            <div style={{ background: cfg.color, color: "white", borderRadius: 8, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 900 }}>{letters[idx] || "?"}</div>
                            <span style={{ fontSize: 16 }}>{item.emoji || "🍽️"}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, color: t.text, fontWeight: 700 }}>Opción {letters[idx]}: {item.name}</div>
                              {item.macros && <div style={{ fontSize: 10, color: t.textDim, marginTop: 2 }}>{item.macros.kcal} kcal · {item.macros.prot}P · {item.macros.carb}C · {item.macros.fat}G</div>}
                            </div>
                            <button onClick={() => rmItem(meal.id, sec.id, item.id)} style={{ background: t.dangerAlpha, border: "none", borderRadius: 8, width: 28, height: 28, cursor: "pointer", color: t.danger, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon n="x" s={13}/></button>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
                            <button onClick={() => updItemGrams(meal.id, sec.id, item.id, Math.max(0, (item.grams || 100) - 10))}
                              style={{ background: t.bgElevated, border: `1.5px solid ${t.border}`, borderRadius: 8, width: 36, height: 36, cursor: "pointer", color: t.text, fontSize: 18, fontWeight: 900 }}>−</button>
                            <div style={{ background: t.bgElevated, borderRadius: 8, padding: "8px 16px", minWidth: 80, textAlign: "center" }}>
                              <div style={{ fontSize: 16, fontWeight: 900, color: cfg.color }}>{item.grams || 100}<span style={{ fontSize: 11, color: t.textSub, marginLeft: 2 }}>g</span></div>
                            </div>
                            <button onClick={() => updItemGrams(meal.id, sec.id, item.id, (item.grams || 100) + 10)}
                              style={{ background: t.bgElevated, border: `1.5px solid ${t.border}`, borderRadius: 8, width: 36, height: 36, cursor: "pointer", color: t.text, fontSize: 18, fontWeight: 900 }}>+</button>
                          </div>
                        </div>
                      ))}
                      <FoodSelector foods={foodOptions} onAdd={(food, grams) => addFoodItem(meal.id, sec.id, food, grams)} accentColor={cfg.color} nextLetter={letters[sec.items?.length || 0] || "?"}/>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 10, marginTop: 6, marginBottom: 16 }}>
        <Btn onClick={addMeal} variant="ghost" size="sm"><Icon n="plus" s={14}/> Comida</Btn>
        <Btn onClick={save} disabled={saving} size="sm">
          {saving ? "Guardando..." : saved ? <><Icon n="check" s={14}/> Guardado</> : <><Icon n="edit" s={14}/> Guardar plantilla</>}
        </Btn>
      </div>

      <button onClick={resetToDefault}
        style={{ background: "none", border: `1px solid ${t.border}`, borderRadius: 10, padding: "10px 16px", cursor: "pointer", color: t.textSub, fontSize: 12, fontFamily: "inherit", width: "100%" }}>
        🔄 Restaurar plantilla original
      </button>
    </div>
  );
};

// Helper for BaseDietEditor (similar to mkItem in AEditDiet)
const mkItem2 = (foodName, grams, foods) => {
  const food = foods.find(f => f.name === foodName);
  if (!food) return null;
  const g = +grams;
  return {
    id: "i" + Date.now() + Math.random().toString(36).slice(2, 7),
    name: food.name, emoji: food.emoji, amount: `${g}g`, grams: g, foodName: food.name,
    macros: {
      kcal: Math.round((food.kcal * g) / 100),
      prot: ((food.prot * g) / 100).toFixed(1),
      carb: ((food.carb * g) / 100).toFixed(1),
      fat:  ((food.fat  * g) / 100).toFixed(1),
    },
  };
};

// ─── AdminFoods — manage custom food database ────────────────────────────────
const AdminFoods = ({ onBack }) => {
  const { currentUser, customFoods, loadCustomFoods } = useApp();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", emoji: "🍽️", cat: "proteina", prot: "", carb: "", fat: "", kcal: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => { loadCustomFoods(); }, []);

  const resetForm = () => {
    setForm({ name: "", emoji: "🍽️", cat: "proteina", prot: "", carb: "", fat: "", kcal: "" });
    setErr("");
  };

  const saveFood = async () => {
    if (!form.name.trim()) { setErr("Nombre obligatorio"); return; }
    if (!form.kcal) { setErr("Calorías obligatorias"); return; }
    setSaving(true); setErr("");
    try {
      await sb.insert("custom_foods", {
        name: form.name.trim(),
        emoji: form.emoji || "🍽️",
        cat: form.cat,
        prot: +form.prot || 0,
        carb: +form.carb || 0,
        fat: +form.fat || 0,
        kcal: +form.kcal || 0,
        created_by: currentUser.id,
      });
      await loadCustomFoods();
      resetForm();
      setShowAdd(false);
    } catch (e) {
      setErr("Error al guardar. ¿Quizá el nombre ya existe?");
    }
    setSaving(false);
  };

  const deleteFood = async (id, name) => {
    if (!confirm(`¿Eliminar "${name}"?`)) return;
    try {
      await sb.remove("custom_foods", "id", id);
      await loadCustomFoods();
    } catch {}
  };

  const catColor = cat => cat === "proteina" ? "#e05a5a" : cat === "carbohidrato" ? "#f0a030" : "#8ac942";
  const catLabel = cat => cat === "proteina" ? "🥩 Proteína" : cat === "carbohidrato" ? "🍚 Hidrato" : "🥑 Grasa";

  const filtered = customFoods.filter(f =>
    !search || f.name.toLowerCase().includes(search.toLowerCase())
  );

  const fld = k => ({ value: form[k] || "", onChange: v => setForm(p => ({ ...p, [k]: v })) });

  return (
    <div>
      <button onClick={onBack} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", color:t.textSub, fontFamily:"inherit", fontSize:13, fontWeight:600, marginBottom:20, padding:0 }}>
        <Icon n="back" s={16}/> Volver
      </button>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: t.text }}>Alimentos personalizados</div>
        <button onClick={() => { setShowAdd(s => !s); resetForm(); }}
          style={{ background: t.accentAlpha, border:`1.5px solid rgba(30,155,191,0.3)`, borderRadius:10, padding:"7px 14px", cursor:"pointer", color:t.accent, fontSize:12, fontWeight:700, fontFamily:"inherit" }}>
          {showAdd ? "Cancelar" : "+ Añadir"}
        </button>
      </div>
      <div style={{ fontSize: 13, color: t.textSub, marginBottom: 20 }}>Se añadirán a la base de datos para usarlos en las dietas</div>

      {/* Add form */}
      {showAdd && (
        <Card accent style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 14 }}>NUEVO ALIMENTO</div>

          <div style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: "0 12px" }}>
            <Field label="EMOJI" {...fld("emoji")} placeholder="🍽️"/>
            <Field label="NOMBRE" {...fld("name")} placeholder="ej: Atún natural"/>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ color: t.textSub, fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", marginBottom: 7 }}>CATEGORÍA</div>
            <div style={{ display: "flex", gap: 6 }}>
              {[["proteina","🥩 Proteína"],["carbohidrato","🍚 Hidrato"],["grasa","🥑 Grasa"]].map(([val, lbl]) => (
                <button key={val} onClick={() => setForm(p => ({ ...p, cat: val }))}
                  style={{ flex: 1, background: form.cat === val ? t.accentAlpha : t.bgElevated, border: `1.5px solid ${form.cat === val ? "rgba(30,155,191,0.3)" : t.border}`, borderRadius: 10, padding: "10px 6px", cursor: "pointer", color: form.cat === val ? t.accent : t.textSub, fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <div style={{ fontSize: 11, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 8 }}>VALORES POR 100g</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
            <Field label="PROT (g)" {...fld("prot")} type="number"/>
            <Field label="CARB (g)" {...fld("carb")} type="number"/>
            <Field label="GRASA (g)" {...fld("fat")} type="number"/>
            <Field label="KCAL" {...fld("kcal")} type="number"/>
          </div>

          {err && <div style={{ color: t.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>}

          <Btn onClick={saveFood} disabled={saving} size="sm">
            {saving ? "Guardando..." : "💾 Guardar alimento"}
          </Btn>
        </Card>
      )}

      {/* Search */}
      {customFoods.length > 0 && (
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar alimento..."
          style={{ width: "100%", background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "11px 14px", color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box", marginBottom: 14 }}/>
      )}

      {/* List */}
      {customFoods.length === 0 && !showAdd && (
        <Empty icon="food" text="Aún no has añadido ningún alimento personalizado"/>
      )}

      {filtered.map(f => (
        <Card key={f.id} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 11, background: t.bgElevated, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{f.emoji || "🍽️"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: t.text }}>{f.name}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: catColor(f.cat), background: `${catColor(f.cat)}22`, padding: "2px 6px", borderRadius: 6 }}>{catLabel(f.cat)}</span>
              </div>
              <div style={{ fontSize: 11, color: t.textSub }}>
                {f.prot}g P · {f.carb}g C · {f.fat}g G · {f.kcal} kcal <span style={{ color: t.textDim }}>/100g</span>
              </div>
            </div>
            <button onClick={() => deleteFood(f.id, f.name)}
              style={{ background: t.dangerAlpha, border: "none", borderRadius: 8, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.danger, flexShrink: 0 }}>
              <Icon n="trash" s={14}/>
            </button>
          </div>
        </Card>
      ))}
    </div>
  );
};

// ─── AdminManagement — superadmin only ────────────────────────────────────────
const AdminManagement = ({ onBack }) => {
  const { currentUser } = useApp();
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);

  const genPassword = () => {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    setPassword(Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join(""));
  };

  useEffect(() => {
    const load = async () => {
      const rows = await sb.select("admins", "?order=created_at");
      if (rows) setAdmins(rows);
      setLoading(false);
    };
    load();
  }, []);

  const create = async () => {
    if (!name || !email || !password) return alert("Todos los campos son obligatorios");
    setCreating(true);
    const id = "admin-" + Date.now();
    const newAdmin = { id, name, email, password, role: "admin", created_by: currentUser.id };
    await sb.upsert("admins", newAdmin);
    setAdmins(p => [...p, newAdmin]);
    setName(""); setEmail(""); setPassword("");
    setCreating(false);
  };

  const remove = async (id) => {
    if (id === currentUser.id) return alert("No puedes eliminarte a ti mismo");
    if (!confirm("¿Eliminar este administrador?")) return;
    await sb.remove("admins", "id", id);
    setAdmins(p => p.filter(a => a.id !== id));
  };

  return (
    <div>
      <button onClick={onBack} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", color:t.textSub, fontFamily:"inherit", fontSize:13, fontWeight:600, marginBottom:20, padding:0 }}>
        <Icon n="back" s={16}/> Volver
      </button>
      <div style={{ fontSize: 20, fontWeight: 900, color: t.text, marginBottom: 20 }}>Gestionar admins</div>

      {/* Create new admin */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 16 }}>NUEVO ADMINISTRADOR</div>
        <Field label="NOMBRE" value={name} onChange={setName}/>
        <Field label="USUARIO (login)" value={email} onChange={setEmail}/>
        <div style={{ marginBottom: 16 }}>
          <div style={{ color: t.textSub, fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", marginBottom: 7 }}>CONTRASEÑA</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={password} onChange={e => setPassword(e.target.value)}
              style={{ flex: 1, background: t.bgInput, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "13px 16px", color: t.text, fontSize: 15, fontFamily: "inherit", outline: "none" }}/>
            <button onClick={genPassword}
              style={{ background: t.accentAlpha, border: `1.5px solid rgba(30,155,191,0.3)`, borderRadius: 12, padding: "0 14px", cursor: "pointer", color: t.accent, fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>
              🔀 Generar
            </button>
          </div>
        </div>
        <Btn onClick={create} disabled={creating}><Icon n="plus" s={14}/> Crear admin</Btn>
      </Card>

      {/* Admins list */}
      <div style={{ fontSize: 11, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 10 }}>
        ADMINISTRADORES ({admins.length})
      </div>
      {loading ? <div style={{ color: t.textSub, fontSize: 14 }}>Cargando...</div> : admins.map(a => (
        <Card key={a.id} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Av initials={a.name.split(" ").map(n=>n[0]).join("").slice(0,2).toUpperCase()} size={40}/>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: t.text }}>{a.name}</div>
              <div style={{ fontSize: 12, color: t.textSub }}>@{a.email}</div>
              <div style={{ fontSize: 11, color: t.textDim, marginTop: 2 }}>
                {a.password_changed ? "🔒 Contraseña personalizada" : `🔑 ${a.password || "—"}`}
              </div>
            </div>
            <Pill color={a.role === "superadmin" ? "accent" : "default"}>
              {a.role === "superadmin" ? "⭐ Super" : "Admin"}
            </Pill>
            {a.id !== currentUser.id && (
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={async () => {
                  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
                  const pwd = Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join("");
                  await sb.upsert("admins", { id: a.id, name: a.name, email: a.email, password: pwd, role: a.role, password_changed: false });
                  setAdmins(p => p.map(x => x.id === a.id ? { ...x, password: pwd, password_changed: false } : x));
                  navigator.clipboard?.writeText(pwd);
                  alert(`Nueva contraseña: ${pwd}\n(Ya copiada al portapapeles)`);
                }}
                  style={{ background: t.accentAlpha, border: `1px solid rgba(30,155,191,0.3)`, borderRadius: 8, minWidth: 36, minHeight: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.accent, fontSize: 14 }}>
                  🔄
                </button>
                <button onClick={() => remove(a.id)}
                  style={{ background: t.dangerAlpha, border: "none", borderRadius: 8, minWidth: 36, minHeight: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.danger }}>
                  <Icon n="trash" s={14}/>
                </button>
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════

// ─── AdminNotifications ───────────────────────────────────────────────────────
const AdminNotifications = ({ onBack, onSel }) => {
  const { currentUser } = useApp();
  const [notifs, setNotifs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const rows = await sb.select("admin_notifications",
        `?admin_id=eq.${currentUser.id}&order=created_at.desc&limit=50`);
      if (rows) setNotifs(rows);
      // Mark all as read
      try {
        await fetchWithTimeout(`${SB_URL}/rest/v1/admin_notifications?admin_id=eq.${currentUser.id}&read=eq.false`, {
          method: "PATCH",
          headers: { ...SB_H, "Prefer": "return=minimal" },
          body: JSON.stringify({ read: true }),
        });
      } catch {}
      setLoading(false);
    };
    load();
  }, [currentUser.id]);

  const fmtTime = ts => {
    try {
      const d = new Date(ts);
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return "Ahora mismo";
      if (diff < 3600000) return `Hace ${Math.floor(diff/60000)} min`;
      if (diff < 86400000) return `Hace ${Math.floor(diff/3600000)}h`;
      return `${d.getDate()}/${d.getMonth()+1}`;
    } catch { return ""; }
  };

  const iconFor = type => {
    if (type === "chat") return "💬";
    if (type === "changelog") return "📋";
    if (type === "admin_chat") return "👥";
    return "🔔";
  };

  return (
    <div>
      <button onClick={onBack} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", color:t.textSub, fontFamily:"inherit", fontSize:13, fontWeight:600, marginBottom:20, padding:0 }}>
        <Icon n="back" s={16}/> Volver
      </button>
      {loading && <div style={{ textAlign:"center", color:t.textSub, padding:40, animation:"pulse 1.5s infinite" }}>Cargando...</div>}
      {!loading && notifs.length === 0 && <Empty icon="alert" text="Sin notificaciones nuevas"/>}
      {notifs.map(n => (
        <div key={n.id} onClick={() => n.link_type === "client" && onSel(n.link_id)}
          style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 14, padding: "14px 16px", marginBottom: 10, display: "flex", gap: 12, alignItems: "flex-start", cursor: n.link_type === "client" ? "pointer" : "default" }}>
          <div style={{ fontSize: 24, flexShrink: 0 }}>{iconFor(n.type)}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.text, marginBottom: 2 }}>{n.title}</div>
            <div style={{ fontSize: 13, color: t.textSub, lineHeight: 1.5 }}>{n.body}</div>
            <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>{fmtTime(n.created_at)}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ─── AdminChat ────────────────────────────────────────────────────────────────
const AdminChat = () => {
  const { currentUser } = useApp();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  const load = async () => {
    const rows = await sb.select("admin_messages", "?order=created_at&limit=100");
    if (rows) setMessages(rows);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    const msg = { admin_id: currentUser.id, admin_name: currentUser.name, message: text.trim() };
    await sb.insert("admin_messages", msg);
    // Notify other admins
    await notifyAllAdmins(currentUser.id, "admin_chat", `${currentUser.name} en el chat`, text.trim().substring(0, 80));
    setText("");
    await load();
    setSending(false);
  };

  const fmtTime = ts => {
    try {
      const d = new Date(ts);
      return `${d.getDate()}/${d.getMonth()+1} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    } catch { return ""; }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 140px)" }}>
      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingBottom: 16 }}>
        {loading && <div style={{ textAlign: "center", color: t.textSub, fontSize: 14, padding: 20, animation: "pulse 1.5s infinite" }}>Cargando mensajes...</div>}
        {!loading && messages.length === 0 && <div style={{ textAlign: "center", color: t.textSub, fontSize: 14, padding: 40 }}>Sé el primero en escribir 👋</div>}
        {messages.map(m => {
          const isMe = m.admin_id === currentUser.id;
          return (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start" }}>
              {!isMe && <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, marginBottom: 3, marginLeft: 4 }}>{m.admin_name}</div>}
              <div style={{ maxWidth: "80%", background: isMe ? `linear-gradient(135deg, ${t.accent}, ${t.accentDim})` : t.bgCard, border: isMe ? "none" : `1.5px solid ${t.border}`, borderRadius: isMe ? "16px 16px 4px 16px" : "16px 16px 16px 4px", padding: "10px 14px", boxShadow: isMe ? `0 4px 14px ${t.accentGlow}` : "0 2px 8px rgba(0,0,0,0.2)" }}>
                <div style={{ fontSize: 14, color: isMe ? "white" : t.text, lineHeight: 1.5 }}>{m.message}</div>
              </div>
              <div style={{ fontSize: 10, color: t.textDim, marginTop: 3, marginLeft: 4, marginRight: 4 }}>{fmtTime(m.created_at)}</div>
            </div>
          );
        })}
        <div ref={bottomRef}/>
      </div>

      {/* Input */}
      <div style={{ display: "flex", gap: 10, paddingTop: 12, borderTop: `1px solid ${t.border}` }}>
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Escribe un mensaje..."
          style={{ flex: 1, background: t.bgInput, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "12px 16px", color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none" }}
          onFocus={e => e.target.style.borderColor = t.accent}
          onBlur={e => e.target.style.borderColor = t.border}
        />
        <button onClick={send} disabled={sending || !text.trim()}
          style={{ background: `linear-gradient(135deg, ${t.accent}, ${t.accentDim})`, border: "none", borderRadius: 12, width: 48, height: 48, display: "flex", alignItems: "center", justifyContent: "center", cursor: text.trim() ? "pointer" : "not-allowed", opacity: text.trim() ? 1 : 0.4, flexShrink: 0, fontSize: 20 }}>
          ➤
        </button>
      </div>
    </div>
  );
};

// ─── AdminChangelog ───────────────────────────────────────────────────────────
// ─── AdminChangelog ───────────────────────────────────────────────────────────
const AdminChangelog = ({ onBack }) => {
  const { currentUser } = useApp();
  const isSuperAdmin = currentUser?.role === "superadmin";
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newVersion, setNewVersion] = useState(APP_VERSION);
  const [newChanges, setNewChanges] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const rows = await sb.select("changelog", "?order=created_at.desc");
    if (rows) setEntries(rows);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const addEntry = async () => {
    if (!newChanges.trim()) return;
    setSaving(true);
    const now = new Date();
    const months = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
    const date = `${months[now.getMonth()]} ${now.getFullYear()}`;
    await sb.insert("changelog", { version: newVersion, date, changes: newChanges.trim() });
    // Notify all admins
    await notifyAllAdmins(currentUser.id, "changelog",
      `📋 Nueva actualización v${newVersion}`,
      newChanges.trim().substring(0, 100)
    );
    setNewChanges(""); setShowAdd(false);
    await load();
    setSaving(false);
  };

  return (
    <div>
      <button onClick={onBack} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", color:t.textSub, fontFamily:"inherit", fontSize:13, fontWeight:600, marginBottom:20, padding:0 }}>
        <Icon n="back" s={16}/> Volver
      </button>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: t.text }}>Historial de actualizaciones</div>
        {isSuperAdmin && (
          <button onClick={() => setShowAdd(s => !s)}
            style={{ background: t.accentAlpha, border:`1.5px solid rgba(30,155,191,0.3)`, borderRadius:10, padding:"7px 14px", cursor:"pointer", color:t.accent, fontSize:12, fontWeight:700, fontFamily:"inherit" }}>
            {showAdd ? "Cancelar" : "+ Añadir"}
          </button>
        )}
      </div>
      <div style={{ fontSize: 13, color: t.textSub, marginBottom: 20 }}>Todos los cambios de Glute Factoryy</div>

      {/* Add new entry — superadmin only */}
      {showAdd && (
        <Card accent style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 14 }}>NUEVA ACTUALIZACIÓN</div>
          <Field label="VERSIÓN" value={newVersion} onChange={setNewVersion}/>
          <Field label="CAMBIOS" value={newChanges} onChange={setNewChanges} multiline rows={3} placeholder="Describe los cambios de esta versión..."/>
          <Btn onClick={addEntry} disabled={saving || !newChanges.trim()} size="sm">
            {saving ? "Guardando..." : "Publicar actualización"}
          </Btn>
        </Card>
      )}

      {loading && <div style={{ textAlign:"center", color:t.textSub, padding:40, animation:"pulse 1.5s infinite" }}>Cargando...</div>}
      {!loading && entries.map((item, i) => (
        <div key={item.id} style={{ display: "flex", gap: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: i === 0 ? `linear-gradient(135deg, ${t.accent}, ${t.accentDim})` : t.bgCard, border: `1.5px solid ${i === 0 ? "rgba(30,155,191,0.4)" : t.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <span style={{ fontSize: 9, fontWeight: 800, color: i === 0 ? "white" : t.textSub }}>v{item.version}</span>
            </div>
            {i < entries.length - 1 && <div style={{ width: 1, flex: 1, background: t.border, marginTop: 6 }}/>}
          </div>
          <div style={{ flex: 1, paddingBottom: 16 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: i === 0 ? t.accent : t.text }}>v{item.version}</span>
              {i === 0 && <Pill color="accent">Actual</Pill>}
              <span style={{ fontSize: 11, color: t.textDim }}>{item.date}</span>
            </div>
            <div style={{ fontSize: 13, color: t.textSub, lineHeight: 1.6 }}>{item.changes}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ─── AdminOnboarding — first login password change ────────────────────────────
const AdminOnboarding = ({ onDone }) => {
  const { currentUser, setCurrentUser, db, setDb } = useApp();
  const [newPass, setNewPass] = useState("");
  const [newPass2, setNewPass2] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!newPass) { setErr("Introduce una contraseña"); return; }
    if (newPass.length < 6) { setErr("Mínimo 6 caracteres"); return; }
    if (newPass !== newPass2) { setErr("Las contraseñas no coinciden"); return; }
    setSaving(true);
    const updated = { ...currentUser, password: newPass, passwordChanged: true };
    await sb.upsert("admins", { id: currentUser.id, name: currentUser.name, email: currentUser.email, password: newPass, role: currentUser.role, password_changed: true });
    setCurrentUser(updated);
    setDb(p => ({ ...p, users: p.users.map(u => u.id === currentUser.id ? updated : u) }));
    setSaving(false);
    onDone();
  };

  return (
    <div style={{ minHeight: "100vh", background: t.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px 20px" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 900, color: t.text, letterSpacing: "-0.03em", marginBottom: 8 }}>
            ¡Bienvenido, {currentUser.name}! 👋
          </div>
          <div style={{ fontSize: 15, color: t.textSub, lineHeight: 1.6 }}>
            Es tu primera vez. Elige una contraseña personal para acceder en el futuro.
          </div>
        </div>
        <Card accent style={{ padding: "28px 24px" }}>
          <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 16 }}>ELIGE TU CONTRASEÑA</div>
          <Field label="NUEVA CONTRASEÑA" value={newPass} onChange={setNewPass} type="password" placeholder="Mínimo 6 caracteres"/>
          <Field label="REPETIR CONTRASEÑA" value={newPass2} onChange={setNewPass2} type="password" placeholder="Repite la contraseña"/>
          {err && <div style={{ color: t.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>}
          <Btn onClick={save} disabled={saving} full>
            {saving ? "Guardando..." : "Continuar →"}
          </Btn>
        </Card>
      </div>
    </div>
  );
};

const AdminApp = () => {
  const { db, setDb, logout, syncing, loadFromSupabase, currentUser } = useApp();
  const [view, setView] = useState("list");
  const [selId, setSelId] = useState(null);
  const [q, setQ] = useState("");
  const [onboarded, setOnboarded] = useState(false);
  const [unreadNotifs, setUnreadNotifs] = useState(0);

  // Load unread notification count
  useEffect(() => {
    if (!currentUser) return;
    const load = async () => {
      try {
        const notifs = await sb.select("admin_notifications",
          `?admin_id=eq.${currentUser.id}&read=eq.false`);
        setUnreadNotifs(notifs?.length || 0);
      } catch {}
    };
    load();
    const interval = setInterval(load, 30000); // check every 30s
    return () => clearInterval(interval);
  }, [currentUser?.id]);

  const isSuperAdmin = currentUser?.role === "superadmin";

  // Show onboarding if admin hasn't changed password yet (except Pol/superadmin)
  const needsOnboarding = currentUser?.role === "admin" && !currentUser?.passwordChanged && !onboarded;
  if (needsOnboarding) return <AdminOnboarding onDone={() => setOnboarded(true)}/>;

  const filtered = db.clients.filter(c => c.name.toLowerCase().includes(q.toLowerCase()) || (c.email||"").toLowerCase().includes(q.toLowerCase()));
  const sel = db.clients.find(c => c.id === selId);

  const del = async id => {
    if (!confirm("¿Eliminar este cliente? Esta acción no se puede deshacer.")) return;
    setDb(p => {
      const next = { ...p };
      next.clients = p.clients.filter(c => c.id !== id);
      next.users = p.users.filter(u => u.clientId !== id);
      const { [id]: _wh, ...restWH } = p.weightHistory;
      const { [id]: _rt, ...restRT } = p.routines;
      const { [id]: _dt, ...restDT } = p.diets;
      const { [id]: _cn, ...restCN } = p.coachNotes;
      next.weightHistory = restWH; next.routines = restRT;
      next.diets = restDT; next.coachNotes = restCN;
      return next;
    });
    await sb.remove("client_data", "client_id", id);
    await sb.remove("clients", "id", id);
    setView("list");
  };

  const viewTitle = () => {
    if (view === "list") return "Panel Admin";
    if (view === "new") return "Nuevo Cliente";
    if (view === "settings") return "Ajustes";
    if (view === "admins") return "Administradores";
    if (view === "chat") return "💬 Chat Admin";
    if (view === "changelog") return "📋 Actualizaciones";
    if (view === "notifications") return "🔔 Notificaciones";
    if (view === "foods") return "🍽️ Alimentos";
    if (view === "basediets") return "🍴 Dietas base";
    return sel?.name;
  };

  return (
    <div style={{ minHeight: "100vh", background: t.bg, maxWidth: 520, margin: "0 auto" }}>
      <div style={{ padding: "52px 20px 18px", background: `linear-gradient(180deg, rgba(30,155,191,0.08) 0%, transparent 100%)`, borderBottom: `1px solid ${t.border}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {view !== "list" && (
              <button onClick={() => setView("list")} style={{ background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 10, minWidth: 44, minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.textSub, marginRight: 4, flexShrink: 0 }}>
                <Icon n="back" s={17}/>
              </button>
            )}
            <div>
              {view === "list" && <div style={{ fontSize: 12, color: t.textSub, fontWeight: 600, letterSpacing: "0.04em", marginBottom: 2 }}><GFLogo size="sm" /></div>}
              <div style={{ fontSize: 22, fontWeight: 900, color: t.text, letterSpacing: "-0.03em" }}>{viewTitle()}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={loadFromSupabase} disabled={syncing}
              style={{ background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 12, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: syncing ? "default" : "pointer", color: syncing ? t.accent : t.textSub, fontSize: 16 }}>
              ↻
            </button>
            <button onClick={() => { setView("notifications"); setUnreadNotifs(0); }}
              style={{ background: view==="notifications"?t.accentAlpha:t.bgElevated, border: `1px solid ${view==="notifications"?"rgba(30,155,191,0.3)":t.border}`, borderRadius: 12, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: view==="notifications"?t.accent:t.textSub, fontSize: 18, position: "relative" }}>
              🔔
              {unreadNotifs > 0 && (
                <div style={{ position: "absolute", top: -4, right: -4, background: "#e05a5a", borderRadius: 20, minWidth: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px", fontSize: 10, fontWeight: 800, color: "white", border: `2px solid ${t.bg}` }}>
                  {unreadNotifs > 9 ? "9+" : unreadNotifs}
                </div>
              )}
            </button>
            <button onClick={() => setView("chat")}
              style={{ background: view==="chat"?t.accentAlpha:t.bgElevated, border: `1px solid ${view==="chat"?"rgba(30,155,191,0.3)":t.border}`, borderRadius: 12, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: view==="chat"?t.accent:t.textSub, fontSize: 18 }}>
              💬
            </button>
            <button onClick={() => setView("settings")}
              style={{ background: view==="settings"?t.accentAlpha:t.bgElevated, border: `1px solid ${view==="settings"?"rgba(30,155,191,0.3)":t.border}`, borderRadius: 12, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: view==="settings"?t.accent:t.textSub, fontSize: 18 }}>
              ⚙️
            </button>
            <button onClick={logout} style={{ background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 12, width: 42, height: 42, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.textSub }}>
              <Icon n="logout" s={17}/>
            </button>
          </div>
        </div>
      </div>

      <div style={{ padding: "16px 16px 40px" }} className="fade-up">
        {view === "list"      && <AList clients={filtered} q={q} setQ={setQ} db={db} onSel={id=>{setSelId(id);setView("detail");}} onNew={()=>setView("new")} onDel={del} isSuperAdmin={isSuperAdmin} onAdmins={()=>setView("admins")} onFoods={()=>setView("foods")} onBaseDiets={()=>setView("basediets")}/>}
        {view === "detail"    && sel && <ADetail client={sel} db={db} setDb={setDb} onDel={()=>del(sel.id)}/>}
        {view === "new"       && <ANewClient db={db} setDb={setDb} onDone={()=>setView("list")}/>}
        {view === "settings"  && <AdminSettings onBack={() => setView("list")} onChangelog={() => setView("changelog")}/>}
        {view === "admins"    && isSuperAdmin && <AdminManagement onBack={() => setView("list")}/>}
        {view === "chat"      && <AdminChat/>}
        {view === "changelog" && <AdminChangelog onBack={() => setView("settings")}/>}
        {view === "notifications" && <AdminNotifications onBack={() => setView("list")} onSel={(clientId) => { setSelId(clientId); setView("detail"); }}/>}
        {view === "foods"     && <AdminFoods onBack={() => setView("list")}/>}
        {view === "basediets" && <AdminBaseDiets onBack={() => setView("list")}/>}
      </div>
    </div>
  );
};

const AList = ({ clients, q, setQ, db, onSel, onNew, onDel, isSuperAdmin, onAdmins, onFoods, onBaseDiets }) => {
  const { currentUser } = useApp();
  const [filter, setFilter] = useState("all");
  const [unreadCounts, setUnreadCounts] = useState({});

  // Always check last week — checkins are done on Sundays
  const relevantWeekKey = getCalWeekKey(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

  // Load unread message counts
  useEffect(() => {
    const loadUnread = async () => {
      try {
        // Get admin's last_read timestamps
        const admins = await sb.select("admins", `?id=eq.${currentUser.id}`);
        const lastRead = admins?.[0]?.last_read || {};
        // Get all client messages
        const msgs = await sb.select("client_messages", "?order=created_at.desc");
        if (!msgs) return;
        // Count unread per client (messages not from admin, after last_read)
        const counts = {};
        msgs.forEach(m => {
          if (m.sender_role === "client") {
            const lr = lastRead[m.client_id] ? new Date(lastRead[m.client_id]) : new Date(0);
            if (new Date(m.created_at) > lr) {
              counts[m.client_id] = (counts[m.client_id] || 0) + 1;
            }
          }
        });
        setUnreadCounts(counts);
      } catch {}
    };
    loadUnread();
  }, [currentUser.id]);

  const filtered = clients
    .filter(c => {
      const hasCheckin = !!(db.checkins?.[c.id]?.[relevantWeekKey]);
      if (filter === "done") return hasCheckin;
      if (filter === "pending") return !hasCheckin;
      if (filter === "active") return c.status === "active";
      if (filter === "inactive") return c.status !== "active";
      return true;
    })
    .sort((a, b) => {
      if (filter === "az") return a.name.localeCompare(b.name);
      if (filter === "done" || filter === "pending") {
        const aHas = !!(db.checkins?.[a.id]?.[relevantWeekKey]);
        const bHas = !!(db.checkins?.[b.id]?.[relevantWeekKey]);
        return bHas - aHas;
      }
      return 0;
    });

  return (
  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    {/* Stats */}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
      {[{l:"Clientes",v:db.clients.length},{l:"Activos",v:db.clients.filter(c=>c.status==="active").length},{l:"Con Rutina",v:Object.keys(db.routines).length}].map(s=>(
        <Card key={s.l} accent={s.l==="Activos"} style={{ padding: "14px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 26, fontWeight: 900, color: t.text, letterSpacing: "-0.03em" }}>{s.v}</div>
          <div style={{ fontSize: 11, color: t.textSub, marginTop: 4, fontWeight: 600 }}>{s.l}</div>
        </Card>
      ))}
    </div>

    {/* Search + add */}
    <div style={{ display: "flex", gap: 10 }}>
      <div style={{ flex: 1, position: "relative" }}>
        <div style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: t.textDim }}><Icon n="search" s={16}/></div>
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Buscar cliente..."
          style={{ width: "100%", background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "13px 14px 13px 40px", color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
          onFocus={e=>e.target.style.borderColor=t.accent} onBlur={e=>e.target.style.borderColor=t.border}
        />
      </div>
      <Btn onClick={onNew} style={{ paddingLeft: 16, paddingRight: 16 }}><Icon n="plus" s={18}/></Btn>
    </div>

    {/* Single filter row */}
    <div style={{ overflowX: "auto", display: "flex", gap: 8, paddingBottom: 2, scrollbarWidth: "none" }}>
      {[["all","Todos"],["done","✅ Check-in"],["pending","⏳ Pendientes"],["active","🟢 Activos"],["inactive","⚫ Inactivos"],["az","A-Z"]].map(([val, lbl]) => (
        <button key={val} onClick={() => setFilter(val)}
          style={{ background: filter===val ? t.accentAlpha : t.bgCard, border: `1.5px solid ${filter===val ? "rgba(30,155,191,0.3)" : t.border}`, borderRadius: 10, padding: "8px 14px", color: filter===val ? t.accent : t.textSub, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", transition: "all 0.15s", flexShrink: 0 }}>
          {lbl}
        </button>
      ))}
    </div>

    {/* Superadmin: manage admins button */}
    {isSuperAdmin && (
      <button onClick={onAdmins}
        style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", fontFamily: "inherit", textAlign: "left", width: "100%" }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: t.accentAlpha, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>👥</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>Gestionar administradores</div>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>Crear y gestionar cuentas de admin</div>
        </div>
        <Icon n="back" s={16} style={{ transform: "rotate(180deg)", color: t.textDim }}/>
      </button>
    )}

    {/* Manage foods button — all admins */}
    <button onClick={onFoods}
      style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", fontFamily: "inherit", textAlign: "left", width: "100%" }}>
      <div style={{ width: 40, height: 40, borderRadius: 11, background: t.accentAlpha, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>🍽️</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>Gestionar alimentos</div>
        <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>Añadir alimentos personalizados a la base de datos</div>
      </div>
      <Icon n="back" s={16} style={{ transform: "rotate(180deg)", color: t.textDim }}/>
    </button>

    {/* Manage base diets button — all admins */}
    <button onClick={onBaseDiets}
      style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", fontFamily: "inherit", textAlign: "left", width: "100%" }}>
      <div style={{ width: 40, height: 40, borderRadius: 11, background: t.accentAlpha, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>🍴</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>Editar dietas base</div>
        <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>Personalizar las plantillas Mujer 1800 y Hombre 3000</div>
      </div>
      <Icon n="back" s={16} style={{ transform: "rotate(180deg)", color: t.textDim }}/>
    </button>

    {/* List */}
    {filtered.length === 0 && <Empty icon="users" text={filter==="done" ? "Ningún cliente ha hecho check-in esta semana" : filter==="pending" ? "Todos los clientes han hecho check-in 🎉" : "Sin clientes"}/>}
    {filtered.map(c => {
      const lastW = (db.weightHistory[c.id]||[]).slice(-1)[0];
      const hasCheckin = !!(db.checkins?.[c.id]?.[relevantWeekKey]);
      const unread = unreadCounts[c.id] || 0;
      // Calculate streak
      const clientCheckins = db.checkins?.[c.id] || {};
      const allDoneKeys = Object.keys(clientCheckins).sort();
      let streak = 0;
      for (let i = allDoneKeys.length - 1; i >= 0; i--) {
        if (clientCheckins[allDoneKeys[i]]) streak++;
        else break;
      }
      return (
        <Card key={c.id} onClick={() => onSel(c.id)}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ position: "relative" }}>
              <Av initials={c.avatar} size={50}/>
              <div style={{ position: "absolute", bottom: -2, right: -2, width: 16, height: 16, borderRadius: "50%", background: hasCheckin ? t.accent : t.bgElevated, border: `2px solid ${t.bg}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8 }}>
                {hasCheckin ? "✓" : ""}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: t.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>{c.name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {unread > 0 && (
                    <div style={{ background: "#e05a5a", borderRadius: 20, minWidth: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 6px", fontSize: 11, fontWeight: 800, color: "white" }}>
                      {unread > 99 ? "99+" : unread}
                    </div>
                  )}
                  <Pill color={hasCheckin ? "accent" : "default"}>
                    {hasCheckin ? "✅ Check-in" : "⏳ Pendiente"}
                  </Pill>
                </div>
              </div>
              <div style={{ fontSize: 13, color: t.textSub, marginTop: 3 }}>{c.email}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <span style={{ fontSize: 12, color: t.textDim }}>
                  {c.goal}{lastW ? ` · ${lastW.weight} kg` : ""}
                </span>
                {streak >= 2 && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#f0a030" }}>
                    🔥 {streak} sem.
                  </span>
                )}
              </div>
            </div>
          </div>
        </Card>
      );
    })}
  </div>
  );
};

const ADetail = ({ client, db, setDb, onDel }) => {
  const [tab, setTab] = useState("profile");
  const tabs = ["Perfil","Rutina","Dieta","Peso","Notas","Seguimiento","Chat 💬","📋 Cuestionario"];
  const ids  = ["profile","routine","diet","weight","notes","tracking","chat","questionnaire"];
  useEffect(() => { setTab("profile"); }, [client.id]);

  return (
    <div>
      {/* Client card */}
      <Card accent style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
          <Av initials={client.avatar} size={56}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: t.text, letterSpacing: "-0.02em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{client.name}</div>
            <div style={{ fontSize: 13, color: t.textSub, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{client.email}</div>
            <div style={{ fontSize: 13, color: t.textSub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{client.phone}</div>
          </div>
          <button onClick={onDel} style={{ background: t.dangerAlpha, border: `1px solid rgba(224,90,90,0.2)`, borderRadius: 10, minWidth: 44, minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.danger, flexShrink: 0 }}>
            <Icon n="trash" s={15}/>
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Pill color="accent">Activo</Pill>
          <Pill>{client.age} años</Pill>
          <Pill>{client.height} cm</Pill>
          {(db.weightHistory[client.id]||[]).slice(-1)[0] && <Pill>{(db.weightHistory[client.id]||[]).slice(-1)[0].weight} kg</Pill>}
        </div>
      </Card>

      {/* Tab scroll */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 16, scrollbarWidth: "none", msOverflowStyle: "none" }}>
        {tabs.map((label,i) => (
          <button key={ids[i]} onClick={()=>setTab(ids[i])}
            style={{ background: tab===ids[i]?t.accentAlpha:t.bgCard, border: `1.5px solid ${tab===ids[i]?"rgba(30,155,191,0.3)":t.border}`, borderRadius: 10, padding: "9px 16px", color: tab===ids[i]?t.accent:t.textSub, fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit", transition: "all 0.15s", flexShrink: 0 }}>
            {label}
          </button>
        ))}
      </div>

      {tab==="profile"  && <AEditProfile client={client} db={db} setDb={setDb}/>}
      {tab==="routine"  && <AEditRoutine client={client} routine={db.routines[client.id]} db={db} setDb={setDb}/>}
      {tab==="diet"     && <AEditDiet    client={client} diet={db.diets[client.id]}       db={db} setDb={setDb}/>}
      {tab==="weight"   && <AWeightTab   client={client} weights={db.weightHistory[client.id]||[]} db={db} setDb={setDb}/>}
      {tab==="notes"    && <ANotesTab    client={client} notes={db.coachNotes[client.id]||[]}     db={db} setDb={setDb}/>}
      {tab==="tracking" && <ATrackingTab client={client} db={db}/>}
      {tab==="chat"     && <ClientChat client={client} isAdmin={true}/>}
      {tab==="questionnaire" && <AQuestionnaireTab client={client}/>}
    </div>
  );
};

// ─── AQuestionnaireTab — shows client questionnaire answers to admin ─────────
const AQuestionnaireTab = ({ client }) => {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const rows = await sb.select("client_questionnaires", `?client_id=eq.${client.id}`);
        if (rows && rows.length > 0) setData(rows[0]);
      } catch (e) {
        console.error("[AQuestionnaireTab] Error:", e);
      }
      setLoading(false);
    })();
  }, [client.id]);

  if (loading) return <div style={{ textAlign: "center", color: t.textSub, padding: 40, animation: "pulse 1.5s infinite" }}>Cargando...</div>;

  if (!data) return (
    <Empty icon="notes" text="El cliente aún no ha rellenado el cuestionario inicial"/>
  );

  const a = data.answers || {};

  const Line = ({ label, value, highlight }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: t.textSub, fontWeight: 700, letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, color: highlight ? t.accent : t.text, fontWeight: highlight ? 700 : 500, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{value || <span style={{ color: t.textDim, fontWeight: 400 }}>—</span>}</div>
    </div>
  );

  const Section = ({ title, icon, children }) => (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 900, color: t.accent, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 18 }}>{icon}</span>{title}
      </div>
      {children}
    </Card>
  );

  const fmtDeadline = d => ({ "1-2m": "1-2 meses", "3-6m": "3-6 meses", "6-12m": "6-12 meses", "+1a": "+1 año" }[d] || d);
  const fmtSleep = s => ({ "<5": "menos 5h", "5-6": "5-6h", "6-7": "6-7h", "7-8": "7-8h", "8+": "más 8h" }[s] || s);
  const fmtSteps = s => ({ "<5k": "menos 5.000", "5-8k": "5.000-8.000", "8-10k": "8.000-10.000", "10k+": "más 10.000" }[s] || s);
  const fmtYN = v => v === "si" ? "Sí" : v === "no" ? "No" : v;

  const completedAt = data.completed_at ? new Date(data.completed_at).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" }) : "";

  const resetQuestionnaire = async () => {
    if (!confirm(`¿Eliminar el cuestionario de ${client.name}? El cliente podrá rellenarlo de nuevo desde su app.`)) return;
    try {
      await sb.remove("client_questionnaires", "client_id", client.id);
      setData(null);
      alert("Cuestionario eliminado. El cliente verá el banner para rellenarlo de nuevo.");
    } catch (e) {
      alert("Error al eliminar: " + e.message);
    }
  };

  return (
    <div>
      <div style={{ background: "linear-gradient(135deg, rgba(240,160,48,0.12), rgba(240,160,48,0.04))", border: "1.5px solid rgba(240,160,48,0.3)", borderRadius: 14, padding: "14px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: t.text, marginBottom: 4 }}>📋 Cuestionario completado</div>
          <div style={{ fontSize: 12, color: t.textSub }}>Rellenado el {completedAt}</div>
        </div>
        <button onClick={resetQuestionnaire}
          style={{ background: t.dangerAlpha, border: `1px solid rgba(224,90,90,0.3)`, borderRadius: 10, padding: "8px 12px", cursor: "pointer", color: t.danger, fontSize: 11, fontWeight: 700, fontFamily: "inherit", whiteSpace: "nowrap" }}>
          🔄 Reset
        </button>
      </div>

      <Section title="Objetivos" icon="🎯">
        <Line label="OBJETIVO PRINCIPAL" value={a.objective} highlight/>
        <Line label="PLAZO DESEADO" value={fmtDeadline(a.deadline)}/>
      </Section>

      <Section title="Hábitos diarios" icon="⏰">
        <Line label="HORA DE DESPERTAR" value={a.wakeUp}/>
        <Line label="HORA DE ACOSTARSE" value={a.bedTime}/>
        <Line label="HORAS DE SUEÑO" value={fmtSleep(a.sleepHours)}/>
        <Line label="COMIDAS AL DÍA" value={a.mealsPerDay}/>
        <Line label="HORAS DE COMIDAS" value={a.mealTimes}/>
      </Section>

      <Section title="Entrenamiento" icon="💪">
        <Line label="¿ENTRENA ACTUALMENTE?" value={fmtYN(a.trainingNow)}/>
        {a.trainingNow === "si" && (
          <>
            <Line label="DÍAS POR SEMANA" value={a.trainingDays}/>
            <Line label="TIPO DE ENTRENAMIENTO" value={a.trainingType === "otros" ? `Otros: ${a.trainingTypeOther || "—"}` : a.trainingType}/>
          </>
        )}
        <Line label="PASOS AL DÍA" value={fmtSteps(a.steps)}/>
      </Section>

      <Section title="Alimentación actual" icon="🍽️">
        <Line label="DÍA NORMAL" value={a.typicalDay}/>
        <Line label="¿PICA ENTRE HORAS?" value={fmtYN(a.snacking)}/>
        {a.snacking === "si" && <Line label="QUÉ COME ENTRE HORAS" value={a.snackingWhat}/>}
      </Section>

      <Section title="Preferencias" icon="❤️">
        <Line label="LE GUSTAN" value={a.foodsLike}/>
        <Line label="NO LE GUSTAN" value={a.foodsDislike}/>
        <Line label="A EXCLUIR" value={a.foodsExclude}/>
      </Section>

      <Section title="Salud" icon="⚕️">
        <Line label="¿INTOLERANCIAS/ALERGIAS?" value={fmtYN(a.allergy)}/>
        {a.allergy === "si" && <Line label="DETALLES" value={a.allergyDetails} highlight/>}
        <Line label="¿PROBLEMAS DIGESTIVOS?" value={fmtYN(a.digestion)}/>
        {a.digestion === "si" && <Line label="DETALLES" value={a.digestionDetails} highlight/>}
        <Line label="¿MEDICACIÓN/PATOLOGÍA?" value={fmtYN(a.meds)}/>
        {a.meds === "si" && <Line label="DETALLES" value={a.medsDetails} highlight/>}
      </Section>

      <Section title="Historial" icon="📜">
        <Line label="¿HA HECHO DIETAS ANTES?" value={fmtYN(a.pastDiets)}/>
        {a.pastDiets === "si" && <Line label="QUÉ FUNCIONÓ Y QUÉ NO" value={a.pastDietsDetails}/>}
      </Section>

      <Section title="Contexto real" icon="💭">
        <Line label="MAYOR PROBLEMA" value={a.biggestProblem} highlight/>
        <Line label="SITUACIONES DE FALLO" value={a.failSituations}/>
      </Section>

      <Section title="Compromiso" icon="🔥">
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: t.textSub, fontWeight: 700, letterSpacing: "0.05em", marginBottom: 6 }}>NIVEL DE COMPROMISO</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 28, fontWeight: 900, color: t.accent, letterSpacing: "-0.03em" }}>{a.commitment || "—"}</div>
            <div style={{ fontSize: 14, color: t.textSub, fontWeight: 600 }}>/ 10</div>
          </div>
        </div>
        <Line label="NOTAS FINALES" value={a.finalNotes}/>
      </Section>
    </div>
  );
};

const SaveBtn = ({ onSave, saved }) => (
  <Btn onClick={onSave} variant={saved?"ghost":"primary"} size="sm">
    {saved ? <><Icon n="check" s={14}/> Guardado</> : <><Icon n="edit" s={14}/> Guardar</>}
  </Btn>
);

const AEditProfile = ({ client, db, setDb }) => {
  const [f, setF] = useState({...client});
  const [saved, setSaved] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => { setF({...client}); setSaved(false); setResetDone(false); setNewPassword(""); }, [client.id]);

  const save = async () => {
    setDb(p=>({...p,clients:p.clients.map(c=>c.id===client.id?f:c)}));
    setSaved(true); setTimeout(()=>setSaved(false),2000);
    await sb.upsert("clients", {
      id: f.id, user_id: f.userId || f.id,
      name: f.name, email: f.email, phone: f.phone,
      age: f.age ? parseInt(f.age) : null,
      height_cm: f.height ? parseInt(f.height) : null,
      gender: f.gender || null,
      goal: f.goal, personal_notes: f.personalNotes,
      injuries: f.injuries, status: f.status || "active",
      start_date: f.startDate, avatar: f.avatar,
    });
  };

  const resetPassword = async () => {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const pwd = Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    setNewPassword(pwd);
    setResetDone(true);
    setCopied(false);
    // Update in db and Supabase
    const updated = { ...client, password: pwd, passwordChanged: false };
    setDb(p => ({ ...p,
      clients: p.clients.map(c => c.id === client.id ? updated : c),
      users: p.users.map(u => u.clientId === client.id ? { ...u, password: pwd } : u),
    }));
    await sb.upsert("clients", { id: client.id, user_id: client.userId || client.id, name: client.name, email: client.email, password: pwd, password_changed: false });
  };

  const copyPassword = () => {
    navigator.clipboard?.writeText(newPassword).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const fld = k => ({ value: f[k]||"", onChange: v => setF(p=>({...p,[k]:v})) });

  return (
    <div>
      {/* Active/Inactive toggle */}
      <div style={{ background: t.bgCard, border: `1.5px solid ${client.status === "active" ? "rgba(30,155,191,0.2)" : "rgba(224,90,90,0.2)"}`, borderRadius: 14, padding: "14px 18px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.text }}>Estado del cliente</div>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>
            {client.status === "active" ? "🟢 Activo — acceso completo a la app" : "⚫ Inactivo — sin acceso a la app"}
          </div>
        </div>
        <button onClick={async () => {
          const newStatus = client.status === "active" ? "inactive" : "active";
          const updated = { ...f, status: newStatus };
          setF(updated);
          setDb(p => ({ ...p, clients: p.clients.map(c => c.id === client.id ? {...c, status: newStatus} : c) }));
          await sb.upsert("clients", { id: client.id, user_id: client.userId || client.id, name: client.name, email: client.email, status: newStatus });
        }}
          style={{ background: client.status === "active" ? t.dangerAlpha : t.accentAlpha, border: `1.5px solid ${client.status === "active" ? "rgba(224,90,90,0.3)" : "rgba(30,155,191,0.3)"}`, borderRadius: 10, padding: "8px 14px", cursor: "pointer", color: client.status === "active" ? t.danger : t.accent, fontSize: 12, fontWeight: 700, fontFamily: "inherit", whiteSpace: "nowrap" }}>
          {client.status === "active" ? "Desactivar" : "Activar"}
        </button>
      </div>
      <div style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 14, padding: "16px 18px", marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 12 }}>ACCESO DEL CLIENTE</div>
        <div style={{ fontSize: 13, color: t.textSub, marginBottom: 4 }}>
          Usuario: <span style={{ color: t.text, fontWeight: 700 }}>{client.email}</span>
        </div>
        <div style={{ fontSize: 13, color: t.textSub, marginBottom: 14 }}>
          Contraseña: {client.passwordChanged
            ? <span style={{ color: t.textDim }}>🔒 Personalizada por el cliente</span>
            : <span style={{ color: t.text, fontWeight: 700, fontFamily: "monospace" }}>{client.password || "—"}</span>
          }
        </div>
        {resetDone && newPassword && (
          <div style={{ background: t.accentAlpha, border: `1.5px solid rgba(30,155,191,0.3)`, borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, marginBottom: 6 }}>✅ NUEVA CONTRASEÑA GENERADA</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18, fontWeight: 900, color: t.text, fontFamily: "monospace", letterSpacing: "0.1em", flex: 1 }}>{newPassword}</span>
              <button onClick={copyPassword}
                style={{ background: copied?t.accent:t.bgElevated, border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer", color: copied?"white":t.textSub, fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>
                {copied ? "✓ Copiada" : "📋 Copiar"}
              </button>
            </div>
            <div style={{ fontSize: 11, color: t.textSub, marginTop: 6 }}>Envía esta contraseña al cliente para que pueda acceder.</div>
          </div>
        )}
        <Btn onClick={resetPassword} variant="ghost" size="sm">🔄 Resetear contraseña</Btn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
        <Field label="NOMBRE" {...fld("name")}/>
        <Field label="EMAIL"  {...fld("email")} type="email"/>
        <Field label="TELÉFONO" {...fld("phone")}/>
        <Field label="EDAD"   {...fld("age")} type="number"/>
        <Field label="ALTURA (cm)" {...fld("height")} type="number"/>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ color: t.textSub, fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", marginBottom: 7 }}>GÉNERO</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={() => setF(p => ({ ...p, gender: "male" }))}
            style={{ flex: 1, background: f.gender === "male" ? t.accentAlpha : t.bgElevated, border: `1.5px solid ${f.gender === "male" ? "rgba(30,155,191,0.3)" : t.border}`, borderRadius: 10, padding: "10px 10px", cursor: "pointer", color: f.gender === "male" ? t.accent : t.textSub, fontSize: 13, fontWeight: 700, fontFamily: "inherit" }}>
            ♂ Hombre
          </button>
          <button type="button" onClick={() => setF(p => ({ ...p, gender: "female" }))}
            style={{ flex: 1, background: f.gender === "female" ? "rgba(224,90,138,0.15)" : t.bgElevated, border: `1.5px solid ${f.gender === "female" ? "rgba(224,90,138,0.4)" : t.border}`, borderRadius: 10, padding: "10px 10px", cursor: "pointer", color: f.gender === "female" ? "#e05a8a" : t.textSub, fontSize: 13, fontWeight: 700, fontFamily: "inherit" }}>
            ♀ Mujer
          </button>
          <button type="button" onClick={() => setF(p => ({ ...p, gender: "" }))}
            style={{ background: t.bgElevated, border: `1.5px solid ${t.border}`, borderRadius: 10, padding: "10px 14px", cursor: "pointer", color: t.textDim, fontSize: 12, fontFamily: "inherit" }}>
            ✕
          </button>
        </div>
      </div>

      <Field label="OBJETIVO" {...fld("goal")}/>
      <Field label="NOTAS PERSONALES" {...fld("personalNotes")} multiline rows={3}/>
      <Field label="LESIONES / LIMITACIONES" {...fld("injuries")} multiline rows={3}/>
      <SaveBtn onSave={save} saved={saved}/>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── WORD IMPORTER (v1.3.3) ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const WordImporter = ({ onImport }) => {
  const [phase, setPhase]   = useState("idle");   // idle | reading | parsing | preview | error
  const [preview, setPreview] = useState(null);
  const [errMsg, setErrMsg]   = useState("");
  const fileRef = useRef(null);

  const reset = () => { setPhase("idle"); setPreview(null); setErrMsg(""); if (fileRef.current) fileRef.current.value = ""; };

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.match(/\.(docx|doc)$/i)) { setErrMsg("Solo se aceptan archivos .docx"); setPhase("error"); return; }

    setPhase("reading");
    try {
      // 1. Extract text with mammoth
      const arrayBuffer = await file.arrayBuffer();
      let mammoth;
      try {
        mammoth = await import("mammoth");
      } catch {
        setErrMsg("No se pudo cargar el lector de documentos. Inténtalo de nuevo."); setPhase("error"); return;
      }
      const result = await mammoth.extractRawText({ arrayBuffer });
      const rawText  = result.value;
      if (!rawText.trim()) { setErrMsg("El documento está vacío o no se pudo leer."); setPhase("error"); return; }

      // 2. Send to Claude API for structured parsing
      setPhase("parsing");
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `Eres un asistente de entrenamiento. Analiza el siguiente texto extraído de un documento Word con una rutina de entrenamiento y devuelve ÚNICAMENTE un JSON válido (sin markdown, sin explicaciones, sin bloques de código) con esta estructura exacta:

{
  "name": "nombre de la rutina",
  "days": [
    {
      "id": "d1",
      "name": "nombre del día",
      "coachTip": "",
      "exercises": [
        { "name": "nombre ejercicio", "sets": 3, "reps": "10-12", "rest": "90s", "notes": "" }
      ]
    }
  ]
}

Reglas:
- sets debe ser un número entero
- reps debe ser string (ej: "10", "8-10", "12", "Máx")
- rest debe ser string (ej: "90s", "2min", "60s")
- Si no encuentras descanso, usa "90s"
- Si no encuentras series, usa 3
- Extrae TODOS los ejercicios que encuentres
- Si el texto no tiene estructura de rutina clara, devuelve igualmente el mejor JSON posible

TEXTO DEL DOCUMENTO:
${rawText.slice(0, 6000)}`
          }]
        })
      });

      if (!response.ok) { setErrMsg(`Error de API (${response.status}). Inténtalo de nuevo.`); setPhase("error"); return; }

      const data = await response.json();
      const rawJson = data.content?.find(b => b.type === "text")?.text || "";

      // 3. Parse JSON — strip any accidental markdown fences
      const clean = rawJson.replace(/```json|```/g, "").trim();
      let parsed;
      try { parsed = JSON.parse(clean); } catch {
        setErrMsg("No se pudo interpretar la respuesta. Revisa el formato del documento."); setPhase("error"); return;
      }

      // 4. Normalize IDs
      if (parsed.days) {
        parsed.days = parsed.days.map((d, i) => ({ ...d, id: `d${Date.now()}_${i}`, coachTip: d.coachTip || "" }));
      }

      setPreview(parsed);
      setPhase("preview");

    } catch (err) {
      console.error("WordImporter error:", err);
      setErrMsg(`Error al procesar el archivo: ${err.message}`);
      setPhase("error");
    }
  };

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={{ marginBottom: 20 }}>
      {/* Collapsed trigger */}
      {phase === "idle" && (
        <label style={{ display: "flex", alignItems: "center", gap: 12, background: "rgba(30,155,191,0.06)", border: `1.5px dashed rgba(30,155,191,0.25)`, borderRadius: 14, padding: "14px 18px", cursor: "pointer" }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: t.accentAlpha, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <span style={{ fontSize: 20 }}>📄</span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: t.accent }}>Importar rutina desde Word</div>
            <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>Sube un archivo .docx y la IA extraerá la rutina automáticamente</div>
          </div>
          <input ref={fileRef} type="file" accept=".docx,.doc" onChange={handleFile} style={{ display: "none" }}/>
        </label>
      )}

      {/* Reading */}
      {phase === "reading" && (
        <div style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 14, padding: "18px", textAlign: "center" }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>📖</div>
          <div style={{ color: t.textSub, fontSize: 14, fontWeight: 600 }}>Leyendo el documento...</div>
        </div>
      )}

      {/* Parsing */}
      {phase === "parsing" && (
        <div style={{ background: t.bgCard, border: `1.5px solid rgba(30,155,191,0.25)`, borderRadius: 14, padding: "18px", textAlign: "center" }}>
          <div style={{ fontSize: 24, marginBottom: 8, animation: "pulse 1.2s infinite" }}>🤖</div>
          <div style={{ color: t.accent, fontSize: 14, fontWeight: 700 }}>Analizando con IA...</div>
          <div style={{ color: t.textSub, fontSize: 12, marginTop: 4 }}>Extrayendo ejercicios, series y repeticiones</div>
        </div>
      )}

      {/* Error */}
      {phase === "error" && (
        <div style={{ background: t.dangerAlpha, border: `1.5px solid rgba(224,90,90,0.25)`, borderRadius: 14, padding: "16px 18px" }}>
          <div style={{ color: t.danger, fontWeight: 700, fontSize: 14, marginBottom: 6 }}>⚠️ {errMsg}</div>
          <Btn onClick={reset} variant="ghost" size="sm">Reintentar</Btn>
        </div>
      )}

      {/* Preview */}
      {phase === "preview" && preview && (
        <div style={{ background: t.bgCard, border: `1.5px solid rgba(30,155,191,0.3)`, borderRadius: 14, overflow: "hidden" }}>
          {/* Header */}
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${t.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: t.accent }}>✅ Rutina detectada</div>
              <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>{preview.name} · {preview.days?.length || 0} días · {preview.days?.reduce((acc, d) => acc + (d.exercises?.length || 0), 0)} ejercicios</div>
            </div>
            <button onClick={reset} style={{ background: "none", border: "none", cursor: "pointer", color: t.textDim, padding: 4 }}><Icon n="x" s={15}/></button>
          </div>

          {/* Day preview list */}
          <div style={{ maxHeight: 260, overflowY: "auto", padding: "10px 14px" }}>
            {(preview.days || []).map((day, di) => (
              <div key={di} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: t.text, marginBottom: 5 }}>
                  <span style={{ color: t.accent, marginRight: 6 }}>Día {di + 1}</span>{day.name}
                </div>
                {(day.exercises || []).map((ex, ei) => (
                  <div key={ei} style={{ display: "flex", justifyContent: "space-between", padding: "5px 8px", background: t.bgElevated, borderRadius: 7, marginBottom: 3 }}>
                    <span style={{ fontSize: 12, color: t.text, flex: 1 }}>{ex.name}</span>
                    <span style={{ fontSize: 12, color: t.accent, fontWeight: 700, flexShrink: 0, marginLeft: 8 }}>{ex.sets}×{ex.reps}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{ padding: "12px 14px", borderTop: `1px solid ${t.border}`, display: "flex", gap: 8 }}>
            <Btn onClick={() => { onImport(preview); reset(); }} size="sm">
              <Icon n="check" s={14}/> Aplicar rutina
            </Btn>
            <Btn onClick={reset} variant="ghost" size="sm">Descartar</Btn>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── AEditRoutine ─────────────────────────────────────────────────────────────
const AEditRoutine = ({ client, routine: init, db, setDb }) => {
  const [r, setR] = useState(init||{name:"",days:[]});
  const [saved, setSaved] = useState(false);
  useEffect(() => { setR(init||{name:"",days:[]}); setSaved(false); }, [client.id]);
  const save = async () => {
    setDb(p=>({...p,routines:{...p.routines,[client.id]:r}}));
    setSaved(true); setTimeout(()=>setSaved(false),2000);
    await sb.upsert("client_data", { client_id: client.id, routine_json: r, updated_at: new Date().toISOString() });
  };
  const addDay = () => setR(r=>({...r,days:[...r.days,{id:`d${Date.now()}`,name:"Nuevo Día",coachTip:"",exercises:[]}]}));
  const rmDay  = i => setR(r=>({...r,days:r.days.filter((_,j)=>j!==i)}));
  const setDayName = (i,v) => setR(r=>({...r,days:r.days.map((d,j)=>j===i?{...d,name:v}:d)}));
  const addEx  = di => setR(r=>({...r,days:r.days.map((d,i)=>i===di?{...d,exercises:[...d.exercises,{name:"",sets:3,reps:"10",rest:"90s",notes:""}]}:d)}));
  const rmEx   = (di,ei) => setR(r=>({...r,days:r.days.map((d,i)=>i===di?{...d,exercises:d.exercises.filter((_,j)=>j!==ei)}:d)}));
  const setEx  = (di,ei,k,v) => setR(r=>({...r,days:r.days.map((d,i)=>i!==di?d:{...d,exercises:d.exercises.map((e,j)=>j!==ei?e:{...e,[k]:v})})}));
  const si = { background: t.bg, border: `1px solid ${t.border}`, borderRadius: 8, padding: "8px 10px", color: t.text, fontSize: 12, fontFamily: "inherit", outline: "none" };

  return (
    <div>
      {/* Word importer */}
      <WordImporter onImport={imported => setR(imported)}/>

      <Field label="NOMBRE DE LA RUTINA" value={r.name} onChange={v=>setR(r=>({...r,name:v}))}/>
      {r.days.map((day,di)=>(
        <Card key={day.id} style={{marginBottom:12}}>
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <input value={day.name} onChange={e=>setDayName(di,e.target.value)} style={{...si,flex:1,padding:"10px 12px",fontSize:14}}/>
            <button onClick={()=>rmDay(di)} style={{background:t.dangerAlpha,border:"none",borderRadius:8,minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:t.danger,flexShrink:0}}><Icon n="trash" s={14}/></button>
          </div>
          {/* Coach tip */}
          <textarea value={day.coachTip||""} onChange={e=>setR(r=>({...r,days:r.days.map((d,j)=>j===di?{...d,coachTip:e.target.value}:d)}))}
            placeholder="💡 Recomendaciones del coach para este día..." rows={2}
            style={{...si,width:"100%",boxSizing:"border-box",resize:"vertical",marginBottom:10,padding:"8px 10px",fontSize:12,lineHeight:1.5}}/>
          {day.exercises.map((ex,ei)=>(
            <div key={ei} style={{background:t.bgElevated,borderRadius:10,padding:10,marginBottom:8}}>
              <div style={{display:"flex",gap:8,marginBottom:8}}>
                <input value={ex.name} onChange={e=>setEx(di,ei,"name",e.target.value)} placeholder="Nombre del ejercicio" style={{...si,flex:1}}/>
                <button onClick={()=>rmEx(di,ei)} style={{background:"none",border:"none",cursor:"pointer",color:t.textDim,minWidth:44,minHeight:44,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n="x" s={14}/></button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
                {[["Series","sets"],["Reps","reps"],["Descanso","rest"]].map(([lbl,k])=>(
                  <input key={k} value={ex[k]} onChange={e=>setEx(di,ei,k,e.target.value)} placeholder={lbl} style={{...si,textAlign:"center"}}/>
                ))}
              </div>
            </div>
          ))}
          <Btn onClick={()=>addEx(di)} variant="text" size="sm"><Icon n="plus" s={13}/> Ejercicio</Btn>
        </Card>
      ))}
      <div style={{display:"flex",gap:10,marginTop:4}}>
        <Btn onClick={addDay} variant="ghost" size="sm"><Icon n="plus" s={14}/> Día</Btn>
        <SaveBtn onSave={save} saved={saved}/>
      </div>
    </div>
  );
};

// ─── Food database (per 100g) ─────────────────────────────────────────────────
const FOOD_DB = [
  // Proteínas
  { name:"Whey Protein",       emoji:"🥛", prot:78, fat:4,  carb:6,  kcal:370, cat:"proteina" },
  { name:"Claras de huevo",    emoji:"🥚", prot:11, fat:0,  carb:1,  kcal:52,  cat:"proteina" },
  { name:"Huevos enteros",     emoji:"🍳", prot:13, fat:11, carb:1,  kcal:155, cat:"proteina" },
  { name:"Pollo / Pavo",       emoji:"🍗", prot:23, fat:2,  carb:0,  kcal:110, cat:"proteina" },
  { name:"Ternera (magra)",    emoji:"🥩", prot:21, fat:6,  carb:0,  kcal:160, cat:"proteina" },
  { name:"Pescado blanco",     emoji:"🐟", prot:18, fat:1,  carb:0,  kcal:82,  cat:"proteina" },
  { name:"Gambas",             emoji:"🍤", prot:20, fat:1,  carb:1,  kcal:95,  cat:"proteina" },
  { name:"Salmón ahumado",     emoji:"🐠", prot:21, fat:10, carb:0,  kcal:180, cat:"proteina" },
  { name:"Jamón serrano",      emoji:"🥓", prot:28, fat:8,  carb:0,  kcal:190, cat:"proteina" },
  { name:"Yogur de proteína",  emoji:"🥛", prot:10, fat:0,  carb:5,  kcal:60,  cat:"proteina" },
  // Carbohidratos
  { name:"Arroz (seco)",       emoji:"🍚", prot:7,  fat:1,  carb:78, kcal:350, cat:"carbohidrato" },
  { name:"Pasta (seca)",       emoji:"🍝", prot:12, fat:2,  carb:72, kcal:355, cat:"carbohidrato" },
  { name:"Avena",              emoji:"🌾", prot:13, fat:7,  carb:60, kcal:365, cat:"carbohidrato" },
  { name:"Pan",                emoji:"🍞", prot:8,  fat:2,  carb:48, kcal:240, cat:"carbohidrato" },
  { name:"Patata",             emoji:"🥔", prot:2,  fat:0,  carb:17, kcal:77,  cat:"carbohidrato" },
  { name:"Boniato",            emoji:"🍠", prot:2,  fat:0,  carb:20, kcal:86,  cat:"carbohidrato" },
  { name:"Crema de arroz",     emoji:"🍚", prot:7,  fat:1,  carb:80, kcal:360, cat:"carbohidrato" },
  { name:"Corn Flakes 0%",     emoji:"🌽", prot:7,  fat:1,  carb:84, kcal:370, cat:"carbohidrato" },
  { name:"Tortitas de trigo",  emoji:"🫓", prot:9,  fat:7,  carb:45, kcal:280, cat:"carbohidrato" },
  { name:"Fruta (media)",      emoji:"🍎", prot:1,  fat:0,  carb:15, kcal:65,  cat:"carbohidrato" },
  { name:"Frutos rojos",       emoji:"🫐", prot:1,  fat:0,  carb:10, kcal:45,  cat:"carbohidrato" },
  // Grasas
  { name:"AOVE (Aceite)",      emoji:"🫒", prot:0,  fat:100,carb:0,  kcal:884, cat:"grasa" },
  { name:"Crema cacahuete",    emoji:"🥜", prot:24, fat:50, carb:15, kcal:600, cat:"grasa" },
  { name:"Frutos secos",       emoji:"🥜", prot:20, fat:54, carb:7,  kcal:600, cat:"grasa" },
  { name:"Aguacate",           emoji:"🥑", prot:2,  fat:15, carb:8,  kcal:160, cat:"grasa" },
  { name:"Chocolate 85%",      emoji:"🍫", prot:9,  fat:45, carb:19, kcal:580, cat:"grasa" },
  { name:"Queso Havarti",      emoji:"🧀", prot:20, fat:30, carb:1,  kcal:350, cat:"grasa" },
];

// ─── MacroCalculator — inline food picker ────────────────────────────────────
const MacroCalculator = ({ onAdd }) => {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [grams, setGrams] = useState("100");
  const [open, setOpen] = useState(false);

  const results = (() => {
    if (search.length < 2) return [];
    const q = search.toLowerCase().trim();
    if (q === "proteína" || q === "proteinas" || q === "proteína" || q === "proteina") return FOOD_DB.filter(f => f.cat === "proteina");
    if (q === "carbohidrato" || q === "carbohidratos" || q === "carbo" || q === "hidratos") return FOOD_DB.filter(f => f.cat === "carbohidrato");
    if (q === "grasa" || q === "grasas") return FOOD_DB.filter(f => f.cat === "grasa");
    return FOOD_DB.filter(f => f.name.toLowerCase().includes(q));
  })();

  const macros = selected && grams ? {
    prot: ((selected.prot * +grams) / 100).toFixed(1),
    fat:  ((selected.fat  * +grams) / 100).toFixed(1),
    carb: ((selected.carb * +grams) / 100).toFixed(1),
    kcal: Math.round((selected.kcal * +grams) / 100),
  } : null;

  const handleAdd = () => {
    if (!selected || !grams) return;
    onAdd({
      name: `${selected.name} (${grams}g)`,
      emoji: selected.emoji,
      amount: `${grams}g`,
      macros,
    });
    setSelected(null); setSearch(""); setGrams("100"); setOpen(false);
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ background: t.accentAlpha, border: `1.5px solid rgba(30,155,191,0.3)`, borderRadius: 10, padding: "7px 14px", cursor: "pointer", color: t.accent, fontSize: 12, fontWeight: 700, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
        🧮 {open ? "Cerrar calculadora" : "Calculadora de macros"}
      </button>

      {open && (
        <div style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 14, padding: 14, marginTop: 8 }}>
          <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 10 }}>CALCULADORA DE MACROS</div>

          {/* Search */}
          <input value={search} onChange={e => { setSearch(e.target.value); setSelected(null); }}
            placeholder="Buscar alimento... (ej: pollo)"
            style={{ width: "100%", background: t.bgInput, border: `1.5px solid ${t.border}`, borderRadius: 10, padding: "10px 14px", color: t.text, fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", marginBottom: 6 }}
            onFocus={e => e.target.style.borderColor = t.accent}
            onBlur={e => e.target.style.borderColor = t.border}
          />

          {/* Results */}
          {results.length > 0 && !selected && (
            <div style={{ background: t.bgElevated, borderRadius: 10, overflow: "hidden", marginBottom: 8, maxHeight: 180, overflowY: "auto" }}>
              {results.map(f => (
                <button key={f.name} onClick={() => { setSelected(f); setSearch(f.name); }}
                  style={{ width: "100%", background: "none", border: "none", borderBottom: `1px solid ${t.border}`, padding: "9px 14px", cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", justify: "space-between", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 16 }}>{f.emoji}</span>
                  <span style={{ flex: 1, fontSize: 13, color: t.text, fontWeight: 600 }}>{f.name}</span>
                  <span style={{ fontSize: 11, color: t.textSub }}>{f.prot}P · {f.carb}C · {f.fat}G · {f.kcal}kcal</span>
                </button>
              ))}
            </div>
          )}

          {/* Grams input + result */}
          {selected && (
            <div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 16 }}>{selected.emoji}</span>
                <span style={{ fontSize: 13, color: t.text, fontWeight: 700, flex: 1 }}>{selected.name}</span>
                <input type="number" value={grams} onChange={e => setGrams(e.target.value)} min="1" max="2000"
                  style={{ width: 70, background: t.bgInput, border: `1.5px solid ${t.accent}`, borderRadius: 8, padding: "8px 10px", color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none", textAlign: "center", fontWeight: 700 }}/>
                <span style={{ fontSize: 12, color: t.textSub }}>g</span>
              </div>

              {macros && (
                <div style={{ background: t.bgElevated, borderRadius: 10, padding: "10px 14px", marginBottom: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, textAlign: "center" }}>
                    {[["🔥","Kcal",macros.kcal,""],["💪","Prot",macros.prot,"g"],["🌾","Carbs",macros.carb,"g"],["🥑","Grasas",macros.fat,"g"]].map(([ico,lbl,val,unit]) => (
                      <div key={lbl} style={{ background: t.bgCard, borderRadius: 8, padding: "8px 4px" }}>
                        <div style={{ fontSize: 14 }}>{ico}</div>
                        <div style={{ fontSize: 15, fontWeight: 900, color: t.text }}>{val}{unit}</div>
                        <div style={{ fontSize: 9, color: t.textSub, fontWeight: 700 }}>{lbl}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8 }}>
                <Btn onClick={handleAdd} size="sm"><Icon n="plus" s={13}/> Añadir a la comida</Btn>
                <Btn onClick={() => { setSelected(null); setSearch(""); }} variant="ghost" size="sm">Cancelar</Btn>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── AEditDiet — admin diet editor (v2.0 — auto sections + auto macros) ──────
const AEditDiet = ({ client, diet: init, db, setDb }) => {
  const { customFoods } = useApp();
  const emptyDiet = { name:"", meals:[] };
  const [d, setD] = useState(init || emptyDiet);
  const [saved, setSaved] = useState(false);
  const [openMeal, setOpenMeal] = useState(null);
  useEffect(() => { setD(init||emptyDiet); setSaved(false); setOpenMeal(null); }, [client.id]);

  // Combined food DB: built-in + custom
  const ALL_FOODS = [...FOOD_DB, ...(customFoods || []).map(f => ({
    name: f.name, emoji: f.emoji || "🍽️",
    prot: +f.prot, carb: +f.carb, fat: +f.fat, kcal: +f.kcal,
    cat: f.cat, custom: true,
  }))];

  // Auto-calculate totals — only counts first option (A) of each section since options are alternatives
  const totals = (() => {
    let kcal = 0, prot = 0, carb = 0, fat = 0;
    (d.meals || []).forEach(m => {
      (m.sections || []).forEach(s => {
        const firstItem = s.items?.[0];
        if (firstItem?.macros) {
          kcal += +firstItem.macros.kcal || 0;
          prot += +firstItem.macros.prot || 0;
          carb += +firstItem.macros.carb || 0;
          fat  += +firstItem.macros.fat  || 0;
        }
      });
    });
    return { kcal: Math.round(kcal), prot: prot.toFixed(0), carb: carb.toFixed(0), fat: fat.toFixed(0) };
  })();

  const save = async () => {
    const dietWithTotals = { ...d, calories: +totals.kcal, protein: +totals.prot, carbs: +totals.carb, fat: +totals.fat };
    setDb(p=>({...p,diets:{...p.diets,[client.id]:dietWithTotals}}));
    setSaved(true); setTimeout(()=>setSaved(false),2000);
    await sb.upsert("client_data", { client_id: client.id, diet_json: dietWithTotals, updated_at: new Date().toISOString() });
  };

  // Create meal with default 3 sections: protein / carb / fat
  const addMeal = () => {
    const id = "m" + Date.now();
    const newMeal = {
      id, title: `Comida ${(d.meals?.length || 0) + 1}`, subtitle: "", time: "",
      sections: [
        { id: "s" + (Date.now() + 1), type: "protein", title: "Proteínas", items: [] },
        { id: "s" + (Date.now() + 2), type: "carbs",   title: "Hidratos",  items: [] },
        { id: "s" + (Date.now() + 3), type: "fat",     title: "Grasas",    items: [] },
      ],
    };
    setD(p => ({ ...p, meals: [...(p.meals || []), newMeal] }));
    setOpenMeal(id);
  };
  const rmMeal = id => setD(p => ({ ...p, meals: p.meals.filter(m => m.id !== id) }));
  const updMeal = (id, k, v) => setD(p => ({ ...p, meals: p.meals.map(m => m.id === id ? { ...m, [k]: v } : m) }));

  // Add food item from database with automatic macros
  const addFoodItem = (mealId, secId, food, grams) => {
    const g = +grams || 100;
    const macros = {
      kcal: Math.round((food.kcal * g) / 100),
      prot: ((food.prot * g) / 100).toFixed(1),
      carb: ((food.carb * g) / 100).toFixed(1),
      fat:  ((food.fat  * g) / 100).toFixed(1),
    };
    const iid = "i" + Date.now();
    setD(p => ({ ...p, meals: p.meals.map(m => m.id !== mealId ? m : { ...m, sections: m.sections.map(s => s.id !== secId ? s : { ...s, items: [...s.items, { id: iid, name: food.name, emoji: food.emoji, amount: `${g}g`, grams: g, foodName: food.name, macros }] }) } ) }));
  };

  // Add a second+ component to an existing option (makes it a combination)
  const addComponentToItem = (mealId, secId, iid, food, grams) => {
    const g = +grams || 100;
    const newComponent = {
      id: "c" + Date.now(),
      foodName: food.name, name: food.name, emoji: food.emoji,
      grams: g,
      macros: {
        kcal: Math.round((food.kcal * g) / 100),
        prot: ((food.prot * g) / 100).toFixed(1),
        carb: ((food.carb * g) / 100).toFixed(1),
        fat:  ((food.fat  * g) / 100).toFixed(1),
      },
    };
    setD(p => ({ ...p, meals: p.meals.map(m => m.id !== mealId ? m : { ...m, sections: m.sections.map(s => s.id !== secId ? s : { ...s, items: s.items.map(i => {
      if (i.id !== iid) return i;
      // Initialize components with the current item if not present
      const existingComponents = i.components || [{ id: "c0_" + i.id, foodName: i.foodName, name: i.name, emoji: i.emoji, grams: i.grams, macros: i.macros }];
      const allComponents = [...existingComponents, newComponent];
      // Sum macros
      const totalMacros = allComponents.reduce((acc, c) => ({
        kcal: acc.kcal + (+c.macros?.kcal || 0),
        prot: +(acc.prot + (+c.macros?.prot || 0)).toFixed(1),
        carb: +(acc.carb + (+c.macros?.carb || 0)).toFixed(1),
        fat:  +(acc.fat  + (+c.macros?.fat  || 0)).toFixed(1),
      }), { kcal: 0, prot: 0, carb: 0, fat: 0 });
      return { ...i, components: allComponents, macros: {
        kcal: Math.round(totalMacros.kcal),
        prot: totalMacros.prot.toFixed(1),
        carb: totalMacros.carb.toFixed(1),
        fat: totalMacros.fat.toFixed(1),
      } };
    }) }) }) }));
  };

  // Update grams of a specific component within a combined option
  const updComponentGrams = (mealId, secId, iid, compId, newGrams) => {
    setD(p => ({ ...p, meals: p.meals.map(m => m.id !== mealId ? m : { ...m, sections: m.sections.map(s => s.id !== secId ? s : { ...s, items: s.items.map(i => {
      if (i.id !== iid || !i.components) return i;
      const updatedComponents = i.components.map(c => {
        if (c.id !== compId) return c;
        const food = ALL_FOODS.find(f => f.name === c.foodName);
        if (!food) return { ...c, grams: +newGrams };
        const g = +newGrams || 0;
        return { ...c, grams: g, macros: {
          kcal: Math.round((food.kcal * g) / 100),
          prot: ((food.prot * g) / 100).toFixed(1),
          carb: ((food.carb * g) / 100).toFixed(1),
          fat:  ((food.fat  * g) / 100).toFixed(1),
        } };
      });
      const totalMacros = updatedComponents.reduce((acc, c) => ({
        kcal: acc.kcal + (+c.macros?.kcal || 0),
        prot: +(acc.prot + (+c.macros?.prot || 0)).toFixed(1),
        carb: +(acc.carb + (+c.macros?.carb || 0)).toFixed(1),
        fat:  +(acc.fat  + (+c.macros?.fat  || 0)).toFixed(1),
      }), { kcal: 0, prot: 0, carb: 0, fat: 0 });
      return { ...i, components: updatedComponents, macros: {
        kcal: Math.round(totalMacros.kcal),
        prot: totalMacros.prot.toFixed(1),
        carb: totalMacros.carb.toFixed(1),
        fat: totalMacros.fat.toFixed(1),
      } };
    }) }) }) }));
  };

  // Remove a component from a combined option
  const rmComponent = (mealId, secId, iid, compId) => {
    setD(p => ({ ...p, meals: p.meals.map(m => m.id !== mealId ? m : { ...m, sections: m.sections.map(s => s.id !== secId ? s : { ...s, items: s.items.map(i => {
      if (i.id !== iid || !i.components) return i;
      const remaining = i.components.filter(c => c.id !== compId);
      if (remaining.length === 0) return i; // Can't remove last component this way
      if (remaining.length === 1) {
        // Convert back to simple item
        const c = remaining[0];
        return { ...i, components: undefined, name: c.name, emoji: c.emoji, foodName: c.foodName, grams: c.grams, amount: `${c.grams}g`, macros: c.macros };
      }
      const totalMacros = remaining.reduce((acc, c) => ({
        kcal: acc.kcal + (+c.macros?.kcal || 0),
        prot: +(acc.prot + (+c.macros?.prot || 0)).toFixed(1),
        carb: +(acc.carb + (+c.macros?.carb || 0)).toFixed(1),
        fat:  +(acc.fat  + (+c.macros?.fat  || 0)).toFixed(1),
      }), { kcal: 0, prot: 0, carb: 0, fat: 0 });
      return { ...i, components: remaining, macros: {
        kcal: Math.round(totalMacros.kcal),
        prot: totalMacros.prot.toFixed(1),
        carb: totalMacros.carb.toFixed(1),
        fat: totalMacros.fat.toFixed(1),
      } };
    }) }) }) }));
  };

  const rmItem = (mealId, secId, iid) => setD(p => ({ ...p, meals: p.meals.map(m => m.id !== mealId ? m : { ...m, sections: m.sections.map(s => s.id !== secId ? s : { ...s, items: s.items.filter(i => i.id !== iid) }) }) }));

  const updItemGrams = (mealId, secId, iid, newGrams) => {
    setD(p => ({ ...p, meals: p.meals.map(m => m.id !== mealId ? m : { ...m, sections: m.sections.map(s => s.id !== secId ? s : { ...s, items: s.items.map(i => {
      if (i.id !== iid) return i;
      const food = ALL_FOODS.find(f => f.name === i.foodName);
      if (!food) return { ...i, amount: `${newGrams}g`, grams: +newGrams };
      const g = +newGrams || 0;
      return { ...i, amount: `${g}g`, grams: g, macros: {
        kcal: Math.round((food.kcal * g) / 100),
        prot: ((food.prot * g) / 100).toFixed(1),
        carb: ((food.carb * g) / 100).toFixed(1),
        fat:  ((food.fat  * g) / 100).toFixed(1),
      } };
    }) }) }) }));
  };

  const si = { background:t.bg, border:`1px solid ${t.border}`, borderRadius:8, padding:"8px 10px", color:t.text, fontSize:12, fontFamily:"inherit", outline:"none" };

  // Map section type to category label and color
  const secConfig = {
    protein: { label: "🥩 Proteínas", cat: "proteina",     color: "#e05a5a", border: "rgba(224,90,90,0.25)" },
    carbs:   { label: "🍚 Hidratos",  cat: "carbohidrato", color: "#f0a030", border: "rgba(240,160,48,0.25)" },
    fat:     { label: "🥑 Grasas",    cat: "grasa",        color: "#8ac942", border: "rgba(138,201,66,0.25)" },
  };

  // Helper: calculate macros for a food + grams
  const calcMacros = (foodName, grams) => {
    const food = ALL_FOODS.find(f => f.name === foodName);
    if (!food) return null;
    const g = +grams;
    return {
      kcal: Math.round((food.kcal * g) / 100),
      prot: ((food.prot * g) / 100).toFixed(1),
      carb: ((food.carb * g) / 100).toFixed(1),
      fat:  ((food.fat  * g) / 100).toFixed(1),
    };
  };

  // Helper: create a food item
  const mkItem = (foodName, grams) => {
    const food = ALL_FOODS.find(f => f.name === foodName);
    if (!food) return null;
    return {
      id: "i" + Date.now() + Math.random().toString(36).slice(2, 7),
      name: food.name, emoji: food.emoji, amount: `${grams}g`, grams: +grams,
      foodName: food.name, macros: calcMacros(foodName, grams),
    };
  };

  // Generate base diet — woman 1800 kcal
  // Default meals — used as fallback if Supabase is empty
  const DEFAULT_FEMALE_MEALS = () => [
    { id: "m1", title: "Comida 1", subtitle: "Desayuno", time: "08:00",
      sections: [
        { id: "s-p-m1", type: "protein", title: "Proteínas", items: [mkItem("Claras de huevo", 200), mkItem("Huevos enteros", 100)].filter(Boolean) },
        { id: "s-c-m1", type: "carbs",   title: "Hidratos",  items: [mkItem("Avena", 50), mkItem("Pan", 60)].filter(Boolean) },
        { id: "s-f-m1", type: "fat",     title: "Grasas",    items: [mkItem("Crema cacahuete", 15), mkItem("Aguacate", 50)].filter(Boolean) },
      ],
    },
    { id: "m2", title: "Comida 2", subtitle: "Almuerzo", time: "14:00",
      sections: [
        { id: "s-p-m2", type: "protein", title: "Proteínas", items: [mkItem("Pollo / Pavo", 130), mkItem("Ternera (magra)", 120)].filter(Boolean) },
        { id: "s-c-m2", type: "carbs",   title: "Hidratos",  items: [mkItem("Arroz (seco)", 70), mkItem("Pasta (seca)", 65)].filter(Boolean) },
        { id: "s-f-m2", type: "fat",     title: "Grasas",    items: [mkItem("AOVE (Aceite)", 10), mkItem("Aguacate", 60)].filter(Boolean) },
      ],
    },
    { id: "m3", title: "Comida 3", subtitle: "Cena", time: "21:00",
      sections: [
        { id: "s-p-m3", type: "protein", title: "Proteínas", items: [mkItem("Pescado blanco", 180), mkItem("Salmón ahumado", 120)].filter(Boolean) },
        { id: "s-c-m3", type: "carbs",   title: "Hidratos",  items: [mkItem("Patata", 250), mkItem("Boniato", 220)].filter(Boolean) },
        { id: "s-f-m3", type: "fat",     title: "Grasas",    items: [mkItem("AOVE (Aceite)", 10), mkItem("Queso Havarti", 25)].filter(Boolean) },
      ],
    },
    { id: "m4", title: "Comida Post-Entreno", subtitle: "Después del entrenamiento", time: "18:00",
      sections: [
        { id: "s-p-m4", type: "protein", title: "Proteínas", items: [mkItem("Whey Protein", 30), mkItem("Yogur de proteína", 200)].filter(Boolean) },
        { id: "s-c-m4", type: "carbs",   title: "Hidratos",  items: [mkItem("Crema de arroz", 50), mkItem("Corn Flakes 0%", 50)].filter(Boolean) },
        { id: "s-f-m4", type: "fat",     title: "Grasas",    items: [mkItem("Frutos secos", 30), mkItem("Chocolate 85%", 20)].filter(Boolean) },
      ],
    },
  ];

  const DEFAULT_MALE_MEALS = () => [
    { id: "m1", title: "Comida 1", subtitle: "Desayuno", time: "08:00",
      sections: [
        { id: "s-p-m1", type: "protein", title: "Proteínas", items: [mkItem("Claras de huevo", 250), mkItem("Huevos enteros", 150)].filter(Boolean) },
        { id: "s-c-m1", type: "carbs",   title: "Hidratos",  items: [mkItem("Avena", 80), mkItem("Pan", 100)].filter(Boolean) },
        { id: "s-f-m1", type: "fat",     title: "Grasas",    items: [mkItem("Crema cacahuete", 20), mkItem("Aguacate", 70)].filter(Boolean) },
      ],
    },
    { id: "m2", title: "Comida 2", subtitle: "Almuerzo", time: "14:00",
      sections: [
        { id: "s-p-m2", type: "protein", title: "Proteínas", items: [mkItem("Pollo / Pavo", 250), mkItem("Ternera (magra)", 230)].filter(Boolean) },
        { id: "s-c-m2", type: "carbs",   title: "Hidratos",  items: [mkItem("Arroz (seco)", 110), mkItem("Pasta (seca)", 100)].filter(Boolean) },
        { id: "s-f-m2", type: "fat",     title: "Grasas",    items: [mkItem("AOVE (Aceite)", 12), mkItem("Aguacate", 80)].filter(Boolean) },
      ],
    },
    { id: "m3", title: "Comida 3", subtitle: "Cena", time: "21:00",
      sections: [
        { id: "s-p-m3", type: "protein", title: "Proteínas", items: [mkItem("Pescado blanco", 300), mkItem("Salmón ahumado", 200)].filter(Boolean) },
        { id: "s-c-m3", type: "carbs",   title: "Hidratos",  items: [mkItem("Patata", 450), mkItem("Boniato", 400)].filter(Boolean) },
        { id: "s-f-m3", type: "fat",     title: "Grasas",    items: [mkItem("AOVE (Aceite)", 12), mkItem("Queso Havarti", 35)].filter(Boolean) },
      ],
    },
    { id: "m4", title: "Comida Post-Entreno", subtitle: "Después del entrenamiento", time: "18:00",
      sections: [
        { id: "s-p-m4", type: "protein", title: "Proteínas", items: [mkItem("Whey Protein", 60), mkItem("Yogur de proteína", 400)].filter(Boolean) },
        { id: "s-c-m4", type: "carbs",   title: "Hidratos",  items: [mkItem("Crema de arroz", 80), mkItem("Corn Flakes 0%", 80)].filter(Boolean) },
        { id: "s-f-m4", type: "fat",     title: "Grasas",    items: [mkItem("Frutos secos", 30), mkItem("Chocolate 85%", 25)].filter(Boolean) },
      ],
    },
  ];

  // Load base diet from Supabase, fallback to default
  const loadAndApplyBaseDiet = async (baseDietId, defaultMeals, name) => {
    if (d.meals && d.meals.length > 0) {
      if (!confirm("Esto sustituirá la dieta actual. ¿Continuar?")) return;
    }
    try {
      const rows = await sb.select("base_diets", `?id=eq.${baseDietId}`);
      let meals;
      if (rows?.length && rows[0].meals && Array.isArray(rows[0].meals) && rows[0].meals.length > 0) {
        meals = rows[0].meals;
      } else {
        meals = defaultMeals();
      }
      setD(p => ({ ...p, name: p.name || name, meals }));
      setOpenMeal(meals[0]?.id);
    } catch {
      // Fallback on error
      const meals = defaultMeals();
      setD(p => ({ ...p, name: p.name || name, meals }));
      setOpenMeal(meals[0]?.id);
    }
  };

  const generateBase1800 = () => loadAndApplyBaseDiet("female-1800", DEFAULT_FEMALE_MEALS, "Dieta Base Mujer 1800 kcal");
  const generateBase3000 = () => loadAndApplyBaseDiet("male-3000",   DEFAULT_MALE_MEALS,   "Dieta Base Hombre 3000 kcal");

  return (
    <div>
      {/* Diet name */}
      <Field label="NOMBRE DE LA DIETA" value={d.name} onChange={v=>setD(p=>({...p,name:v}))}/>

      {/* Generate base diet buttons — based on client gender */}
      <div style={{ marginBottom: 16, display: "grid", gridTemplateColumns: client.gender ? "1fr" : "1fr 1fr", gap: 8 }}>
        {(!client.gender || client.gender === "female") && (
          <button onClick={generateBase1800}
            style={{ background: `linear-gradient(135deg, #e05a8a, #c04070)`, border: "none", borderRadius: 12, padding: "12px 10px", cursor: "pointer", color: "white", fontSize: 13, fontWeight: 800, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, boxShadow: `0 4px 14px rgba(224,90,138,0.3)`, lineHeight: 1.3 }}>
            ♀ Dieta Base Mujer · 1800 kcal
          </button>
        )}
        {(!client.gender || client.gender === "male") && (
          <button onClick={generateBase3000}
            style={{ background: `linear-gradient(135deg, ${t.accent}, ${t.accentDim})`, border: "none", borderRadius: 12, padding: "12px 10px", cursor: "pointer", color: "white", fontSize: 13, fontWeight: 800, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, boxShadow: `0 4px 14px ${t.accentGlow}`, lineHeight: 1.3 }}>
            ♂ Dieta Base Hombre · 3000 kcal
          </button>
        )}
      </div>
      {!client.gender && <div style={{ fontSize: 11, color: t.textDim, marginTop: -10, marginBottom: 14, textAlign: "center" }}>⚠️ El cliente no ha indicado su género aún</div>}

      {/* AUTO-CALCULATED TOTALS */}
      <div style={{ background: t.bgCard, border: `1.5px solid ${t.border}`, borderRadius: 14, padding: "14px 16px", marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 4 }}>MACROS TOTALES (Opción A)</div>
        <div style={{ fontSize: 10, color: t.textDim, marginBottom: 10 }}>Calculados con la primera opción de cada comida</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, textAlign: "center" }}>
          {[["🔥","Kcal",totals.kcal,""],["💪","Prot",totals.prot,"g"],["🌾","Carbs",totals.carb,"g"],["🥑","Grasas",totals.fat,"g"]].map(([ico,lbl,val,unit]) => (
            <div key={lbl} style={{ background: t.bgElevated, borderRadius: 10, padding: "10px 4px" }}>
              <div style={{ fontSize: 16 }}>{ico}</div>
              <div style={{ fontSize: 17, fontWeight: 900, color: t.text, letterSpacing: "-0.02em" }}>{val}{unit}</div>
              <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700 }}>{lbl}</div>
            </div>
          ))}
        </div>
      </div>

      <Sep/>

      {/* Meals */}
      {(d.meals || []).map(meal => {
        const isOpen = openMeal === meal.id;
        // Calculate meal totals — only first option (A) of each section
        let mKcal = 0, mProt = 0, mCarb = 0, mFat = 0;
        meal.sections?.forEach(s => {
          const firstItem = s.items?.[0];
          if (firstItem?.macros) {
            mKcal += +firstItem.macros.kcal || 0;
            mProt += +firstItem.macros.prot || 0;
            mCarb += +firstItem.macros.carb || 0;
            mFat  += +firstItem.macros.fat  || 0;
          }
        });

        return (
          <div key={meal.id} style={{ border: `1.5px solid ${isOpen ? "rgba(13,142,173,0.3)" : t.border}`, borderRadius: 14, marginBottom: 10, overflow: "hidden" }}>
            {/* Meal header */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", background: isOpen ? "rgba(13,142,173,0.06)" : "transparent" }}>
              <button onClick={() => setOpenMeal(isOpen ? null : meal.id)}
                style={{ flex: 1, background: "none", border: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ color: isOpen ? t.accent : t.textDim, transition: "transform 0.2s", transform: isOpen ? "rotate(180deg)" : "none" }}><Icon n="down" s={15}/></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>{meal.title}</div>
                  {mKcal > 0 && <div style={{ fontSize: 11, color: t.textSub, marginTop: 2 }}>🔥 {Math.round(mKcal)} kcal · 💪 {mProt.toFixed(0)}g · 🌾 {mCarb.toFixed(0)}g · 🥑 {mFat.toFixed(0)}g</div>}
                </div>
              </button>
              <button onClick={() => rmMeal(meal.id)} style={{ background: t.dangerAlpha, border: "none", borderRadius: 8, padding: "0 10px", height: 32, cursor: "pointer", color: t.danger, display: "flex", alignItems: "center" }}><Icon n="trash" s={13}/></button>
            </div>

            {isOpen && (
              <div style={{ padding: "0 14px 14px" }}>
                {/* Meal basic fields */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
                  <div>
                    <div style={{ color: t.textSub, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>TÍTULO</div>
                    <input value={meal.title} onChange={e => updMeal(meal.id, "title", e.target.value)} style={{ ...si, width: "100%", boxSizing: "border-box" }}/>
                  </div>
                  <div>
                    <div style={{ color: t.textSub, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>SUBTÍTULO</div>
                    <input value={meal.subtitle || ""} onChange={e => updMeal(meal.id, "subtitle", e.target.value)} style={{ ...si, width: "100%", boxSizing: "border-box" }}/>
                  </div>
                  <div>
                    <div style={{ color: t.textSub, fontSize: 10, fontWeight: 700, marginBottom: 4 }}>HORA</div>
                    <input value={meal.time || ""} onChange={e => updMeal(meal.id, "time", e.target.value)} placeholder="14:00" style={{ ...si, width: "100%", boxSizing: "border-box" }}/>
                  </div>
                </div>

                {/* Sections: Protein / Carbs / Fat */}
                {(meal.sections || []).map(sec => {
                  const cfg = secConfig[sec.type] || secConfig.protein;
                  const foodOptions = ALL_FOODS.filter(f => f.cat === cfg.cat);
                  const letters = ["A","B","C","D","E","F","G","H"];
                  return (
                    <div key={sec.id} style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${cfg.border}`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: cfg.color, marginBottom: 8 }}>{cfg.label}</div>

                      {/* Existing options */}
                      {(sec.items || []).map((item, idx) => (
                        <div key={item.id} style={{ background: t.bg, border: `1px solid ${t.border}`, borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
                          {/* Option header */}
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                            <div style={{ background: cfg.color, color: "white", borderRadius: 8, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 900, flexShrink: 0 }}>{letters[idx] || "?"}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, color: t.text, fontWeight: 700 }}>Opción {letters[idx] || "?"}</div>
                              {item.macros && (
                                <div style={{ fontSize: 10, color: t.textDim, fontWeight: 500, marginTop: 2 }}>
                                  Total: {item.macros.kcal} kcal · {item.macros.prot}P · {item.macros.carb}C · {item.macros.fat}G
                                </div>
                              )}
                            </div>
                            <button onClick={() => rmItem(meal.id, sec.id, item.id)}
                              style={{ background: t.dangerAlpha, border: "none", borderRadius: 8, width: 28, height: 28, cursor: "pointer", color: t.danger, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                              <Icon n="x" s={13}/>
                            </button>
                          </div>

                          {/* Render components or single food */}
                          {item.components && item.components.length > 1 ? (
                            // Multi-food option
                            <div>
                              {item.components.map(comp => (
                                <div key={comp.id} style={{ background: t.bgElevated, borderRadius: 8, padding: "8px 10px", marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
                                  <span style={{ fontSize: 14 }}>{comp.emoji || "🍽️"}</span>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 12, color: t.text, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{comp.name}</div>
                                  </div>
                                  <button onClick={() => updComponentGrams(meal.id, sec.id, item.id, comp.id, Math.max(0, (comp.grams || 100) - 10))}
                                    style={{ background: t.bg, border: `1px solid ${t.border}`, borderRadius: 6, width: 26, height: 26, cursor: "pointer", color: t.text, fontSize: 13, fontWeight: 900 }}>−</button>
                                  <div style={{ minWidth: 52, textAlign: "center", fontSize: 13, fontWeight: 800, color: cfg.color }}>{comp.grams}<span style={{ fontSize: 9, color: t.textSub }}>g</span></div>
                                  <button onClick={() => updComponentGrams(meal.id, sec.id, item.id, comp.id, (comp.grams || 100) + 10)}
                                    style={{ background: t.bg, border: `1px solid ${t.border}`, borderRadius: 6, width: 26, height: 26, cursor: "pointer", color: t.text, fontSize: 13, fontWeight: 900 }}>+</button>
                                  <button onClick={() => rmComponent(meal.id, sec.id, item.id, comp.id)}
                                    style={{ background: "none", border: "none", cursor: "pointer", color: t.textDim, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    <Icon n="x" s={11}/>
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            // Single food (legacy)
                            <>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                <span style={{ fontSize: 15 }}>{item.emoji || "🍽️"}</span>
                                <span style={{ fontSize: 13, color: t.text, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginBottom: 6 }}>
                                <button onClick={() => updItemGrams(meal.id, sec.id, item.id, Math.max(0, (item.grams || 100) - 10))}
                                  style={{ background: t.bgElevated, border: `1.5px solid ${t.border}`, borderRadius: 8, width: 36, height: 36, cursor: "pointer", color: t.text, fontSize: 18, fontWeight: 900 }}>−</button>
                                <div style={{ background: t.bgElevated, borderRadius: 8, padding: "8px 16px", minWidth: 80, textAlign: "center" }}>
                                  <div style={{ fontSize: 16, fontWeight: 900, color: cfg.color, letterSpacing: "-0.02em" }}>{item.grams || 100}<span style={{ fontSize: 11, color: t.textSub, fontWeight: 700, marginLeft: 2 }}>g</span></div>
                                </div>
                                <button onClick={() => updItemGrams(meal.id, sec.id, item.id, (item.grams || 100) + 10)}
                                  style={{ background: t.bgElevated, border: `1.5px solid ${t.border}`, borderRadius: 8, width: 36, height: 36, cursor: "pointer", color: t.text, fontSize: 18, fontWeight: 900 }}>+</button>
                              </div>
                            </>
                          )}

                          {/* Add another food to this option */}
                          <AddComponentSelector foods={foodOptions} onAdd={(food, grams) => addComponentToItem(meal.id, sec.id, item.id, food, grams)} accentColor={cfg.color}/>
                        </div>
                      ))}

                      {/* Add new option */}
                      <FoodSelector foods={foodOptions} onAdd={(food, grams) => addFoodItem(meal.id, sec.id, food, grams)} accentColor={cfg.color} nextLetter={letters[sec.items?.length || 0] || "?"}/>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
        <Btn onClick={addMeal} variant="ghost" size="sm"><Icon n="plus" s={14}/> Comida</Btn>
        <SaveBtn onSave={save} saved={saved}/>
      </div>
    </div>
  );
};

// ─── FoodSelector — picks a food from a filtered list + grams ────────────────
const FoodSelector = ({ foods, onAdd, accentColor, nextLetter }) => {
  const [selectedName, setSelectedName] = useState("");
  const [grams, setGrams] = useState(100);

  const handleAdd = () => {
    const food = foods.find(f => f.name === selectedName);
    if (!food || !grams) return;
    onAdd(food, grams);
    setSelectedName(""); setGrams(100);
  };

  const si = { background: t.bg, border: `1px solid ${t.border}`, borderRadius: 8, padding: "10px 12px", color: t.text, fontSize: 13, fontFamily: "inherit", outline: "none" };

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: `1.5px dashed ${t.border}`, borderRadius: 10, padding: 10, marginTop: 4 }}>
      <div style={{ fontSize: 11, color: t.textSub, fontWeight: 700, letterSpacing: "0.04em", marginBottom: 8 }}>+ AÑADIR OPCIÓN {nextLetter}</div>
      <select value={selectedName} onChange={e => setSelectedName(e.target.value)}
        style={{ ...si, width: "100%", boxSizing: "border-box", marginBottom: 8, color: selectedName ? t.text : t.textDim }}>
        <option value="">Elige un alimento...</option>
        {foods.map(f => <option key={f.name} value={f.name}>{f.emoji} {f.name}</option>)}
      </select>
      {selectedName && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginBottom: 8 }}>
            <button onClick={() => setGrams(g => Math.max(0, (+g) - 10))}
              style={{ background: t.bgElevated, border: `1.5px solid ${t.border}`, borderRadius: 8, width: 36, height: 36, cursor: "pointer", color: t.text, fontSize: 18, fontWeight: 900 }}>
              −
            </button>
            <div style={{ background: t.bgElevated, borderRadius: 8, padding: "8px 16px", minWidth: 80, textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 900, color: accentColor, letterSpacing: "-0.02em" }}>{grams}<span style={{ fontSize: 11, color: t.textSub, fontWeight: 700, marginLeft: 2 }}>g</span></div>
            </div>
            <button onClick={() => setGrams(g => (+g) + 10)}
              style={{ background: t.bgElevated, border: `1.5px solid ${t.border}`, borderRadius: 8, width: 36, height: 36, cursor: "pointer", color: t.text, fontSize: 18, fontWeight: 900 }}>
              +
            </button>
          </div>
          <button onClick={handleAdd}
            style={{ width: "100%", background: accentColor, border: "none", borderRadius: 8, padding: "10px", cursor: "pointer", color: "white", fontSize: 13, fontWeight: 800, fontFamily: "inherit" }}>
            ✓ Añadir Opción {nextLetter}
          </button>
        </>
      )}
    </div>
  );
};

// ─── AddComponentSelector — add another food to an existing option ───────────
const AddComponentSelector = ({ foods, onAdd, accentColor }) => {
  const [open, setOpen] = useState(false);
  const [selectedName, setSelectedName] = useState("");
  const [grams, setGrams] = useState(100);

  const handleAdd = () => {
    const food = foods.find(f => f.name === selectedName);
    if (!food || !grams) return;
    onAdd(food, grams);
    setSelectedName(""); setGrams(100); setOpen(false);
  };

  const si = { background: t.bg, border: `1px solid ${t.border}`, borderRadius: 8, padding: "8px 10px", color: t.text, fontSize: 12, fontFamily: "inherit", outline: "none" };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{ width: "100%", background: "none", border: `1px dashed ${t.border}`, borderRadius: 8, padding: "8px 10px", marginTop: 6, cursor: "pointer", color: t.textSub, fontSize: 11, fontWeight: 700, fontFamily: "inherit" }}>
        + Añadir otro alimento a esta opción
      </button>
    );
  }

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: `1.5px dashed ${t.border}`, borderRadius: 8, padding: 10, marginTop: 6 }}>
      <select value={selectedName} onChange={e => setSelectedName(e.target.value)} autoFocus
        style={{ ...si, width: "100%", boxSizing: "border-box", marginBottom: 8 }}>
        <option value="">Elige un alimento...</option>
        {foods.map(f => <option key={f.name} value={f.name}>{f.emoji} {f.name}</option>)}
      </select>
      {selectedName && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, justifyContent: "center" }}>
          <button onClick={() => setGrams(g => Math.max(0, (+g) - 10))}
            style={{ background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 6, width: 30, height: 30, cursor: "pointer", color: t.text, fontSize: 14, fontWeight: 900 }}>−</button>
          <div style={{ background: t.bgElevated, borderRadius: 6, padding: "6px 12px", minWidth: 60, textAlign: "center", fontSize: 13, fontWeight: 900, color: accentColor }}>{grams}<span style={{ fontSize: 10, color: t.textSub, marginLeft: 2 }}>g</span></div>
          <button onClick={() => setGrams(g => (+g) + 10)}
            style={{ background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 6, width: 30, height: 30, cursor: "pointer", color: t.text, fontSize: 14, fontWeight: 900 }}>+</button>
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={handleAdd} disabled={!selectedName}
          style={{ flex: 1, background: selectedName ? accentColor : t.bgElevated, border: "none", borderRadius: 8, padding: "8px", cursor: selectedName ? "pointer" : "not-allowed", color: "white", fontSize: 12, fontWeight: 800, fontFamily: "inherit", opacity: selectedName ? 1 : 0.4 }}>
          ✓ Añadir
        </button>
        <button onClick={() => { setOpen(false); setSelectedName(""); }}
          style={{ background: "none", border: `1px solid ${t.border}`, borderRadius: 8, padding: "8px 12px", cursor: "pointer", color: t.textSub, fontSize: 11, fontFamily: "inherit" }}>
          Cancelar
        </button>
      </div>
    </div>
  );
};

const AWeightTab = ({ client, weights, db, setDb }) => {
  const [w, setW] = useState("");
  const [d, setD] = useState(new Date().toISOString().slice(0,10));
  const add = async () => {
    const wf=parseFloat(w); if(isNaN(wf)) return;
    setDb(p=>({...p,weightHistory:{...p.weightHistory,[client.id]:[...weights,{date:d,weight:wf}].sort((a,b)=>a.date.localeCompare(b.date))}}));
    setW("");
    await sb.insert("weight_entries", { client_id: client.id, date: d, weight_kg: wf });
  };
  const rm  = i => setDb(p=>({...p,weightHistory:{...p.weightHistory,[client.id]:p.weightHistory[client.id].filter((_,j)=>j!==i)}}));
  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <Card accent><WeightChart data={weights}/></Card>
      <Card>
        <div style={{fontSize:11,color:t.textSub,fontWeight:700,letterSpacing:"0.06em",marginBottom:12}}>AÑADIR REGISTRO</div>
        <div style={{display:"flex",gap:8}}>
          <input type="date" value={d} onChange={e=>setD(e.target.value)}
            style={{flex:1,background:t.bgInput,border:`1.5px solid ${t.border}`,borderRadius:12,padding:"12px 14px",color:t.text,fontSize:13,fontFamily:"inherit",outline:"none"}}/>
          <input type="number" step="0.1" value={w} onChange={e=>setW(e.target.value)} placeholder="kg"
            style={{width:80,background:t.bgInput,border:`1.5px solid ${t.border}`,borderRadius:12,padding:"12px 14px",color:t.text,fontSize:14,fontFamily:"inherit",outline:"none"}}/>
          <Btn onClick={add} style={{paddingLeft:16,paddingRight:16}}><Icon n="plus" s={17}/></Btn>
        </div>
      </Card>
      <Card>
        {[...weights].reverse().map((entry, i) => (
          <div key={`${entry.date}-${entry.weight}-${i}`} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"13px 0",borderBottom:i<weights.length-1?`1px solid ${t.border}`:"none"}}>
            <span style={{fontSize:14,color:t.textSub}}>{entry.date}</span>
            <div style={{display:"flex",gap:14,alignItems:"center"}}>
              <span style={{fontSize:16,fontWeight:800,color:t.text}}>{entry.weight} <span style={{fontSize:12,color:t.textDim,fontWeight:400}}>kg</span></span>
              <button onClick={() => setDb(p => ({ ...p, weightHistory: { ...p.weightHistory, [client.id]: p.weightHistory[client.id].filter((e, idx) => !(e.date === entry.date && e.weight === entry.weight && idx === weights.length - 1 - i)) } }))}
                style={{background:"none",border:"none",cursor:"pointer",color:t.textDim,padding:4}}><Icon n="trash" s={14}/></button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
};

const ANotesTab = ({ client, notes, db, setDb }) => {
  const [text, setText] = useState("");
  const [type, setType] = useState("general");
  const add = async () => {
    if(!text.trim()) return;
    const note = {date:new Date().toISOString().slice(0,10),note:text,type};
    setDb(p=>({...p,coachNotes:{...p.coachNotes,[client.id]:[note,...(p.coachNotes[client.id]||[])]}}));
    setText("");
    await sb.insert("coach_notes", { client_id: client.id, note: text, type });
  };
  const rm  = i => setDb(p=>({...p,coachNotes:{...p.coachNotes,[client.id]:p.coachNotes[client.id].filter((_,j)=>j!==i)}}));
  const types = [["general","General"],["progress","Progreso"],["injury","Lesión"],["nutrition","Nutrición"]];
  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <Card>
        <div style={{fontSize:11,color:t.textSub,fontWeight:700,letterSpacing:"0.06em",marginBottom:10}}>NUEVA NOTA</div>
        <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
          {types.map(([val,lbl])=>(
            <button key={val} onClick={()=>setType(val)}
              style={{background:type===val?t.accentAlpha:t.bgElevated,border:`1.5px solid ${type===val?"rgba(30,155,191,0.3)":t.border}`,borderRadius:8,padding:"7px 14px",cursor:"pointer",color:type===val?t.accent:t.textSub,fontSize:12,fontWeight:700,fontFamily:"inherit",transition:"all 0.15s"}}>
              {lbl}
            </button>
          ))}
        </div>
        <textarea value={text} onChange={e=>setText(e.target.value)} placeholder="Escribe aquí la nota de seguimiento..." rows={3}
          style={{width:"100%",background:t.bgInput,border:`1.5px solid ${t.border}`,borderRadius:12,padding:"12px 14px",color:t.text,fontSize:14,fontFamily:"inherit",outline:"none",resize:"vertical",boxSizing:"border-box",marginBottom:12}}
          onFocus={e=>e.target.style.borderColor=t.accent} onBlur={e=>e.target.style.borderColor=t.border}/>
        <Btn onClick={add} size="sm"><Icon n="plus" s={14}/> Añadir</Btn>
      </Card>
      {notes.map((n,i)=>(
        <Card key={i}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <Pill color={n.type==="injury"?"danger":n.type==="progress"?"accent":"default"}>
              {n.type==="injury"?"Lesión":n.type==="progress"?"Progreso":n.type==="nutrition"?"Nutrición":"General"}
            </Pill>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <span style={{fontSize:12,color:t.textDim}}>{n.date}</span>
              <button onClick={()=>rm(i)} style={{background:"none",border:"none",cursor:"pointer",color:t.textDim,padding:4}}><Icon n="trash" s={14}/></button>
            </div>
          </div>
          <div style={{fontSize:14,color:t.text,lineHeight:1.6}}>{n.note}</div>
        </Card>
      ))}
    </div>
  );
};

const ANewClient = ({ db, setDb, onDone }) => {
  const [f, setF] = useState({name:"",email:"",password:""});
  const [copied, setCopied] = useState(false);
  const fld = k => ({ value: f[k], onChange: v => setF(p=>({...p,[k]:v})) });

  const genPassword = () => {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const pwd = Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    setF(p => ({...p, password: pwd}));
    setCopied(false);
  };

  const copyPassword = () => {
    if (!f.password) return;
    navigator.clipboard?.writeText(f.password).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const create = async () => {
    if(!f.name||!f.email||!f.password) return alert("Nombre, usuario y contraseña son obligatorios");
    const id="c"+Date.now(), uid="u"+Date.now();
    const startDate = new Date().toISOString().slice(0,10);
    const avatar = f.name.split(" ").map(n=>n[0]).join("").slice(0,2).toUpperCase();
    setDb(p=>({
      ...p,
      clients:[...p.clients,{id,userId:uid,avatar,status:"active",startDate,name:f.name,email:f.email,password:f.password,phone:"",age:0,height:0,goal:"",personalNotes:"",injuries:""}],
      users:[...p.users,{id:uid,email:f.email,password:f.password,role:"client",name:f.name,clientId:id}],
      weightHistory:{ ...p.weightHistory, [id]: [] },
      coachNotes:{ ...p.coachNotes, [id]: [] },
    }));
    await sb.upsert("clients", {
      id, user_id: uid, name: f.name, email: f.email,
      password: f.password, password_changed: false,
      status: "active", start_date: startDate, avatar,
    });
    onDone();
  };

  return (
    <div>
      <Card>
        <Field label="NOMBRE COMPLETO *" {...fld("name")}/>
        <Field label="USUARIO *" {...fld("email")}/>
        {/* Password field with generator */}
        <div style={{marginBottom:16}}>
          <div style={{color:t.textSub,fontSize:11,fontWeight:700,letterSpacing:"0.07em",marginBottom:7}}>CONTRASEÑA *</div>
          <div style={{display:"flex",gap:8}}>
            <div style={{position:"relative",flex:1}}>
              <input value={f.password} onChange={e=>setF(p=>({...p,password:e.target.value}))}
                style={{width:"100%",background:t.bgInput,border:`1.5px solid ${t.border}`,borderRadius:12,padding:"13px 16px",color:t.text,fontSize:15,fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}
                placeholder="Contraseña"/>
            </div>
            <button onClick={genPassword}
              style={{background:t.accentAlpha,border:`1.5px solid rgba(30,155,191,0.3)`,borderRadius:12,padding:"0 14px",cursor:"pointer",color:t.accent,fontSize:12,fontWeight:700,fontFamily:"inherit",whiteSpace:"nowrap"}}>
              🔀 Generar
            </button>
            <button onClick={copyPassword} disabled={!f.password}
              style={{background:copied?t.accentAlpha:t.bgElevated,border:`1.5px solid ${copied?"rgba(30,155,191,0.3)":t.border}`,borderRadius:12,padding:"0 14px",cursor:f.password?"pointer":"not-allowed",color:copied?t.accent:t.textSub,fontSize:12,fontWeight:700,fontFamily:"inherit",opacity:f.password?1:0.4,whiteSpace:"nowrap"}}>
              {copied ? "✓ Copiada" : "📋 Copiar"}
            </button>
          </div>
          {f.password && (
            <div style={{fontSize:11,color:t.textDim,marginTop:6}}>
              💡 Copia la contraseña antes de crear el cliente para enviársela.
            </div>
          )}
        </div>

        <div style={{fontSize:12,color:t.textSub,marginBottom:16,lineHeight:1.5}}>
          El cliente completará el resto de su perfil cuando inicie sesión por primera vez.
        </div>
        <div style={{display:"flex",gap:10}}>
          <Btn onClick={create}><Icon n="plus" s={16}/> Crear Cliente</Btn>
          <Btn onClick={onDone} variant="ghost">Cancelar</Btn>
        </div>
      </Card>
    </div>
  );
};

// ─── ClientQuestionnaire — initial complex questionnaire (9 sections) ────────
// ─── ClientQuestionnaire helpers (defined OUTSIDE to avoid remount on each keystroke) ───
const QChipBtn = ({ active, onClick, children, color }) => (
  <button type="button" onClick={onClick}
    style={{ background: active ? (color ? `${color}22` : t.accentAlpha) : t.bgElevated, border: `1.5px solid ${active ? (color || "rgba(30,155,191,0.4)") : t.border}`, borderRadius: 10, padding: "10px 14px", cursor: "pointer", color: active ? (color || t.accent) : t.textSub, fontSize: 13, fontWeight: 700, fontFamily: "inherit", flex: 1, minWidth: 0 }}>
    {children}
  </button>
);

const QChips = ({ value, options, onChange, color }) => (
  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
    {options.map(opt => {
      const [val, lbl] = Array.isArray(opt) ? opt : [opt, opt];
      return (
        <div key={val} style={{ flex: "1 1 calc(50% - 3px)", minWidth: 0 }}>
          <QChipBtn active={value === val} onClick={() => onChange(val)} color={color}>{lbl}</QChipBtn>
        </div>
      );
    })}
  </div>
);

const QQ = ({ children }) => (
  <div style={{ color: t.text, fontSize: 14, fontWeight: 700, marginBottom: 10, lineHeight: 1.4 }}>{children}</div>
);

const QTA = ({ value, onChange, placeholder, rows = 3 }) => (
  <textarea value={value || ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows}
    style={{ width: "100%", boxSizing: "border-box", background: t.bgInput, border: `1.5px solid ${t.border}`, borderRadius: 10, padding: "11px 13px", color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 16, lineHeight: 1.5 }}/>
);

const QTI = ({ value, onChange, placeholder, type = "text" }) => (
  <input value={value || ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} type={type}
    style={{ width: "100%", boxSizing: "border-box", background: t.bgInput, border: `1.5px solid ${t.border}`, borderRadius: 10, padding: "11px 13px", color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none", marginBottom: 16 }}/>
);

const ClientQuestionnaire = ({ client, onDone, onBack }) => {
  const storageKey = `gf_questionnaire_${client.id}`;

  // Restore saved progress if any
  const loadSaved = () => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        return { step: saved.step || 0, a: saved.a || {} };
      }
    } catch {}
    return { step: 0, a: {} };
  };
  const initial = loadSaved();

  const [step, setStep] = useState(initial.step);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [a, setA] = useState(initial.a);
  const [showRestoreMsg, setShowRestoreMsg] = useState(initial.step > 0 || Object.keys(initial.a).length > 0);
  const [busy, setBusy] = useState(false); // prevent double-click
  const [loadingRemote, setLoadingRemote] = useState(true);

  const set = (k, v) => setA(p => ({ ...p, [k]: v }));

  // Fetch existing answers from Supabase on mount — if exists, merge with local
  useEffect(() => {
    (async () => {
      try {
        const rows = await sb.select("client_questionnaires", `?client_id=eq.${client.id}`);
        if (rows && rows.length > 0 && rows[0].answers) {
          const remoteAnswers = rows[0].answers;
          // Only use remote if local is empty (else keep local progress)
          if (Object.keys(initial.a).length === 0) {
            setA(remoteAnswers);
            setShowRestoreMsg(true);
          }
        }
      } catch {}
      setLoadingRemote(false);
    })();
  }, [client.id]);

  // Auto-save to localStorage on every change
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ step, a }));
    } catch {}
  }, [step, a]);

  // Anti double-click helper
  const guardedSet = (k, v) => {
    if (busy) return;
    setBusy(true);
    set(k, v);
    setTimeout(() => setBusy(false), 300);
  };

  const sections = [
    // Section 1 — Objetivos
    {
      title: "Objetivos", icon: "🎯",
      validate: () => a.objective && a.deadline,
      render: () => (
        <>
          <QQ>¿Cuál es tu objetivo principal?</QQ>
          <QTA value={a.objective} onChange={v => set("objective", v)} placeholder="Ej: Perder grasa, ganar músculo, tonificar, mejorar rendimiento..." rows={2}/>
          <QQ>¿Para cuándo te gustaría conseguirlo?</QQ>
          <QChips value={a.deadline} options={[["1-2m","1-2 meses"],["3-6m","3-6 meses"],["6-12m","6-12 meses"],["+1a","+1 año"]]} onChange={v => set("deadline", v)}/>
        </>
      ),
    },
    // Section 2 — Hábitos diarios
    {
      title: "Hábitos diarios", icon: "⏰",
      validate: () => a.wakeUp && a.bedTime && a.sleepHours && a.mealsPerDay && a.mealTimes,
      render: () => (
        <>
          <QQ>¿A qué hora te despiertas normalmente?</QQ>
          <QTI value={a.wakeUp} onChange={v => set("wakeUp", v)} placeholder="Ej: 07:00"/>
          <QQ>¿A qué hora te acuestas normalmente?</QQ>
          <QTI value={a.bedTime} onChange={v => set("bedTime", v)} placeholder="Ej: 23:30"/>
          <QQ>¿Cuántas horas duermes normalmente?</QQ>
          <QChips value={a.sleepHours} options={[["<5","menos 5h"],["5-6","5-6h"],["6-7","6-7h"],["7-8","7-8h"],["8+","más 8h"]]} onChange={v => set("sleepHours", v)}/>
          <QQ>¿Cuántas comidas haces al día actualmente?</QQ>
          <QChips value={a.mealsPerDay} options={["2","3","4","5","6+"]} onChange={v => set("mealsPerDay", v)}/>
          <QQ>¿A qué horas sueles comer?</QQ>
          <QTA value={a.mealTimes} onChange={v => set("mealTimes", v)} placeholder="Ej: 8:00 desayuno, 11:00 snack, 14:00 comida, 17:00 merienda, 21:00 cena" rows={2}/>
        </>
      ),
    },
    // Section 3 — Entrenamiento
    {
      title: "Entrenamiento", icon: "💪",
      validate: () => a.trainingNow && (a.trainingNow === "no" || (a.trainingDays && a.trainingType)) && a.steps,
      render: () => (
        <>
          <QQ>¿Entrenas actualmente?</QQ>
          <QChips value={a.trainingNow} options={[["si","✓ Sí"],["no","✕ No"]]} onChange={v => set("trainingNow", v)}/>
          {a.trainingNow === "si" && (
            <>
              <QQ>¿Cuántos días a la semana entrenas?</QQ>
              <QChips value={a.trainingDays} options={["1","2","3","4","5","6","7"]} onChange={v => set("trainingDays", v)}/>
              <QQ>¿Qué tipo de entrenamiento haces?</QQ>
              <QChips value={a.trainingType} options={[["fuerza","Fuerza"],["cardio","Cardio"],["hiit","HIIT"],["mixto","Mixto"],["otros","Otros"]]} onChange={v => set("trainingType", v)}/>
              {a.trainingType === "otros" && <QTI value={a.trainingTypeOther} onChange={v => set("trainingTypeOther", v)} placeholder="Especifica..."/>}
            </>
          )}
          <QQ>¿Cuántos pasos haces al día aproximadamente?</QQ>
          <QChips value={a.steps} options={[["<5k","menos 5.000"],["5-8k","5.000-8.000"],["8-10k","8.000-10.000"],["10k+","más 10.000"]]} onChange={v => set("steps", v)}/>
        </>
      ),
    },
    // Section 4 — Alimentación actual
    {
      title: "Alimentación actual", icon: "🍽️",
      validate: () => a.typicalDay && a.snacking && (a.snacking === "no" || a.snackingWhat),
      render: () => (
        <>
          <QQ>Describe todo lo que comes en un día normal</QQ>
          <QTA value={a.typicalDay} onChange={v => set("typicalDay", v)} placeholder="Ej: Desayuno: café con leche y tostada. Comida: pasta con pollo. Cena: ensalada..." rows={5}/>
          <QQ>¿Sueles picar entre horas?</QQ>
          <QChips value={a.snacking} options={[["si","✓ Sí"],["no","✕ No"]]} onChange={v => set("snacking", v)}/>
          {a.snacking === "si" && (
            <>
              <QQ>¿Qué sueles comer?</QQ>
              <QTA value={a.snackingWhat} onChange={v => set("snackingWhat", v)} placeholder="Ej: galletas, chocolate, fruta, frutos secos..." rows={2}/>
            </>
          )}
        </>
      ),
    },
    // Section 5 — Preferencias
    {
      title: "Preferencias", icon: "❤️",
      validate: () => a.foodsLike && a.foodsDislike && a.foodsExclude !== undefined,
      render: () => (
        <>
          <QQ>¿Qué alimentos te gustan mucho?</QQ>
          <QTA value={a.foodsLike} onChange={v => set("foodsLike", v)} placeholder="Ej: pollo, arroz, aguacate..."/>
          <QQ>¿Qué alimentos NO te gustan?</QQ>
          <QTA value={a.foodsDislike} onChange={v => set("foodsDislike", v)} placeholder="Ej: pescado, setas..."/>
          <QQ>¿Hay alimentos que no quieras incluir por ningún motivo?</QQ>
          <QTA value={a.foodsExclude} onChange={v => set("foodsExclude", v)} placeholder="Ej: por religión, por ética, por digestión... Si no hay, escribe: ninguno"/>
        </>
      ),
    },
    // Section 6 — Salud
    {
      title: "Salud", icon: "⚕️",
      validate: () => a.allergy && (a.allergy === "no" || a.allergyDetails)
        && a.digestion && (a.digestion === "no" || a.digestionDetails)
        && a.meds && (a.meds === "no" || a.medsDetails),
      render: () => (
        <>
          <QQ>¿Tienes alguna intolerancia o alergia?</QQ>
          <QChips value={a.allergy} options={[["si","✓ Sí"],["no","✕ No"]]} onChange={v => set("allergy", v)}/>
          {a.allergy === "si" && <QTA value={a.allergyDetails} onChange={v => set("allergyDetails", v)} placeholder="Especifica cuáles..." rows={2}/>}

          <QQ>¿Tienes problemas digestivos (hinchazón, gases, etc.)?</QQ>
          <QChips value={a.digestion} options={[["si","✓ Sí"],["no","✕ No"]]} onChange={v => set("digestion", v)}/>
          {a.digestion === "si" && <QTA value={a.digestionDetails} onChange={v => set("digestionDetails", v)} placeholder="Describe los síntomas..." rows={2}/>}

          <QQ>¿Tomas medicación o tienes alguna patología?</QQ>
          <QChips value={a.meds} options={[["si","✓ Sí"],["no","✕ No"]]} onChange={v => set("meds", v)}/>
          {a.meds === "si" && <QTA value={a.medsDetails} onChange={v => set("medsDetails", v)} placeholder="Especifica..." rows={2}/>}
        </>
      ),
    },
    // Section 7 — Historial
    {
      title: "Historial", icon: "📜",
      validate: () => a.pastDiets && (a.pastDiets === "no" || a.pastDietsDetails),
      render: () => (
        <>
          <QQ>¿Has hecho dietas antes?</QQ>
          <QChips value={a.pastDiets} options={[["si","✓ Sí"],["no","✕ No"]]} onChange={v => set("pastDiets", v)}/>
          {a.pastDiets === "si" && (
            <>
              <QQ>¿Qué te funcionó y qué no?</QQ>
              <QTA value={a.pastDietsDetails} onChange={v => set("pastDietsDetails", v)} placeholder="Cuéntanos tu experiencia..." rows={4}/>
            </>
          )}
        </>
      ),
    },
    // Section 8 — Contexto real
    {
      title: "Contexto real", icon: "💭",
      validate: () => a.biggestProblem && a.failSituations,
      render: () => (
        <>
          <QQ>¿Cuál crees que es tu mayor problema con la alimentación?</QQ>
          <QTA value={a.biggestProblem} onChange={v => set("biggestProblem", v)} placeholder="Sé sincero/a, esto nos ayuda a ayudarte..." rows={3}/>
          <QQ>¿Qué situaciones te hacen fallar más?</QQ>
          <QTA value={a.failSituations} onChange={v => set("failSituations", v)} placeholder="Ej: fines de semana, cenas fuera, estrés, aburrimiento..." rows={3}/>
        </>
      ),
    },
    // Section 9 — Compromiso
    {
      title: "Compromiso", icon: "🔥",
      validate: () => a.commitment && a.finalNotes !== undefined,
      render: () => (
        <>
          <QQ>Del 1 al 10, ¿cómo de comprometido/a estás con el proceso?</QQ>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 16 }}>
            {[1,2,3,4,5,6,7,8,9,10].map(n => (
              <button key={n} type="button" onClick={() => set("commitment", String(n))}
                style={{ background: a.commitment === String(n) ? t.accentAlpha : t.bgElevated, border: `1.5px solid ${a.commitment === String(n) ? "rgba(30,155,191,0.4)" : t.border}`, borderRadius: 10, padding: "12px 0", cursor: "pointer", color: a.commitment === String(n) ? t.accent : t.textSub, fontSize: 15, fontWeight: 800, fontFamily: "inherit" }}>
                {n}
              </button>
            ))}
          </div>
          <QQ>¿Hay algo importante que deba tener en cuenta para tu planificación?</QQ>
          <QTA value={a.finalNotes} onChange={v => set("finalNotes", v)} placeholder="Cualquier detalle útil. Si no, escribe: nada que añadir" rows={3}/>
        </>
      ),
    },
  ];

  const current = sections[step];
  const totalSteps = sections.length;
  const progress = ((step + 1) / totalSteps) * 100;

  const next = () => {
    if (busy || saving) return; // prevent double-click
    if (!current.validate()) {
      setErr("Por favor responde todas las preguntas de esta sección");
      return;
    }
    setBusy(true);
    setErr("");
    if (step < totalSteps - 1) {
      setStep(s => s + 1);
      window.scrollTo(0, 0);
    } else {
      submit();
    }
    setTimeout(() => setBusy(false), 400);
  };

  const prev = () => {
    if (busy || saving) return;
    setBusy(true);
    setErr("");
    if (step > 0) setStep(s => s - 1);
    setTimeout(() => setBusy(false), 400);
  };

  const submit = async () => {
    if (saving) return; // prevent double submission
    setSaving(true);
    try {
      // Use upsert on client_id to handle case of re-submitting
      await sb.upsert("client_questionnaires", {
        client_id: client.id,
        answers: a,
        completed_at: new Date().toISOString(),
      }, "client_id");
      // Notify all admins
      const admins = await sb.select("admins", "?select=id");
      for (const admin of admins || []) {
        await sb.insert("admin_notifications", {
          admin_id: admin.id, type: "questionnaire",
          title: "Cuestionario completado",
          body: `${client.name} ha rellenado el cuestionario inicial`,
          link_type: "client", link_id: client.id, read: false,
        });
      }
      // Clear localStorage after successful save
      try { localStorage.removeItem(storageKey); } catch {}
      onDone();
    } catch (e) {
      setErr("Error al guardar. Inténtalo de nuevo.");
      setSaving(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: t.bg, maxWidth: 430, margin: "0 auto", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "52px 20px 20px", background: `linear-gradient(180deg, rgba(240,160,48,0.08) 0%, transparent 100%)`, borderBottom: `1px solid ${t.border}` }}>
        <button onClick={onBack} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", color:t.textSub, fontFamily:"inherit", fontSize:13, fontWeight:600, marginBottom:14, padding:0 }}>
          <Icon n="back" s={16}/> Salir (se guarda automáticamente)
        </button>
        <div style={{ fontSize: 22, fontWeight: 900, color: t.text, letterSpacing: "-0.02em", marginBottom: 4 }}>📋 Cuestionario inicial</div>
        <div style={{ fontSize: 13, color: t.textSub, marginBottom: 16 }}>Sección {step + 1} de {totalSteps} · {current.icon} {current.title}</div>
        <div style={{ height: 6, background: t.bgElevated, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(90deg, #f0a030, #c07818)", transition: "width 0.3s" }}/>
        </div>
      </div>

      {/* Questions */}
      <div style={{ flex: 1, padding: "20px 20px 16px", overflowY: "auto" }}>
        {showRestoreMsg && (
          <div style={{ background: "linear-gradient(135deg, rgba(30,155,191,0.12), rgba(30,155,191,0.04))", border: "1.5px solid rgba(30,155,191,0.3)", borderRadius: 12, padding: "12px 14px", marginBottom: 16, display: "flex", alignItems: "flex-start", gap: 10 }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>💾</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: t.text, marginBottom: 2 }}>Continuando donde lo dejaste</div>
              <div style={{ fontSize: 11, color: t.textSub, lineHeight: 1.4 }}>Tus respuestas anteriores están cargadas. Puedes revisarlas o modificarlas.</div>
            </div>
            <button onClick={() => setShowRestoreMsg(false)}
              style={{ background: "none", border: `1px solid ${t.border}`, borderRadius: 8, padding: "6px 10px", cursor: "pointer", color: t.textSub, fontSize: 10, fontWeight: 700, fontFamily: "inherit", whiteSpace: "nowrap" }}>
              OK
            </button>
          </div>
        )}
        {current.render()}
        {err && <div style={{ color: t.danger, fontSize: 13, fontWeight: 600, marginBottom: 14, background: t.dangerAlpha, padding: "10px 14px", borderRadius: 10, border: `1px solid rgba(230,80,80,0.3)` }}>⚠️ {err}</div>}
      </div>

      {/* Navigation */}
      <div style={{ display: "flex", gap: 10, padding: "12px 20px 24px", borderTop: `1px solid ${t.border}`, background: t.bg }}>
        {step > 0 && (
          <button onClick={prev} disabled={saving}
            style={{ background: t.bgElevated, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "13px 20px", cursor: "pointer", color: t.textSub, fontSize: 14, fontWeight: 700, fontFamily: "inherit" }}>
            ← Atrás
          </button>
        )}
        <button onClick={next} disabled={saving}
          style={{ flex: 1, background: "linear-gradient(135deg, #f0a030, #c07818)", border: "none", borderRadius: 12, padding: "13px 20px", cursor: saving ? "not-allowed" : "pointer", color: "white", fontSize: 14, fontWeight: 800, fontFamily: "inherit", opacity: saving ? 0.6 : 1, boxShadow: "0 4px 14px rgba(240,160,48,0.3)" }}>
          {saving ? "Guardando..." : step === totalSteps - 1 ? "✓ Finalizar cuestionario" : "Siguiente →"}
        </button>
      </div>
    </div>
  );
};


const ClientOnboarding = ({ client, db, setDb, onDone }) => {
  const [f, setF] = useState({ phone: client.phone||"", age: client.age||"", height: client.height||"", gender: client.gender||"", goal: client.goal||"", personalNotes: client.personalNotes||"", injuries: client.injuries||"Sin lesiones actuales." });
  const [newPass, setNewPass] = useState("");
  const [newPass2, setNewPass2] = useState("");
  const [saving, setSaving] = useState(false);
  const [passErr, setPassErr] = useState("");
  const fld = k => ({ value: f[k], onChange: v => setF(p=>({...p,[k]:v})) });

  const save = async () => {
    if (!f.gender) return alert("Por favor indica si eres hombre o mujer");
    if (!f.goal) return alert("Por favor indica tu objetivo");
    if (newPass && newPass !== newPass2) { setPassErr("Las contraseñas no coinciden"); return; }
    if (newPass && newPass.length < 6) { setPassErr("Mínimo 6 caracteres"); return; }
    setPassErr("");
    setSaving(true);
    const passwordChanged = !!newPass;
    const finalPassword = newPass || client.password;
    const updated = { ...client, ...f, age: +f.age||0, height: +f.height||0, password: finalPassword, passwordChanged };
    setDb(p => ({
      ...p,
      clients: p.clients.map(c => c.id === client.id ? updated : c),
      users: p.users.map(u => u.clientId === client.id ? { ...u, password: finalPassword } : u),
    }));
    await sb.upsert("clients", {
      id: client.id, user_id: client.userId, name: client.name, email: client.email,
      phone: f.phone || null, age: +f.age || null, height_cm: +f.height || null,
      gender: f.gender,
      goal: f.goal, personal_notes: f.personalNotes || null, injuries: f.injuries || null,
      status: "active", start_date: client.startDate, avatar: client.avatar,
      password: finalPassword,
      password_changed: passwordChanged,
    });
    setSaving(false);
    onDone();
  };

  return (
    <div style={{ minHeight: "100vh", background: t.bg, maxWidth: 430, margin: "0 auto", padding: "0 0 40px" }}>
      <div style={{ padding: "52px 20px 24px", background: `linear-gradient(180deg, rgba(30,155,191,0.1) 0%, transparent 100%)` }}>
        <div style={{ fontSize: 26, fontWeight: 900, color: t.text, letterSpacing: "-0.03em", marginBottom: 6 }}>
          ¡Bienvenido, {client.name.split(" ")[0]}! 👋
        </div>
        <div style={{ fontSize: 15, color: t.textSub, lineHeight: 1.6 }}>
          Completa tu perfil para que tu coach pueda personalizar tu entrenamiento.
        </div>
      </div>

      <div style={{ padding: "0 16px" }}>
        <Card accent style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 16 }}>TUS DATOS</div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ color: t.textSub, fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", marginBottom: 7 }}>GÉNERO *</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setF(p => ({ ...p, gender: "male" }))}
                style={{ flex: 1, background: f.gender === "male" ? t.accentAlpha : t.bgElevated, border: `1.5px solid ${f.gender === "male" ? "rgba(30,155,191,0.3)" : t.border}`, borderRadius: 10, padding: "14px 10px", cursor: "pointer", color: f.gender === "male" ? t.accent : t.textSub, fontSize: 14, fontWeight: 700, fontFamily: "inherit" }}>
                ♂ Hombre
              </button>
              <button type="button" onClick={() => setF(p => ({ ...p, gender: "female" }))}
                style={{ flex: 1, background: f.gender === "female" ? "rgba(224,90,138,0.15)" : t.bgElevated, border: `1.5px solid ${f.gender === "female" ? "rgba(224,90,138,0.4)" : t.border}`, borderRadius: 10, padding: "14px 10px", cursor: "pointer", color: f.gender === "female" ? "#e05a8a" : t.textSub, fontSize: 14, fontWeight: 700, fontFamily: "inherit" }}>
                ♀ Mujer
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
            <Field label="TELÉFONO" {...fld("phone")}/>
            <Field label="EDAD" {...fld("age")} type="number"/>
            <Field label="ALTURA (cm)" {...fld("height")} type="number"/>
          </div>
          <Field label="¿CUÁL ES TU OBJETIVO? *" {...fld("goal")} placeholder="ej: Perder grasa, ganar músculo..."/>
          <Field label="NOTAS PERSONALES" {...fld("personalNotes")} multiline rows={2} placeholder="Horarios, preferencias, alergias..."/>
          <Field label="LESIONES O LIMITACIONES" {...fld("injuries")} multiline rows={2} placeholder="Sin lesiones actuales."/>
        </Card>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 4 }}>ELIGE TU CONTRASEÑA</div>
          <div style={{ fontSize: 12, color: t.textSub, marginBottom: 14 }}>Opcional — si no eliges una se mantendrá la contraseña inicial.</div>
          <Field label="NUEVA CONTRASEÑA" value={newPass} onChange={setNewPass} type="password" placeholder="Mínimo 6 caracteres"/>
          <Field label="REPETIR CONTRASEÑA" value={newPass2} onChange={setNewPass2} type="password" placeholder="Repite la contraseña"/>
          {passErr && <div style={{ color: t.danger, fontSize: 13, marginBottom: 8 }}>{passErr}</div>}
        </Card>

        <Btn onClick={save} disabled={saving} full>
          {saving ? "Guardando..." : "Completar perfil →"}
        </Btn>
      </div>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════════════════════════

// ─── Week utilities ───────────────────────────────────────────────────────────
const getWeekNumber = (startDate) => {
  try {
    const start = new Date(startDate);
    if (isNaN(start.getTime())) return 1;
    const now = new Date();
    return Math.max(1, Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000)) + 1);
  } catch { return 1; }
};

const getWeekDateRange = (startDate, weekNum) => {
  try {
    const start = new Date(startDate);
    if (isNaN(start.getTime())) return "";
    const ws = new Date(start.getTime() + (weekNum - 1) * 7 * 24 * 60 * 60 * 1000);
    const we = new Date(ws.getTime() + 6 * 24 * 60 * 60 * 1000);
    const fmt = d => `${d.getDate()}/${d.getMonth() + 1}`;
    return `${fmt(ws)} – ${fmt(we)}`;
  } catch { return ""; }
};

const ciKey = (clientId, weekNum) => `checkin:${clientId}:${weekNum}`;

// ─── Calendar week utilities ──────────────────────────────────────────────────
// Get Monday of the week containing a given date
const getMonday = (date = new Date()) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday = 1
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

// Format date as "D Mes"
const fmtDay = d => {
  const months = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  return `${d.getDate()} ${months[d.getMonth()]}`;
};

// Get week key as "YYYY-WW" for unique identification
const getCalWeekKey = (date = new Date()) => {
  const mon = getMonday(date);
  const year = mon.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const weekNum = Math.ceil(((mon - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${year}-${String(weekNum).padStart(2, "0")}`;
};

// Get display range "Lun D Mes - Dom D Mes"
const getCalWeekRange = (date = new Date()) => {
  const mon = getMonday(date);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return `Lun ${fmtDay(mon)} – Dom ${fmtDay(sun)}`;
};

// ─── SliderField ──────────────────────────────────────────────────────────────
const SliderField = ({ label, value, onChange, min = 0, max = 100, step = 1, leftLabel, rightLabel, unit = "%" }) => (
  <div style={{ marginBottom: 22 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: t.text }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 900, color: t.accent, letterSpacing: "-0.03em" }}>{value}<span style={{ fontSize: 12, color: t.textSub, fontWeight: 500 }}>{unit}</span></span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(+e.target.value)}
      style={{ width: "100%", accentColor: t.accent, cursor: "pointer", height: 6 }}/>
    {(leftLabel || rightLabel) && (
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
        <span style={{ fontSize: 10, color: t.textDim }}>{leftLabel}</span>
        <span style={{ fontSize: 10, color: t.textDim }}>{rightLabel}</span>
      </div>
    )}
  </div>
);

// ─── BtnGroup (single or multi) ───────────────────────────────────────────────
const BtnGroup = ({ label, options, value, onChange, multi = false }) => (
  <div style={{ marginBottom: 22 }}>
    <div style={{ fontSize: 14, fontWeight: 700, color: t.text, marginBottom: 10 }}>{label}</div>
    <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
      {options.map(opt => {
        const on = multi ? (value || []).includes(opt) : value === opt;
        return (
          <button key={opt} onClick={() => {
            if (multi) {
              const cur = value || [];
              onChange(on ? cur.filter(x => x !== opt) : [...cur, opt]);
            } else { onChange(opt); }
          }}
            style={{ background: on ? t.accentAlpha : t.bgElevated, border: `1.5px solid ${on ? "rgba(30,155,191,0.4)" : t.border}`, borderRadius: 20, padding: "9px 15px", color: on ? t.accent : t.textSub, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s", letterSpacing: "0.01em" }}>
            {opt}
          </button>
        );
      })}
    </div>
  </div>
);

// ─── CheckInForm ──────────────────────────────────────────────────────────────
const CheckInForm = ({ client, weekNum, db, setDb, onSaved, existing }) => {
  const [form, setForm] = useState({
    weight: existing?.weight || "",
    photo: existing?.photo || null,
    dietCompliance: existing?.dietCompliance ?? 70,
    trainingCompliance: existing?.trainingCompliance ?? 70,
    cardioCompliance: existing?.cardioCompliance ?? 70,
    hunger: existing?.hunger || "",
    energy: existing?.energy ?? 5,
    sleep: existing?.sleep || "",
    trainingFeel: existing?.trainingFeel || "",
    discomfort: existing?.discomfort || "",
    externalFactors: existing?.externalFactors || [],
    comment: existing?.comment || "",
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [uploadProgress, setUploadProgress] = useState(""); // "" | "compressing" | "uploading" | "saving"
  const [photos, setPhotos] = useState({
    front: existing?.photoFront || null,
    side: existing?.photoSide || null,
    back: existing?.photoBack || null,
  });
  const [photoFiles, setPhotoFiles] = useState({ front: null, side: null, back: null });
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  // Compress image to max 800px, 75% JPEG quality
  const compressImage = (file) => new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 800;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => { URL.revokeObjectURL(url); resolve(blob); }, "image/jpeg", 0.75);
    };
    img.src = url;
  });

  const handlePhoto = (pose) => async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const compressed = await compressImage(file);
    const reader = new FileReader();
    reader.onload = ev => setPhotos(p => ({ ...p, [pose]: ev.target.result }));
    reader.readAsDataURL(compressed);
    setPhotoFiles(p => ({ ...p, [pose]: compressed }));
  };

  const uploadPhoto = async (blob, clientId, weekNum, pose) => {
    try {
      const path = `${clientId}/semana-${weekNum}-${pose}.jpg`;
      const res = await fetchWithTimeout(`${SB_URL}/storage/v1/object/checkin-photos/${path}`, {
        method: "POST",
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "image/jpeg", "x-upsert": "true" },
        body: blob,
      }, 60000);
      if (!res.ok) { console.error("Photo upload failed:", await res.text()); return null; }
      return `${SB_URL}/storage/v1/object/public/checkin-photos/${path}`;
    } catch (e) { console.error("Photo upload error:", e); return null; }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError("");
    setUploadProgress("");

    const checkin = { ...form, weekNum, savedAt: new Date().toISOString() };
    try {
      // Compress and upload photos
      const hasPhotos = photoFiles.front || photoFiles.side || photoFiles.back;
      if (hasPhotos) setUploadProgress("compressing");

      const [photoFrontUrl, photoSideUrl, photoBackUrl] = await Promise.all([
        photoFiles.front ? uploadPhoto(photoFiles.front, client.id, weekNum, "frente") : Promise.resolve(existing?.photoFront || null),
        photoFiles.side  ? uploadPhoto(photoFiles.side,  client.id, weekNum, "perfil") : Promise.resolve(existing?.photoSide  || null),
        photoFiles.back  ? uploadPhoto(photoFiles.back,  client.id, weekNum, "espalda") : Promise.resolve(existing?.photoBack || null),
      ]);

      if (hasPhotos) setUploadProgress("saving");

      const sbData = {
        client_id: client.id,
        week_number: weekNum,
        weight_kg: form.weight ? parseFloat(form.weight) : null,
        diet_compliance: form.dietCompliance || 0,
        training_compliance: form.trainingCompliance || 0,
        cardio_compliance: form.cardioCompliance || 0,
        hunger: form.hunger || null,
        energy: form.energy || 5,
        sleep_quality: form.sleep || null,
        training_feel: form.trainingFeel || null,
        discomfort: form.discomfort || null,
        photo_url: photoFrontUrl,
        photo_url_side: photoSideUrl,
        photo_url_back: photoBackUrl,
        comment: [
          form.comment || "",
          form.externalFactors?.length ? `[Factores: ${form.externalFactors.join(", ")}]` : ""
        ].filter(Boolean).join("\n") || null,
        saved_at: new Date().toISOString(),
      };

      let result = null;
      try {
        const upsertRes = await fetchWithTimeout(`${SB_URL}/rest/v1/checkins?on_conflict=client_id,week_number`, {
          method: "POST",
          headers: { ...SB_H, "Prefer": "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(sbData),
        }, 30000);
        const upsertBody = await upsertRes.text();
        if (upsertRes.ok) {
          result = JSON.parse(upsertBody);
        } else {
          setSaveError(`SB Error ${upsertRes.status}: ${upsertBody}`);
          setSaving(false);
          return;
        }
      } catch (fetchErr) {
        if (fetchErr.name === "AbortError" || fetchErr.message?.includes("abort")) {
          setSaveError("La conexión es lenta. Prueba con menos fotos o con mejor señal.");
        } else {
          setSaveError(`Error al guardar: ${fetchErr.message}`);
        }
        setSaving(false);
        return;
      }

      if (!result) {
        setSaveError("No se pudo guardar en la base de datos. Inténtalo de nuevo.");
        setSaving(false);
        return;
      }

      // Sync weight
      if (form.weight && !isNaN(parseFloat(form.weight))) {
        const w = parseFloat(form.weight);
        const today = new Date().toISOString().slice(0, 10);
        setDb(p => ({
          ...p,
          weightHistory: {
            ...p.weightHistory,
            [client.id]: [...(p.weightHistory[client.id] || []).filter(e => e.date !== today), { date: today, weight: w }]
              .sort((a, b) => a.date.localeCompare(b.date)),
          }
        }));
        await sb.insert("weight_entries", { client_id: client.id, date: today, weight_kg: w });
      }

      // Backup local (foto)
      if (window?.storage?.set) {
        try { await window.storage.set(ciKey(client.id, weekNum), JSON.stringify(checkin)); } catch {}
      }

      onSaved(checkin);
    } catch (err) {
      console.error("Error saving check-in:", err);
      setSaveError(`Error al guardar: ${err?.message || "inténtalo de nuevo"}`);
    }
    setSaving(false);
    setUploadProgress("");
  };

  return (
    <div style={{ paddingBottom: 8 }}>
      {/* 1. Peso */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.text, marginBottom: 10 }}>Peso esta semana</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input type="number" step="0.1" value={form.weight} onChange={e => set("weight", e.target.value)} placeholder="ej: 75.5"
            style={{ flex: 1, background: t.bgInput, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "14px 16px", color: t.text, fontSize: 20, fontWeight: 800, fontFamily: "inherit", outline: "none" }}
            onFocus={e => e.target.style.borderColor = t.accent}
            onBlur={e => e.target.style.borderColor = t.border}/>
          <span style={{ color: t.textSub, fontSize: 16, fontWeight: 600, flexShrink: 0 }}>kg</span>
        </div>
      </div>

      <Sep/>

      {/* 2. Fotos */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.text, marginBottom: 10 }}>Fotos de progreso</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {[["front","🧍 Frente"],["side","🔄 Perfil"],["back","⬅️ Espalda"]].map(([pose, label]) => (
            <label key={pose} style={{ cursor: "pointer", display: "block" }}>
              <div style={{ aspectRatio: "3/4", background: t.bgElevated, border: `1.5px dashed ${photos[pose] ? t.accent : t.borderMid}`, borderRadius: 12, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                {photos[pose]
                  ? <img src={photos[pose]} alt={pose} style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
                  : <div style={{ textAlign: "center", padding: 8 }}>
                      <div style={{ fontSize: 22, marginBottom: 4 }}>📷</div>
                      <div style={{ fontSize: 10, color: t.textSub, fontWeight: 600 }}>{label}</div>
                    </div>
                }
                {photos[pose] && (
                  <button onClick={e => { e.preventDefault(); setPhotos(p => ({...p,[pose]:null})); setPhotoFiles(p => ({...p,[pose]:null})); }}
                    style={{ position: "absolute", top: 4, right: 4, background: "rgba(0,0,0,0.7)", border: "none", borderRadius: "50%", width: 24, height: 24, cursor: "pointer", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Icon n="x" s={11}/>
                  </button>
                )}
              </div>
              <div style={{ fontSize: 10, color: t.textSub, textAlign: "center", marginTop: 4, fontWeight: 600 }}>{label}</div>
              <input type="file" accept="image/*" onChange={handlePhoto(pose)} style={{ display: "none" }}/>
            </label>
          ))}
        </div>
        <div style={{ fontSize: 11, color: t.textDim, marginTop: 8, textAlign: "center" }}>Opcional · Se comprimen automáticamente</div>
      </div>

      <Sep/>

      {/* 3-5. Cumplimiento sliders */}
      <SliderField label="Cumplimiento de la dieta" value={form.dietCompliance} onChange={v => set("dietCompliance", v)} leftLabel="0%" rightLabel="100%"/>
      <SliderField label="Cumplimiento de los entrenamientos" value={form.trainingCompliance} onChange={v => set("trainingCompliance", v)} leftLabel="0%" rightLabel="100%"/>
      <SliderField label="Cumplimiento del cardio / pasos" value={form.cardioCompliance} onChange={v => set("cardioCompliance", v)} leftLabel="0%" rightLabel="100%"/>

      <Sep/>

      {/* 7. Energía */}
      <SliderField label="Nivel de energía" value={form.energy} onChange={v => set("energy", v)} min={1} max={10} step={1} unit="/10" leftLabel="Sin energía" rightLabel="Lleno de energía"/>

      <Sep/>

      {/* 6. Hambre */}
      <BtnGroup label="Hambre durante la semana" options={["Muy poca","Poca","Normal","Alta","Muy alta"]} value={form.hunger} onChange={v => set("hunger", v)}/>
      {/* 8. Sueño */}
      <BtnGroup label="Calidad del sueño" options={["Malo","Regular","Bueno"]} value={form.sleep} onChange={v => set("sleep", v)}/>
      {/* 9. Sensaciones */}
      <BtnGroup label="Sensaciones en los entrenamientos" options={["Peor que la semana pasada","Igual","Mejor"]} value={form.trainingFeel} onChange={v => set("trainingFeel", v)}/>
      {/* 10. Molestias */}
      <BtnGroup label="Molestias físicas" options={["Sin molestias","Algunas molestias","Muchas molestias"]} value={form.discomfort} onChange={v => set("discomfort", v)}/>
      {/* 11. Factores externos */}
      <BtnGroup label="Factores externos" options={["Estrés","Menstruación","Ovulación","Retención de líquidos","Mal descanso","Viaje","Otros"]} value={form.externalFactors} onChange={v => set("externalFactors", v)} multi/>

      <Sep/>

      {/* 12. Comentario libre */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.text, marginBottom: 10 }}>¿Qué has hecho bien esta semana y qué mejorarías?</div>
        <textarea value={form.comment} onChange={e => set("comment", e.target.value)}
          placeholder="Escribe aquí tu reflexión semanal..." rows={4}
          style={{ width: "100%", background: t.bgInput, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "13px 16px", color: t.text, fontSize: 14, fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box", lineHeight: 1.6 }}
          onFocus={e => e.target.style.borderColor = t.accent}
          onBlur={e => e.target.style.borderColor = t.border}/>
      </div>

      {saveError && (
        <div style={{ background: t.dangerAlpha, border: `1px solid rgba(224,90,90,0.25)`, borderRadius: 10, padding: "11px 14px", marginBottom: 14, color: t.danger, fontSize: 13, fontWeight: 600 }}>
          ⚠️ {saveError}
        </div>
      )}

      {saving && uploadProgress && (
        <div style={{ background: t.accentAlpha, border: `1px solid rgba(30,155,191,0.25)`, borderRadius: 10, padding: "11px 14px", marginBottom: 14, color: t.accent, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⏳</span>
          {uploadProgress === "compressing" && "Comprimiendo fotos..."}
          {uploadProgress === "uploading" && "Subiendo fotos..."}
          {uploadProgress === "saving" && "Guardando datos..."}
        </div>
      )}

      <Btn onClick={handleSave} disabled={saving} full size="lg">
        {saving
          ? uploadProgress === "compressing" ? "Comprimiendo..." 
          : uploadProgress === "saving" ? "Guardando..."
          : "Subiendo fotos..."
          : <><Icon n="check" s={18}/> Guardar check-in</>}
      </Btn>
    </div>
  );
};

// ─── CheckInSummary (read-only) ───────────────────────────────────────────────
const CheckInSummary = ({ checkin, weekNum }) => {
  const cc = v => v >= 80 ? t.accent : v >= 50 ? t.warn : t.danger;
  return (
    <div>
      {/* Compliance grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
        {[["Dieta", checkin.dietCompliance], ["Entreno", checkin.trainingCompliance], ["Cardio", checkin.cardioCompliance]].map(([l, v]) => (
          <div key={l} style={{ background: t.bgElevated, borderRadius: 10, padding: "10px 8px", textAlign: "center" }}>
            <div style={{ fontSize: 17, fontWeight: 900, color: cc(v) }}>{v}%</div>
            <div style={{ fontSize: 10, color: t.textSub, marginTop: 2, fontWeight: 600 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Peso + Energía */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
        {checkin.weight && (
          <div style={{ background: t.bgElevated, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, marginBottom: 5, letterSpacing: "0.06em" }}>PESO</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: t.text }}>{checkin.weight} <span style={{ fontSize: 11, color: t.textDim, fontWeight: 400 }}>kg</span></div>
          </div>
        )}
        <div style={{ background: t.bgElevated, borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, marginBottom: 5, letterSpacing: "0.06em" }}>ENERGÍA</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: t.accent }}>{checkin.energy}<span style={{ fontSize: 11, color: t.textDim, fontWeight: 400 }}>/10</span></div>
        </div>
      </div>

      {/* Status pills */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {checkin.hunger && <Pill>{checkin.hunger}</Pill>}
        {checkin.sleep && <Pill color={checkin.sleep==="Bueno"?"accent":checkin.sleep==="Malo"?"danger":"default"}>{checkin.sleep}</Pill>}
        {checkin.trainingFeel && <Pill color={checkin.trainingFeel==="Mejor"?"accent":"default"}>{checkin.trainingFeel}</Pill>}
        {checkin.discomfort && <Pill color={checkin.discomfort==="Sin molestias"?"accent":checkin.discomfort==="Muchas molestias"?"danger":"warn"}>{checkin.discomfort}</Pill>}
      </div>

      {/* External factors */}
      {checkin.externalFactors?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, marginBottom: 6, letterSpacing: "0.06em" }}>FACTORES EXTERNOS</div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>{checkin.externalFactors.map(f => <Pill key={f}>{f}</Pill>)}</div>
        </div>
      )}

      {/* Comment */}
      {checkin.comment && (
        <div style={{ background: t.bgElevated, borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, marginBottom: 5, letterSpacing: "0.06em" }}>COMENTARIO</div>
          <div style={{ fontSize: 13, color: t.text, lineHeight: 1.6 }}>{checkin.comment}</div>
        </div>
      )}

      {/* Photos */}
      {(checkin.photoFront || checkin.photoSide || checkin.photoBack) && (
        <div>
          <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, marginBottom: 8, letterSpacing: "0.06em" }}>FOTOS DE PROGRESO</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            {[["photoFront","Frente"],["photoSide","Perfil"],["photoBack","Espalda"]].map(([key, label]) => (
              checkin[key] ? (
                <div key={key}>
                  <img src={checkin[key]} alt={label} style={{ width: "100%", aspectRatio: "3/4", objectFit: "cover", borderRadius: 10, border: `1px solid ${t.border}`, display: "block" }}/>
                  <div style={{ fontSize: 10, color: t.textSub, textAlign: "center", marginTop: 3, fontWeight: 600 }}>{label}</div>
                </div>
              ) : null
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── CTracking — client tracking tab ─────────────────────────────────────────
const CTracking = ({ client, db, setDb }) => {
  const thisWeekKey = getCalWeekKey(new Date());
  const lastWeekKey = getCalWeekKey(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

  const [checkins, setCheckins] = useState({});
  const [selectedWeek, setSelectedWeek] = useState(null); // null = not chosen yet
  const [openWeek, setOpenWeek] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editingWeek, setEditingWeek] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const loaded = {};
      try {
        const rows = await sb.select("checkins", `?client_id=eq.${client.id}&order=week_number`);
        rows.forEach(r => {
          loaded[r.week_number] = mapCheckinRow(r);
        });
      } catch {}
      if (!cancelled) { setCheckins(loaded); setLoading(false); }
    };
    load();
    return () => { cancelled = true; };
  }, [client.id]);

  const handleSaved = (weekKey, checkin) => {
    setCheckins(p => ({ ...p, [weekKey]: checkin }));
    setDb(p => ({
      ...p,
      checkins: {
        ...p.checkins,
        [client.id]: { ...(p.checkins?.[client.id] || {}), [weekKey]: checkin }
      }
    }));
    setSelectedWeek(null);
    setEditingWeek(null);
    setOpenWeek(weekKey);
  };

  if (loading) return (
    <div style={{ textAlign: "center", padding: "40px 0" }}>
      <div style={{ color: t.textSub, fontSize: 14, animation: "pulse 1.5s infinite" }}>Cargando seguimiento...</div>
    </div>
  );

  const thisWeekDone = !!checkins[thisWeekKey];
  const lastWeekDone = !!checkins[lastWeekKey];

  // All weeks with checkins + current/last
  const allKeys = [...new Set([
    ...Object.keys(checkins),
    thisWeekKey,
    lastWeekKey,
  ])].sort((a, b) => a.localeCompare(b));

  // Assign sequential week numbers based on order of first submission
  const doneKeys = allKeys.filter(k => !!checkins[k]).sort((a, b) => a.localeCompare(b));
  const weekNumMap = {}; // weekKey -> sequential number
  doneKeys.forEach((k, i) => { weekNumMap[k] = i + 1; });

  const visibleKeys = showAll ? [...allKeys].reverse() : [...allKeys].reverse().slice(0, 6);

  return (
    <div>
      {/* Week selector — show when no week selected and current week not done */}
      {!selectedWeek && !thisWeekDone && (
        <Card accent style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: t.text, marginBottom: 4 }}>¿De qué semana es este check-in?</div>
          <div style={{ fontSize: 12, color: t.textSub, marginBottom: 14 }}>Elige la semana que quieres registrar.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button onClick={() => { setSelectedWeek(thisWeekKey); setOpenWeek(thisWeekKey); }}
              style={{ background: t.accentAlpha, border: `1.5px solid rgba(30,155,191,0.3)`, borderRadius: 12, padding: "14px 16px", cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 20 }}>📅</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: t.accent }}>Esta semana</div>
                <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>{getCalWeekRange(new Date())}</div>
              </div>
            </button>
            {!lastWeekDone && (
              <button onClick={() => { setSelectedWeek(lastWeekKey); setOpenWeek(lastWeekKey); }}
                style={{ background: t.bgElevated, border: `1.5px solid ${t.border}`, borderRadius: 12, padding: "14px 16px", cursor: "pointer", fontFamily: "inherit", textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 20 }}>📆</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>Semana pasada</div>
                  <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>{getCalWeekRange(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))}</div>
                </div>
              </button>
            )}
          </div>
        </Card>
      )}

      {/* Current/selected week form */}
      {selectedWeek && !checkins[selectedWeek] && (
        <Card accent style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <button onClick={() => setSelectedWeek(null)}
              style={{ background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 8, padding: "6px 10px", cursor: "pointer", color: t.textSub, fontFamily: "inherit", fontSize: 12, fontWeight: 700 }}>
              ← Cambiar
            </button>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: t.text }}>Check-in</div>
              <div style={{ fontSize: 11, color: t.textSub }}>{getCalWeekRange(new Date())}</div>
            </div>
          </div>
          <CheckInForm client={client} weekNum={selectedWeek} db={db} setDb={setDb} onSaved={c => handleSaved(selectedWeek, c)}/>
        </Card>
      )}

      {/* List of all weeks */}
      <div style={{ fontSize: 11, color: t.textSub, fontWeight: 700, letterSpacing: "0.06em", marginBottom: 10, marginTop: 4 }}>
        HISTORIAL DE CHECK-INS
      </div>

      {visibleKeys.map(weekKey => {
        const isOpen = openWeek === weekKey;
        const done = !!checkins[weekKey];
        const isThisWeek = weekKey === thisWeekKey;
        const weekDate = (() => {
          try {
            const [year, week] = weekKey.split("-").map(Number);
            const jan1 = new Date(year, 0, 1);
            const d = new Date(jan1.getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000);
            return getMonday(d);
          } catch { return new Date(); }
        })();
        const range = getCalWeekRange(weekDate);
        const seqNum = weekNumMap[weekKey];
        const weekLabel = seqNum ? `Semana ${seqNum} · ${range}` : range;

        return (
          <div key={weekKey} style={{ borderRadius: 16, border: `1.5px solid ${isOpen ? "rgba(30,155,191,0.35)" : done ? "rgba(30,155,191,0.18)" : t.border}`, background: t.bgCard, marginBottom: 10, overflow: "hidden" }}>
            <button onClick={() => setOpenWeek(isOpen ? null : weekKey)}
              style={{ width: "100%", background: "none", border: "none", cursor: "pointer", padding: "16px 18px", display: "flex", alignItems: "center", gap: 14, fontFamily: "inherit", textAlign: "left" }}>
              <div style={{ width: 42, height: 42, borderRadius: 12, background: done ? "rgba(30,155,191,0.15)" : t.bgElevated, border: `1.5px solid ${done ? "rgba(30,155,191,0.35)" : t.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 18 }}>
                {done ? "✅" : isThisWeek ? "📝" : "⬜"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: t.text }}>{weekLabel}</span>
                  {isThisWeek && !done && <Pill color="accent">Esta semana</Pill>}
                  {done && <Pill color="accent">✓ Completada</Pill>}
                </div>
              </div>
              <Icon n="down" s={16} style={{ color: isOpen ? t.accent : t.textDim, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s", flexShrink: 0 }}/>
            </button>

            {isOpen && (
              <div style={{ padding: "0 18px 18px", animation: "fadeUp 0.2s ease" }}>
                <div style={{ height: 1, background: t.border, marginBottom: 16 }}/>
                {done && editingWeek !== weekKey
                  ? <>
                      <CheckInSummary checkin={checkins[weekKey]} weekNum={weekKey}/>
                      <div style={{ marginTop: 14 }}>
                        <Btn variant="ghost" size="sm" onClick={() => setEditingWeek(weekKey)}>
                          ✏️ Editar check-in
                        </Btn>
                      </div>
                    </>
                  : (isThisWeek || editingWeek === weekKey || selectedWeek === weekKey)
                    ? <CheckInForm client={client} weekNum={weekKey} db={db} setDb={setDb}
                        existing={checkins[weekKey]}
                        onSaved={c => handleSaved(weekKey, c)}/>
                    : <div style={{ textAlign: "center", padding: "20px 0", color: t.textSub, fontSize: 13 }}>No hay check-in para esta semana.</div>
                }
              </div>
            )}
          </div>
        );
      })}

      {allKeys.length > 6 && (
        <button onClick={() => setShowAll(s => !s)}
          style={{ background: "none", border: "none", cursor: "pointer", color: t.accent, fontSize: 13, fontWeight: 700, fontFamily: "inherit", width: "100%", textAlign: "center", padding: "8px 0" }}>
          {showAll ? "Ver menos" : `Ver todas (${allKeys.length})`}
        </button>
      )}
    </div>
  );
};

// ─── ATrackingTab — admin view of check-ins ───────────────────────────────────
const ATrackingTab = ({ client }) => {
  const { db, loadFromSupabase, syncing } = useApp();
  const clientCheckins = (db.checkins || {})[client.id] || {};
  const completed = Object.entries(clientCheckins).sort((a, b) => a[0].localeCompare(b[0]));
  // Assign sequential numbers by submission order
  const weekNumMap = {};
  completed.forEach(([k], i) => { weekNumMap[k] = i + 1; });
  const completedDesc = [...completed].reverse();
  const cc = v => v >= 80 ? t.accent : v >= 50 ? t.warn : t.danger;

  return (
    <div>
      {/* Header + refresh */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: t.textSub, fontWeight: 600 }}>
          {completed.length} check-in{completed.length !== 1 ? "s" : ""} completado{completed.length !== 1 ? "s" : ""}
        </div>
        <button onClick={loadFromSupabase} disabled={syncing}
          style={{ background: t.bgElevated, border: `1px solid ${t.border}`, borderRadius: 8, padding: "6px 12px", color: syncing ? t.accent : t.textSub, fontSize: 12, fontWeight: 700, cursor: syncing ? "default" : "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 5 }}>
          {syncing ? "↻ Cargando..." : "↻ Actualizar"}
        </button>
      </div>

      {completed.length === 0 && <Empty icon="lightning" text="El cliente aún no ha completado ningún check-in"/>}

      {completedDesc.map(([weekNum, ci]) => {
        const seqNum = weekNumMap[weekNum];
        const weekDate = (() => {
          try {
            const [year, week] = weekNum.split("-").map(Number);
            const jan1 = new Date(year, 0, 1);
            return getMonday(new Date(jan1.getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000));
          } catch { return new Date(); }
        })();
        const range = weekNum.includes("-") ? getCalWeekRange(weekDate) : `Semana ${weekNum}`;
        const title = seqNum ? `Semana ${seqNum}` : range;
        return (
        <Card key={weekNum} style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: t.text }}>{title}</div>
              <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>{range}</div>
            </div>
            {ci.weight && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 22, fontWeight: 900, color: t.text, letterSpacing: "-0.03em" }}>{ci.weight} <span style={{ fontSize: 12, color: t.textDim, fontWeight: 400 }}>kg</span></div>
              </div>
            )}
          </div>

          {(ci.photoFront || ci.photoSide || ci.photoBack || ci.photo) && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, marginBottom: 8, letterSpacing: "0.06em" }}>FOTOS DE PROGRESO</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                {[["photoFront","Frente"],["photoSide","Perfil"],["photoBack","Espalda"]].map(([key, label]) => {
                  const src = ci[key] || (key === "photoFront" ? ci.photo : null);
                  return src ? (
                    <div key={key}>
                      <img src={src} alt={label} style={{ width: "100%", aspectRatio: "3/4", objectFit: "cover", borderRadius: 10, border: `1px solid ${t.border}`, display: "block" }}/>
                      <div style={{ fontSize: 10, color: t.textSub, textAlign: "center", marginTop: 3, fontWeight: 600 }}>{label}</div>
                    </div>
                  ) : null;
                })}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, marginBottom: 12 }}>
            {[["Dieta", ci.dietCompliance], ["Entreno", ci.trainingCompliance], ["Cardio", ci.cardioCompliance]].map(([l, v]) => (
              <div key={l} style={{ background: t.bgElevated, borderRadius: 9, padding: "9px 6px", textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 900, color: cc(v) }}>{v}%</div>
                <div style={{ fontSize: 10, color: t.textSub, marginTop: 1 }}>{l}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: ci.comment ? 10 : 0 }}>
            {ci.energy != null && <Pill color="accent">⚡ Energía: {ci.energy}/10</Pill>}
            {ci.hunger && <Pill>🍽️ Hambre: {ci.hunger}</Pill>}
            {ci.sleep && <Pill color={ci.sleep==="Bueno"?"accent":ci.sleep==="Malo"?"danger":"default"}>😴 Sueño: {ci.sleep}</Pill>}
            {ci.trainingFeel && <Pill color={ci.trainingFeel==="Mejor"?"accent":"default"}>💪 Entreno: {ci.trainingFeel}</Pill>}
            {ci.discomfort && <Pill color={ci.discomfort==="Sin molestias"?"accent":ci.discomfort==="Muchas molestias"?"danger":"warn"}>🤕 Molestias: {ci.discomfort}</Pill>}
            {(ci.externalFactors || []).length > 0 && (
              <Pill>🌍 Factores: {(ci.externalFactors || []).join(", ")}</Pill>
            )}
          </div>

          {ci.comment && (
            <div style={{ background: t.bgElevated, borderRadius: 9, padding: "10px 12px", marginTop: 8 }}>
              <div style={{ fontSize: 10, color: t.textSub, fontWeight: 700, marginBottom: 4, letterSpacing: "0.06em" }}>COMENTARIO</div>
              <div style={{ fontSize: 13, color: t.text, lineHeight: 1.6 }}>{ci.comment}</div>
            </div>
          )}
        </Card>
        );
      })}
    </div>
  );
};

// ─── EMPTY ────────────────────────────────────────────────────────────────────
const Empty = ({ icon, text }) => (
  <div style={{ textAlign: "center", padding: "50px 20px" }}>
    <div style={{ color: t.textDim, display: "flex", justifyContent: "center", marginBottom: 14, opacity: 0.4 }}><Icon n={icon} s={36}/></div>
    <div style={{ color: t.textSub, fontSize: 15 }}>{text}</div>
  </div>
);

// ─── ERROR BOUNDARY ───────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) return (
      <div style={{ minHeight: "100vh", background: "#07090f", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: "#edf2f7", marginBottom: 8 }}>Algo salió mal</div>
        <div style={{ fontSize: 14, color: "#6b8ea8", marginBottom: 24, textAlign: "center" }}>La app encontró un error inesperado.</div>
        <button onClick={() => window.location.reload()}
          style={{ background: "linear-gradient(135deg, #1E9BBF, #14708a)", color: "white", border: "none", borderRadius: 12, padding: "13px 24px", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Recargar app
        </button>
      </div>
    );
    return this.props.children;
  }
}

// ─── LOADING SCREEN ───────────────────────────────────────────────────────────
const LoadingScreen = ({ retry, error }) => (
  <div style={{ minHeight: "100vh", background: "#07090f", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
    <div style={{ width: 72, height: 72, borderRadius: 20, background: "linear-gradient(135deg, #1E9BBF, #0d5f75)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 32px rgba(30,155,191,0.35)", marginBottom: 20 }}>
      <svg width="42" height="42" viewBox="0 0 42 42" fill="none">
        <polyline points="4,30 10,30 15,18 21,34 27,10 33,30 38,30" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
        <polyline points="21,10 21,4 17,8" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
    <div style={{ fontSize: 24, fontWeight: 900, color: "#1E9BBF", letterSpacing: "-0.02em", marginBottom: 8 }}>Glute Factoryy</div>
    {error ? (
      <>
        <div style={{ fontSize: 14, color: "#e05a5a", marginBottom: 20, textAlign: "center" }}>No se pudo conectar. Revisa tu conexión.</div>
        <button onClick={retry}
          style={{ background: "linear-gradient(135deg, #1E9BBF, #14708a)", color: "white", border: "none", borderRadius: 12, padding: "13px 24px", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Reintentar
        </button>
      </>
    ) : (
      <div style={{ fontSize: 14, color: "#6b8ea8", animation: "pulse 1.5s infinite" }}>Conectando...</div>
    )}
  </div>
);

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ROOT ─────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [db, setDb] = useState(INITIAL_DB);
  const [currentUser, setCurrentUser] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [appReady, setAppReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [customFoods, setCustomFoods] = useState([]);

  const loadCustomFoods = useCallback(async () => {
    try {
      const rows = await sb.select("custom_foods", "?order=name");
      if (rows) setCustomFoods(rows);
    } catch {}
  }, []);

  const loadFromSupabase = useCallback(async () => {
    setSyncing(true);
    setLoadError(false);
    try {
      const [clients, weights, notes, clientData, checkins] = await Promise.all([
        sb.select("clients", "?select=*&order=created_at"),
        sb.select("weight_entries", "?select=*&order=date"),
        sb.select("coach_notes", "?select=*&order=created_at.desc"),
        sb.select("client_data", "?select=*"),
        sb.select("checkins", "?select=*&order=week_number.desc"),
      ]);
      setDb(prev => mergeSupabaseIntoDb(prev, { clients, weights, notes, clientData, checkins }));
      await loadCustomFoods();
    } catch (e) {
      console.error("Supabase load error:", e);
      setLoadError(true);
    }
    setSyncing(false);
  }, [loadCustomFoods]);

  // Initial load on mount
  useEffect(() => {
    const init = async () => {
      try {
        await loadFromSupabase();
      } catch {}
      setAppReady(true);
    };
    init();
  }, []);

  const login = useCallback(async (email, password) => {
    // ── Brute force protection ──────────────────────────────────────────────
    try {
      const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const attempts = await sb.select("login_attempts",
        `?email=eq.${encodeURIComponent(email)}&success=eq.false&created_at=gte.${since}`);
      if (attempts?.length >= 5) {
        return "blocked";
      }
    } catch {}

    // 1. Check local users (already loaded from Supabase)
    const localUser = db.users.find(u => u.email === email && u.password === password);
    if (localUser) {
      await sb.insert("login_attempts", { email, success: true });
      setCurrentUser(localUser);
      await loadFromSupabase();
      return true;
    }
    // 2. Check admins table in Supabase
    try {
      const admins = await sb.select("admins", `?email=eq.${encodeURIComponent(email)}&password=eq.${encodeURIComponent(password)}`);
      if (admins?.length) {
        const a = admins[0];
        const adminUser = { id: a.id, email: a.email, password: a.password, role: a.role, name: a.name, passwordChanged: a.password_changed || false };
        setDb(p => ({ ...p, users: p.users.find(u => u.id === a.id) ? p.users : [...p.users, adminUser] }));
        await sb.insert("login_attempts", { email, success: true });
        setCurrentUser(adminUser);
        await loadFromSupabase();
        return true;
      }
    } catch {}
    // 3. Check clients table directly in Supabase (fallback if not yet loaded)
    try {
      const clients = await sb.select("clients", `?email=eq.${encodeURIComponent(email)}&password=eq.${encodeURIComponent(password)}`);
      if (clients?.length) {
        const c = clients[0];
        const clientUser = {
          id: c.user_id || c.id, email: c.email, password: c.password,
          role: "client", name: c.name, clientId: c.id,
        };
        setDb(p => ({ ...p, users: p.users.find(u => u.id === clientUser.id) ? p.users : [...p.users, clientUser] }));
        await sb.insert("login_attempts", { email, success: true });
        setCurrentUser(clientUser);
        await loadFromSupabase();
        return true;
      }
    } catch {}
    // Failed login — record attempt
    try { await sb.insert("login_attempts", { email, success: false }); } catch {}
    return false;
  }, [db, loadFromSupabase]);

  const logout = useCallback(() => setCurrentUser(null), []);

  // Show loading screen until app is ready
  if (!appReady) return <LoadingScreen error={loadError} retry={() => { setAppReady(false); loadFromSupabase().then(() => setAppReady(true)); }}/>;

  return (
    <ErrorBoundary>
      <Ctx.Provider value={{ currentUser, setCurrentUser, db, setDb, login, logout, syncing, loadFromSupabase, customFoods, loadCustomFoods }}>
        <GlobalStyles/>
        {!currentUser
          ? <Login/>
          : (currentUser.role === "superadmin" || currentUser.role === "admin")
            ? <AdminApp/>
            : <ClientApp/>
        }
      </Ctx.Provider>
    </ErrorBoundary>
  );
}
