import { useState, useMemo, useRef, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fetchGA4Analytics } from "../services/ga4.server";
import { useLoaderData, useNavigation, useSearchParams, Form } from "react-router";
import { TextField, Button } from "@shopify/polaris";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";

// ── SSR guard ──────────────────────────────────────────────────
function useMount() {
  const [ok, set] = useState(false);
  useEffect(() => set(true), []);
  return ok;
}
// ── Container width ────────────────────────────────────────────
function useWidth(fb = 600) {
  const ref = useRef(null);
  const [w, setW] = useState(fb);
  useEffect(() => {
    if (!ref.current) return;
    const go = () => { const n = ref.current?.offsetWidth; if (n > 0) setW(n); };
    go();
    const ro = new ResizeObserver(go);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
// ── Date helpers ───────────────────────────────────────────────
function ymd(d) { return d.toISOString().split("T")[0]; }
function shift(s, n) { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return ymd(d); }

// ──────────────────────────────────────────────────────────────
// LOADER
// ──────────────────────────────────────────────────────────────
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const config = await prisma.ga4Config.findUnique({ where: { shop: session.shop } });
  if (!config) return Response.json({ configured: false });

  try {
    const sp = new URL(request.url).searchParams;
    const preset = sp.get("preset") || "7days";
    const from = sp.get("from"), to = sp.get("to");
    let startDate, endDate, prevStart, prevEnd;

    if (from && to) {
      startDate = from; endDate = to;
      const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
      prevEnd = shift(from, -1); prevStart = shift(from, -days);
    } else if (preset === "today") { startDate = "today"; endDate = "today"; prevStart = "yesterday"; prevEnd = "yesterday"; }
    else if (preset === "yesterday") { startDate = "yesterday"; endDate = "yesterday"; const t = ymd(new Date()); prevStart = shift(t, -2); prevEnd = shift(t, -2); }
    else if (preset === "30days") { startDate = "30daysAgo"; endDate = "today"; prevStart = "60daysAgo"; prevEnd = "31daysAgo"; }
    else if (preset === "90days") { startDate = "90daysAgo"; endDate = "today"; prevStart = "180daysAgo"; prevEnd = "91daysAgo"; }
    else if (preset === "365days") { startDate = "365daysAgo"; endDate = "today"; const t = ymd(new Date()); prevStart = shift(t, -730); prevEnd = shift(t, -366); }
    else { startDate = "7daysAgo"; endDate = "today"; prevStart = "14daysAgo"; prevEnd = "8daysAgo"; }

    const data = await fetchGA4Analytics({
      propertyId: config.propertyId, serviceAccountJson: config.jsonKey,
      startDate, endDate, prevStartDate: prevStart, prevEndDate: prevEnd,
    });
    return Response.json({ configured: true, data, preset, from: from || "", to: to || "" });
  } catch (err) {
    console.error("GA4:", err);
    return Response.json({ configured: true, data: null, error: err.message });
  }
}

// ──────────────────────────────────────────────────────────────
// ACTION
// ──────────────────────────────────────────────────────────────
export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const fd = await request.formData();
  const pid = fd.get("propertyId"), f = fd.get("jsonFile");
  if (!pid || !f) return Response.json({ error: "Missing fields" }, { status: 400 });
  const jsonKey = await f.text();
  await prisma.ga4Config.upsert({
    where: { shop: session.shop },
    update: { propertyId: pid, jsonKey },
    create: { shop: session.shop, propertyId: pid, jsonKey },
  });
  return Response.json({ success: true });
}

// ──────────────────────────────────────────────────────────────
// METRICS PROCESSING (matches Flutter metric indices)
// [0]=activeUsers [1]=sessions [2]=newUsers [3]=screenPageViews
// [4]=bounceRate  [5]=eventCount [6]=purchaseRevenue [7]=totalPurchasers
// ──────────────────────────────────────────────────────────────
function n(v) { return parseInt(v, 10) || 0; }
function f2(v) { return parseFloat(v) || 0; }
function pct(cur, prev) { if (!prev) return cur > 0 ? 100 : 0; return parseFloat(((cur - prev) / prev * 100).toFixed(1)); }
function fmt(v) {
  if (v == null) return "–";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2) : v);
}
function fmtCurrency(v) {
  if (v == null || v === 0) return "$0.00";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(2);
}
function fmtPct(v) { return (v * 100).toFixed(1) + "%"; }

function processMetrics(data) {
  let au = 0, s = 0, nu = 0, pv = 0, br = 0, ev = 0, rev = 0, pur = 0;
  let pau = 0, ps = 0, pnu = 0, ppv = 0, pbr = 0, pev = 0, prev_ = 0, ppur = 0;
  let brCount = 0;
  const chart = [];

  data?.currentPeriod?.rows?.forEach(row => {
    const mv = row.metricValues;
    const [a, b, c, d, e, g, h, i] = [0, 1, 2, 3, 4, 5, 6, 7].map(k => k === 4 ? f2(mv[k].value) : n(mv[k].value));
    au += a; s += b; nu += c; pv += d; br += e; ev += g; rev += h; pur += i; brCount++;
    const raw = row.dimensionValues?.[0]?.value || "";
    chart.push({ date: raw ? `${raw.slice(4, 6)}/${raw.slice(6, 8)}` : "–", au: a, sessions: b, newUsers: c, pv: d, events: g, revenue: h, purchasers: i });
  });
  chart.sort((a, b) => a.date.localeCompare(b.date));

  data?.previousPeriod?.rows?.forEach(row => {
    const mv = row.metricValues;
    pau += n(mv[0].value); ps += n(mv[1].value); pnu += n(mv[2].value);
    ppv += n(mv[3].value); pbr += f2(mv[4].value); pev += n(mv[5].value);
    prev_ += f2(mv[6].value); ppur += n(mv[7].value);
  });

  const avgBR = brCount > 0 ? br / brCount : 0;
  const prevAvgBR = brCount > 0 ? pbr / brCount : 0;

  const channels = (data?.channels?.rows || []).map(r => ({
    name: r.dimensionValues[0].value, sessions: n(r.metricValues[0].value), users: n(r.metricValues[1].value),
  }));
  const topPages = (data?.topPages?.rows || []).map(r => ({
    path: r.dimensionValues[0].value, views: n(r.metricValues[0].value), sessions: n(r.metricValues[1].value),
  }));
  const devices = (data?.devices?.rows || []).map(r => ({
    device: r.dimensionValues[0].value, sessions: n(r.metricValues[0].value), users: n(r.metricValues[1].value),
  }));
  const products = (data?.products?.rows || []).map(r => ({
    name: r.dimensionValues[0].value || "Unknown Product",
    id: r.dimensionValues[1].value || "",
    category: r.dimensionValues[2].value || "Uncategorized",
    revenue: f2(r.metricValues[0].value),
    quantity: n(r.metricValues[1].value),
  }));
  const organic = (data?.organicTraffic?.rows || []).map(r => {
    let page = r.dimensionValues?.[1]?.value || "(not set)";
    if (page === "/" || page === "(not set)") page = "Homepage (Organic)";
    if (page.length > 48) page = page.slice(0, 48) + "…";
    return { page, sessions: n(r.metricValues[0].value) };
  });

  return {
    au, s, nu, pv, rev, ev, pur, avgBR, chart, channels, topPages, devices, products, organic,
    trends: {
      au: pct(au, pau), s: pct(s, ps), nu: pct(nu, pnu), pv: pct(pv, ppv),
      br: pct(avgBR, prevAvgBR), ev: pct(ev, pev), rev: pct(rev, prev_), pur: pct(pur, ppur),
    },
  };
}

// ──────────────────────────────────────────────────────────────
// UI ATOMS
// ──────────────────────────────────────────────────────────────
function Badge({ v }) {
  const num = parseFloat(v), pos = num >= 0, zero = num === 0;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 3, background: zero ? "#f3f4f6" : pos ? "#dcfce7" : "#fee2e2", color: zero ? "#6b7280" : pos ? "#16a34a" : "#dc2626", padding: "3px 9px", borderRadius: 100, fontSize: 11, fontWeight: 700 }}>{!zero && (pos ? "▲" : "▼")} {Math.abs(num)}%</span>;
}

function Stat({ label, value, subValue, trend, icon, bg }) {
  return (
    <div style={{ background: bg, borderRadius: 14, padding: 20, position: "relative", overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.14)" }}>
      <div style={{ position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(255,255,255,0.22)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{icon}</div>
          <Badge v={trend} />
        </div>
        <div style={{ fontSize: 26, fontWeight: 800, color: "#fff", marginBottom: 2, lineHeight: 1 }}>{value}</div>
        {subValue && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.65)", marginBottom: 2 }}>{subValue}</div>}
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", fontWeight: 500 }}>{label}</div>
      </div>
      <div style={{ position: "absolute", right: -16, bottom: -16, width: 72, height: 72, borderRadius: "50%", background: "rgba(255,255,255,0.08)" }} />
    </div>
  );
}

const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px", boxShadow: "0 4px 16px rgba(0,0,0,0.1)", fontSize: 13 }}>
      <b style={{ display: "block", marginBottom: 6, color: "#111827" }}>{label}</b>
      {payload.map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, display: "inline-block" }} />
          <span style={{ color: "#6b7280" }}>{p.name}:</span>
          <b style={{ color: "#111827" }}>{p.name === "Revenue" ? "$" + f2(p.value).toFixed(2) : fmt(p.value)}</b>
        </div>
      ))}
    </div>
  );
};

function Card({ title, subtitle, children, style = {} }) {
  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: "20px 24px", border: "1px solid #e5e7eb", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", ...style }}>
      {title && <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{subtitle}</div>}
      </div>}
      {children}
    </div>
  );
}

function Chart({ h = 220, children }) {
  const mounted = useMount();
  const [ref, w] = useWidth(700);
  return (
    <div ref={ref} style={{ width: "100%", minHeight: h }}>
      {!mounted ? <div style={{ height: h, background: "#f9fafb", borderRadius: 8 }} /> : typeof children === "function" ? children(w, h) : children}
    </div>
  );
}

function BarRow({ label, value, max, color = "#4285f4", format = "number" }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 13 }}>
        <span style={{ fontWeight: 500, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "72%" }}>{label}</span>
        <span style={{ fontWeight: 700, color: "#111827", flexShrink: 0, marginLeft: 8 }}>
          {format === "currency" ? fmtCurrency(value) : fmt(value)}
        </span>
      </div>
      <div style={{ height: 4, background: "#f3f4f6", borderRadius: 2 }}>
        <div style={{ height: "100%", width: `${Math.min(100, Math.round(value / Math.max(1, max) * 100))}%`, background: color, borderRadius: 2, transition: "width .4s" }} />
      </div>
    </div>
  );
}

function Skeleton() {
  const b = { background: "#e5e7eb", borderRadius: 6, animation: "sk 1.4s ease infinite" };
  return (
    <>
      <style>{`@keyframes sk{0%,100%{opacity:.35}50%{opacity:.9}}`}</style>
      <div className="g4" style={{ marginBottom: 16 }}>
        {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
          <div key={i} style={{ background: "linear-gradient(135deg,#cbd5e1,#94a3b8)", borderRadius: 14, padding: 20, animation: "sk 1.4s ease infinite" }}>
            <div style={{ ...b, height: 36, width: 36, borderRadius: 10, background: "rgba(255,255,255,0.25)", marginBottom: 12 }} />
            <div style={{ ...b, height: 24, width: "55%", background: "rgba(255,255,255,0.25)", marginBottom: 6 }} />
            <div style={{ ...b, height: 12, width: "70%", background: "rgba(255,255,255,0.18)" }} />
          </div>
        ))}
      </div>
      <div style={{ background: "#fff", borderRadius: 14, padding: "20px 24px", border: "1px solid #e5e7eb", marginBottom: 16 }}>
        <div style={{ ...b, height: 16, width: 160, marginBottom: 12 }} /><div style={{ ...b, height: 230 }} />
      </div>
    </>
  );
}

// ── FILTER BAR ─────────────────────────────────────────────────
const PRESETS = [
  { label: "Today", v: "today" },
  { label: "Yesterday", v: "yesterday" },
  { label: "7 Days", v: "7days" },
  { label: "30 Days", v: "30days" },
  { label: "90 Days", v: "90days" },
  { label: "1 Year", v: "365days" },
];

function FilterBar({ preset, from, to, disabled }) {
  const [searchParams] = useSearchParams();
  const today = ymd(new Date()), defFrom = shift(today, -6);
  const [fr, setFr] = useState(from || defFrom), [toDt, setTo] = useState(to || today);

  function href(extra) {
    const p = new URLSearchParams(searchParams);
    Object.entries(extra).forEach(([k, v]) => v ? p.set(k, v) : p.delete(k));
    return "?" + p.toString();
  }
  function presetHref(v) { return href({ preset: v, from: "", to: "" }); }
  function customHref() { return href({ from: fr, to: toDt, preset: "" }); }

  const pill = (active) => ({
    display: "inline-block", padding: "7px 14px", borderRadius: 100, fontSize: 13, fontWeight: 600,
    textDecoration: "none", border: "1.5px solid", transition: "all .15s",
    borderColor: active ? "#4285f4" : "rgba(255,255,255,0.25)",
    background: active ? "#4285f4" : "rgba(255,255,255,0.1)",
    color: "#fff", boxShadow: active ? "0 4px 12px rgba(66,133,244,0.4)" : "none",
    pointerEvents: disabled ? "none" : "auto", opacity: disabled ? 0.5 : 1,
  });
  const dateInput = { border: "1.5px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.11)", color: "#fff", fontSize: 13, padding: "6px 10px", borderRadius: 8, fontFamily: "inherit", outline: "none", cursor: "pointer", colorScheme: "dark" };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      {PRESETS.map(p => <a key={p.v} href={presetHref(p.v)} style={pill(preset === p.v)}>{p.label}</a>)}
      <div style={{ width: 1, height: 28, background: "rgba(255,255,255,0.2)" }} />
      <input type="date" value={fr} max={toDt || today} onChange={e => setFr(e.target.value)} style={dateInput} />
      <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>to</span>
      <input type="date" value={toDt} min={fr} max={today} onChange={e => setTo(e.target.value)} style={dateInput} />
      <a href={customHref()} style={{ ...pill(false), background: "#fff", color: "#4285f4", borderColor: "transparent", boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}>Apply</a>
    </div>
  );
}

// ── SETUP PAGE ─────────────────────────────────────────────────
function SetupPage() {
  const [pid, setPid] = useState(""), nav = useNavigation();
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#eff6ff,#f0fdf4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 480, background: "#fff", borderRadius: 20, padding: 40, boxShadow: "0 8px 40px rgba(66,133,244,.12)", border: "1px solid #e5e7eb" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: "linear-gradient(135deg,#4285f4,#34a853)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#111827" }}>Connect Google Analytics</h1>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: "#6b7280" }}>Link your GA4 property to see live analytics</p>
        </div>
        <Form method="post" encType="multipart/form-data">
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 }}>GA4 Property ID</label>
            <TextField name="propertyId" value={pid} onChange={setPid} placeholder="e.g. 123456789" autoComplete="off" />
          </div>
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 }}>Service Account JSON File</label>
            <input type="file" name="jsonFile" accept=".json" required style={{ width: "100%", boxSizing: "border-box", padding: 10, border: "1px solid #d1d5db", borderRadius: 8, fontSize: 13, color: "#374151", background: "#f9fafb" }} />
          </div>
          <Button submit variant="primary" loading={nav.state === "submitting"} fullWidth>Save and Connect GA4</Button>
        </Form>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// MAIN DASHBOARD
// ──────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { configured, data, error, preset, from, to } = useLoaderData() || {};
  const nav = useNavigation(), loading = nav.state !== "idle";
  const m = useMemo(() => processMetrics(data), [data]);
  if (!configured) return <SetupPage />;

  const maxCh = Math.max(1, ...m.channels.map(c => c.sessions));
  const maxPg = Math.max(1, ...m.topPages.map(p => p.views));
  const maxDev = Math.max(1, ...m.devices.map(d => d.sessions));
  const maxProd = Math.max(1, ...m.products.map(p => p.quantity));

  return (
    <div style={{ fontFamily: "'Inter',system-ui,sans-serif", background: "#f8fafc", minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;}
        .g4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}
        .g2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
        .g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;}
        @media(max-width:1100px){.g4{grid-template-columns:repeat(4,1fr);}}
        @media(max-width:860px) {.g4{grid-template-columns:repeat(2,1fr);}.g3{grid-template-columns:1fr 1fr;}}
        @media(max-width:580px) {.g4{grid-template-columns:1fr 1fr;}.g2,.g3{grid-template-columns:1fr;}}
        @media(max-width:400px) {.g4{grid-template-columns:1fr;}}
        input[type=date]::-webkit-calendar-picker-indicator{filter:invert(1);opacity:.7;cursor:pointer;}
        a{transition:opacity .15s;}a:hover{opacity:.85;}
      `}</style>

      {/* HEADER */}
      <div style={{ background: "linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#0f4c75 100%)", padding: "24px 24px 76px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -80, right: -60, width: 240, height: 240, borderRadius: "50%", background: "rgba(66,133,244,0.12)" }} />
        <div style={{ position: "absolute", bottom: -40, left: "38%", width: 160, height: 160, borderRadius: "50%", background: "rgba(52,168,83,0.09)" }} />
        <div style={{ maxWidth: 1300, margin: "0 auto", position: "relative", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(66,133,244,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#fff" }}>Analytics Overview</h1>
              <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>Google Analytics 4 · Live Data</p>
            </div>
          </div>
          <FilterBar preset={preset || "7days"} from={from} to={to} disabled={loading} />
        </div>
      </div>

      {/* CONTENT */}
      <div style={{ maxWidth: 1300, margin: "-60px auto 0", padding: "0 20px 48px", position: "relative", zIndex: 2 }}>

        {error ? (
          <Card style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" style={{ flexShrink: 0, marginTop: 2 }}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
              <div><b style={{ color: "#dc2626", display: "block", marginBottom: 4 }}>Failed to load analytics</b><span style={{ fontSize: 13, color: "#ef4444" }}>{error}</span></div>
            </div>
          </Card>
        ) : loading ? <Skeleton /> : data ? (
          <>
            {/* 8 STAT CARDS — same metrics as Flutter */}
            <div className="g4" style={{ marginBottom: 14 }}>
              <Stat label="Active Users" value={fmt(m.au)} trend={m.trends.au} icon="👥" bg="linear-gradient(135deg,#4285f4,#1a73e8)" />
              <Stat label="Sessions" value={fmt(m.s)} trend={m.trends.s} icon="🔗" bg="linear-gradient(135deg,#34a853,#1e8e3e)" />
              <Stat label="New Users" value={fmt(m.nu)} trend={m.trends.nu} icon="✨" bg="linear-gradient(135deg,#00bcd4,#0097a7)" />
              <Stat label="Page Views" value={fmt(m.pv)} trend={m.trends.pv} icon="👁" bg="linear-gradient(135deg,#a142f4,#7627bb)" />
              <Stat label="Bounce Rate" value={fmtPct(m.avgBR)} trend={m.trends.br} icon="↩" bg="linear-gradient(135deg,#ea4335,#c5221f)" />
              <Stat label="Event Count" value={fmt(m.ev)} trend={m.trends.ev} icon="⚡" bg="linear-gradient(135deg,#fbbc04,#f4a300)" />
              <Stat label="Revenue" value={fmtCurrency(m.rev)} trend={m.trends.rev} icon="💰" bg="linear-gradient(135deg,#34a853,#1e8e3e)"
                subValue={m.pur > 0 ? `${fmt(m.pur)} purchasers` : null} />
              <Stat label="Total Purchasers" value={fmt(m.pur)} trend={m.trends.pur} icon="🛒" bg="linear-gradient(135deg,#fa7b17,#e37400)" />
            </div>

            {/* TRAFFIC CHART */}
            <Card title="Traffic Overview" subtitle="Active users & sessions over time" style={{ marginBottom: 14 }}>
              <Chart h={230}>
                {(w, h) => m.chart.length > 0 ? (
                  <LineChart width={w} height={h} data={m.chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#9ca3af" }} padding={{ left: 10, right: 10 }} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#9ca3af" }} width={44} tickFormatter={fmt} />
                    <Tooltip content={<Tip />} />
                    <Line type="monotone" dataKey="au" name="Active Users" stroke="#4285f4" strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 0 }} />
                    <Line type="monotone" dataKey="sessions" name="Sessions" stroke="#34a853" strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 0 }} />
                    <Line type="monotone" dataKey="newUsers" name="New Users" stroke="#00bcd4" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                  </LineChart>
                ) : <div style={{ height: h, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>No chart data</div>}
              </Chart>
            </Card>

            {/* REVENUE + EVENTS CHART */}
            <div className="g2" style={{ marginBottom: 14 }}>
              <Card title="Revenue" subtitle="Daily purchase revenue">
                <Chart h={180}>
                  {(w, h) => m.chart.length > 0 ? (
                    <BarChart width={w} height={h} data={m.chart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#9ca3af" }} />
                      <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#9ca3af" }} width={46} tickFormatter={v => "$" + fmt(v)} />
                      <Tooltip content={<Tip />} />
                      <Bar dataKey="revenue" name="Revenue" fill="#34a853" radius={[4, 4, 0, 0]} maxBarSize={28} />
                    </BarChart>
                  ) : <div style={{ height: h, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>No data</div>}
                </Chart>
              </Card>

              <Card title="Events & Purchasers" subtitle="Daily event count & purchasers">
                <Chart h={180}>
                  {(w, h) => m.chart.length > 0 ? (
                    <LineChart width={w} height={h} data={m.chart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#9ca3af" }} />
                      <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#9ca3af" }} width={34} tickFormatter={fmt} />
                      <Tooltip content={<Tip />} />
                      <Line type="monotone" dataKey="events" name="Events" stroke="#fbbc04" strokeWidth={2.5} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                      <Line type="monotone" dataKey="purchasers" name="Purchasers" stroke="#fa7b17" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                    </LineChart>
                  ) : <div style={{ height: h, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>No data</div>}
                </Chart>
              </Card>
            </div>

            {/* CHANNELS + DEVICES + TOP PAGES */}
            <div className="g3" style={{ marginBottom: 14 }}>
              <Card title="Traffic Channels" subtitle="Sessions by source">
                {m.channels.length > 0 ? m.channels.map((c, i) => (
                  <BarRow key={i} label={c.name} value={c.sessions} max={maxCh} color="linear-gradient(90deg,#4285f4,#34a853)" />
                )) : <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>No channel data</p>}
              </Card>
              <Card title="Devices" subtitle="Sessions by device type">
                {m.devices.length > 0 ? m.devices.map((d, i) => {
                  const cols = ["#4285f4", "#34a853", "#fa7b17", "#a142f4", "#ea4335"];
                  return <BarRow key={i} label={d.device} value={d.sessions} max={maxDev} color={cols[i % cols.length]} />;
                }) : <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>No device data</p>}
              </Card>
              <Card title="Top Pages" subtitle="Most viewed pages">
                {m.topPages.length > 0 ? m.topPages.slice(0, 7).map((p, i) => (
                  <BarRow key={i} label={p.path} value={p.views} max={maxPg} color="linear-gradient(90deg,#a142f4,#4285f4)" />
                )) : <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>No page data</p>}
              </Card>
            </div>

            {/* PRODUCT PURCHASE TABLE */}
            {m.products.length > 0 && (
              <Card title="Product Sales" subtitle="Top products by quantity sold" style={{ marginBottom: 14 }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, minWidth: 500 }}>
                    <thead>
                      <tr style={{ background: "#f9fafb" }}>
                        {["#", "Product", "Category", "Qty Sold", "Revenue"].map((h, i) => (
                          <th key={i} style={{ padding: "10px 14px", textAlign: i >= 3 ? "right" : "left", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: ".05em", width: i === 0 ? 28 : "auto" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {m.products.map((p, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #f3f4f6" }}>
                          <td style={{ padding: "12px 14px", fontSize: 12, fontWeight: 700, color: "#9ca3af" }}>{i + 1}</td>
                          <td style={{ padding: "12px 14px" }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{p.name || "–"}</div>
                            {p.id && <div style={{ fontSize: 11, color: "#9ca3af" }}>ID: {p.id}</div>}
                            <div style={{ height: 3, background: "#f3f4f6", borderRadius: 2, marginTop: 5 }}>
                              <div style={{ height: "100%", width: `${Math.round(p.quantity / maxProd * 100)}%`, background: "linear-gradient(90deg,#4285f4,#34a853)", borderRadius: 2 }} />
                            </div>
                          </td>
                          <td style={{ padding: "12px 14px", fontSize: 12, color: "#6b7280" }}>{p.category}</td>
                          <td style={{ padding: "12px 14px", fontSize: 14, fontWeight: 700, color: "#111827", textAlign: "right" }}>{fmt(p.quantity)}</td>
                          <td style={{ padding: "12px 14px", fontSize: 14, fontWeight: 700, color: "#34a853", textAlign: "right" }}>{fmtCurrency(p.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* ORGANIC TABLE */}
            {m.organic.length > 0 && (
              <Card title="Organic Traffic Sources" subtitle="Landing pages from organic search">
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, minWidth: 340 }}>
                    <thead>
                      <tr style={{ background: "#f9fafb" }}>
                        {["#", "Landing Page", "Sessions"].map((h, i) => (
                          <th key={i} style={{ padding: "10px 14px", textAlign: i === 2 ? "right" : "left", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: ".05em", width: i === 0 ? 28 : "auto" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {m.organic.map((r, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #f3f4f6" }}>
                          <td style={{ padding: "12px 14px", fontSize: 12, fontWeight: 700, color: "#9ca3af" }}>{i + 1}</td>
                          <td style={{ padding: "12px 14px" }}>
                            <div style={{ fontSize: 13, fontWeight: 500, color: "#111827", marginBottom: 4 }}>{r.page}</div>
                            <div style={{ height: 3, background: "#f3f4f6", borderRadius: 2 }}>
                              <div style={{ height: "100%", width: `${Math.round(r.sessions / Math.max(1, m.organic[0]?.sessions) * 100)}%`, background: "linear-gradient(90deg,#4285f4,#34a853)", borderRadius: 2 }} />
                            </div>
                          </td>
                          <td style={{ padding: "12px 14px", fontSize: 14, fontWeight: 700, color: "#111827", textAlign: "right" }}>{fmt(r.sessions)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </>
        ) : (
          <Card style={{ padding: 48, textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "#9ca3af" }}>No data available for this period</div>
          </Card>
        )}

        <div style={{ textAlign: "center", marginTop: 40, fontSize: 12, color: "#9ca3af" }}>Google Analytics 4 · Data refreshes on page load</div>
      </div>
    </div>
  );
}
