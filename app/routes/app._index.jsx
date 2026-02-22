import { useState, useMemo, useRef, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fetchGA4Analytics } from "../services/ga4.server";
import { useLoaderData, useNavigation, useSearchParams, Form } from "react-router";
import { TextField, Button } from "@shopify/polaris";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";

// ──────────────────────────────────────────────
// CLIENT-ONLY GUARD (prevents recharts SSR crash)
// ──────────────────────────────────────────────
function useMount() {
  const [ok, set] = useState(false);
  useEffect(() => set(true), []);
  return ok;
}

// ──────────────────────────────────────────────
// CHART CONTAINER WIDTH
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// DATE HELPERS
// ──────────────────────────────────────────────
function ymd(d) { return d.toISOString().split("T")[0]; }
function shift(s, n) {
  const d = new Date(s + "T00:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d);
}

// ──────────────────────────────────────────────
// LOADER
// ──────────────────────────────────────────────
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const config = await prisma.ga4Config.findUnique({ where: { shop: session.shop } });
  if (!config) return Response.json({ configured: false });

  try {
    const sp = new URL(request.url).searchParams;
    const preset = sp.get("preset") || "7days";
    const from = sp.get("from");
    const to = sp.get("to");

    let startDate, endDate, prevStart, prevEnd;

    if (from && to) {
      startDate = from; endDate = to;
      const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
      prevEnd = shift(from, -1);
      prevStart = shift(from, -days);
    } else if (preset === "today") {
      startDate = "today"; endDate = "today";
      prevStart = "yesterday"; prevEnd = "yesterday";
    } else if (preset === "yesterday") {
      startDate = "yesterday"; endDate = "yesterday";
      prevStart = shift(ymd(new Date()), -2); prevEnd = shift(ymd(new Date()), -2);
    } else if (preset === "30days") {
      startDate = "30daysAgo"; endDate = "today";
      prevStart = "60daysAgo"; prevEnd = "31daysAgo";
    } else if (preset === "90days") {
      startDate = "90daysAgo"; endDate = "today";
      prevStart = "180daysAgo"; prevEnd = "91daysAgo";
    } else if (preset === "365days") {
      startDate = "365daysAgo"; endDate = "today";
      prevStart = shift(ymd(new Date()), -730); prevEnd = shift(ymd(new Date()), -366);
    } else {
      // 7days (default)
      startDate = "7daysAgo"; endDate = "today";
      prevStart = "14daysAgo"; prevEnd = "8daysAgo";
    }

    const data = await fetchGA4Analytics({
      propertyId: config.propertyId,
      serviceAccountJson: config.jsonKey,
      startDate, endDate,
      prevStartDate: prevStart, prevEndDate: prevEnd,
    });

    return Response.json({
      configured: true, data,
      preset, from: from || "", to: to || "",
    });
  } catch (err) {
    console.error("GA4 error:", err);
    return Response.json({ configured: true, data: null, error: err.message });
  }
}

// ──────────────────────────────────────────────
// ACTION
// ──────────────────────────────────────────────
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

// ──────────────────────────────────────────────
// METRICS PROCESSING
// ──────────────────────────────────────────────
function num(v) { return parseInt(v, 10) || 0; }
function pct(cur, prev) {
  if (!prev) return cur > 0 ? 100 : 0;
  return parseFloat(((cur - prev) / prev * 100).toFixed(1));
}
function fmt(n) {
  if (n == null) return "–";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function processMetrics(data) {
  // GA4 metrics: [0]=screenPageViews [1]=sessions [2]=totalUsers [3]=conversions
  let pv = 0, s = 0, u = 0, cv = 0, ppv = 0, ps = 0, pu = 0, pcv = 0;
  const chart = [];

  data?.currentPeriod?.rows?.forEach(row => {
    const [a, b, c, d] = row.metricValues.map(v => num(v.value));
    pv += a; s += b; u += c; cv += d;
    const raw = row.dimensionValues?.[0]?.value || "";
    chart.push({ date: raw ? `${raw.slice(4, 6)}/${raw.slice(6, 8)}` : "–", pv: a, sessions: b, users: c, conversions: d });
  });
  chart.sort((a, b) => a.date.localeCompare(b.date));

  data?.previousPeriod?.rows?.forEach(row => {
    const [a, b, c, d] = row.metricValues.map(v => num(v.value));
    ppv += a; ps += b; pu += c; pcv += d;
  });

  // Channels
  const channels = (data?.channels?.rows || []).map(r => ({
    name: r.dimensionValues[0].value,
    sessions: num(r.metricValues[0].value),
    users: num(r.metricValues[1].value),
  }));

  // Top pages
  const topPages = (data?.topPages?.rows || []).map(r => ({
    path: r.dimensionValues[0].value,
    views: num(r.metricValues[0].value),
    sessions: num(r.metricValues[1].value),
  }));

  // Devices
  const devices = (data?.devices?.rows || []).map(r => ({
    device: r.dimensionValues[0].value,
    sessions: num(r.metricValues[0].value),
    users: num(r.metricValues[1].value),
  }));

  // Organic pages
  const organic = (data?.organicTraffic?.rows || []).map(r => {
    let page = r.dimensionValues?.[1]?.value || "(not set)";
    if (page === "/" || page === "(not set)") page = "Homepage (Organic)";
    if (page.length > 48) page = page.slice(0, 48) + "…";
    return { page, sessions: num(r.metricValues[0].value) };
  });

  return {
    pv, s, u, cv, chart, channels, topPages, devices, organic,
    trends: { pv: pct(pv, ppv), s: pct(s, ps), u: pct(u, pu), cv: pct(cv, pcv) },
  };
}

// ──────────────────────────────────────────────
// REUSABLE BADGE
// ──────────────────────────────────────────────
function Badge({ v }) {
  const n = parseFloat(v), pos = n >= 0, zero = n === 0;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      background: zero ? "#f3f4f6" : pos ? "#dcfce7" : "#fee2e2",
      color: zero ? "#6b7280" : pos ? "#16a34a" : "#dc2626",
      padding: "3px 9px", borderRadius: 100, fontSize: 11, fontWeight: 700
    }}>
      {!zero && (pos ? "▲" : "▼")} {Math.abs(n)}%
    </span>
  );
}

// ──────────────────────────────────────────────
// STAT CARD
// ──────────────────────────────────────────────
function Stat({ label, value, trend, icon, bg }) {
  return (
    <div style={{ background: bg, borderRadius: 14, padding: 20, position: "relative", overflow: "hidden", boxShadow: "0 4px 20px rgba(0,0,0,0.14)" }}>
      <div style={{ position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(255,255,255,0.22)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{icon}</div>
          <Badge v={trend} />
        </div>
        <div style={{ fontSize: 30, fontWeight: 800, color: "#fff", marginBottom: 4, lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", fontWeight: 500 }}>{label}</div>
      </div>
      <div style={{ position: "absolute", right: -18, bottom: -18, width: 80, height: 80, borderRadius: "50%", background: "rgba(255,255,255,0.08)" }} />
    </div>
  );
}

// ──────────────────────────────────────────────
// CHART TOOLTIP
// ──────────────────────────────────────────────
const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px", boxShadow: "0 4px 16px rgba(0,0,0,0.1)", fontSize: 13 }}>
      <b style={{ color: "#111827", display: "block", marginBottom: 6 }}>{label}</b>
      {payload.map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, display: "inline-block" }} />
          <span style={{ color: "#6b7280" }}>{p.name}:</span>
          <b style={{ color: "#111827" }}>{fmt(p.value)}</b>
        </div>
      ))}
    </div>
  );
};

// ──────────────────────────────────────────────
// CHART WRAPPER — client-only + measured width
// ──────────────────────────────────────────────
function Chart({ children, height = 240, fallback }) {
  const mounted = useMount();
  const [ref, w] = useWidth(700);
  return (
    <div ref={ref} style={{ width: "100%", minHeight: height }}>
      {!mounted
        ? <div style={{ height, background: "#f9fafb", borderRadius: 8 }} />
        : typeof children === "function" ? children(w, height) : children
      }
    </div>
  );
}

// ──────────────────────────────────────────────
// CARD WRAPPER
// ──────────────────────────────────────────────
function Card({ title, subtitle, children, style = {} }) {
  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: "20px 24px", border: "1px solid #e5e7eb", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", ...style }}>
      {title && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>{title}</div>
          {subtitle && <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>{subtitle}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────
// LOADING SKELETON
// ──────────────────────────────────────────────
function Skeleton() {
  const b = { background: "#e5e7eb", borderRadius: 6, animation: "sk 1.4s ease infinite" };
  return (
    <>
      <style>{`@keyframes sk{0%,100%{opacity:.4}50%{opacity:.9}}`}</style>
      <div className="g4" style={{ marginBottom: 16 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{ background: "linear-gradient(135deg,#cbd5e1,#94a3b8)", borderRadius: 14, padding: 20, animation: "sk 1.4s ease infinite" }}>
            <div style={{ ...b, height: 40, width: 40, borderRadius: 10, background: "rgba(255,255,255,0.25)", marginBottom: 14 }} />
            <div style={{ ...b, height: 28, width: "55%", background: "rgba(255,255,255,0.25)", marginBottom: 8 }} />
            <div style={{ ...b, height: 12, width: "70%", background: "rgba(255,255,255,0.18)" }} />
          </div>
        ))}
      </div>
      <div style={{ background: "#fff", borderRadius: 14, padding: "20px 24px", border: "1px solid #e5e7eb", marginBottom: 16 }}>
        <div style={{ ...b, height: 16, width: 160, marginBottom: 12 }} /><div style={{ ...b, height: 240 }} />
      </div>
    </>
  );
}

// ──────────────────────────────────────────────
// FILTER BAR — plain <a> links for presets,
// plain <form GET> for custom dates.
// Most reliable approach in any iframe context.
// ──────────────────────────────────────────────
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
  const today = ymd(new Date());
  const defFrom = shift(today, -6);
  const [fr, setFr] = useState(from || defFrom);
  const [toDt, setTo] = useState(to || today);

  // Build a href that PRESERVES existing search params (e.g. Shopify auth params)
  // and only overrides the filter params
  function presetHref(v) {
    const p = new URLSearchParams(searchParams);
    p.set("preset", v);
    p.delete("from"); p.delete("to");
    return `?${p.toString()}`;
  }

  function customHref() {
    const p = new URLSearchParams(searchParams);
    p.delete("preset");
    p.set("from", fr);
    p.set("to", toDt);
    return `?${p.toString()}`;
  }

  const pill = (active) => ({
    display: "inline-block", padding: "7px 14px", borderRadius: 100, fontSize: 13, fontWeight: 600,
    textDecoration: "none", transition: "all .15s",
    border: "1.5px solid",
    borderColor: active ? "#4285f4" : "rgba(255,255,255,0.25)",
    background: active ? "#4285f4" : "rgba(255,255,255,0.1)",
    color: "#fff",
    boxShadow: active ? "0 4px 12px rgba(66,133,244,0.4)" : "none",
    pointerEvents: disabled ? "none" : "auto",
    opacity: disabled ? 0.55 : 1,
  });

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>

      {/* Preset links — plain <a> tags, React Router intercepts them */}
      {PRESETS.map(p => (
        <a key={p.v} href={presetHref(p.v)} style={pill(preset === p.v)}>{p.label}</a>
      ))}

      {/* Separator */}
      <div style={{ width: 1, height: 28, background: "rgba(255,255,255,0.2)", flexShrink: 0 }} />

      {/* Custom date range */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <input type="date" value={fr} max={toDt || today} onChange={e => setFr(e.target.value)}
          style={{ border: "none", background: "rgba(255,255,255,0.12)", color: "#fff", fontSize: 13, padding: "6px 10px", borderRadius: 8, fontFamily: "inherit", outline: "none", cursor: "pointer", colorScheme: "dark", border: "1.5px solid rgba(255,255,255,0.25)" }} />
        <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>to</span>
        <input type="date" value={toDt} min={fr} max={today} onChange={e => setTo(e.target.value)}
          style={{ border: "none", background: "rgba(255,255,255,0.12)", color: "#fff", fontSize: 13, padding: "6px 10px", borderRadius: 8, fontFamily: "inherit", outline: "none", cursor: "pointer", colorScheme: "dark", border: "1.5px solid rgba(255,255,255,0.25)" }} />
        <a href={customHref()} style={{ ...pill(false), background: "#fff", color: "#4285f4", borderColor: "transparent", boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}>
          Apply
        </a>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// SETUP PAGE
// ──────────────────────────────────────────────
function SetupPage() {
  const [pid, setPid] = useState("");
  const nav = useNavigation();
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

// ──────────────────────────────────────────────
// MAIN DASHBOARD
// ──────────────────────────────────────────────
export default function Dashboard() {
  const { configured, data, error, preset, from, to } = useLoaderData() || {};
  const nav = useNavigation();
  const loading = nav.state !== "idle";
  const m = useMemo(() => processMetrics(data), [data]);

  if (!configured) return <SetupPage />;

  const maxCh = Math.max(1, ...m.channels.map(c => c.sessions));
  const maxPg = Math.max(1, ...m.topPages.map(p => p.views));
  const maxDev = Math.max(1, ...m.devices.map(d => d.sessions));

  return (
    <div style={{ fontFamily: "'Inter',system-ui,sans-serif", background: "#f8fafc", minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;}
        .g4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;}
        .g2{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
        .g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;}
        @media(max-width:1024px){.g4{grid-template-columns:repeat(2,1fr);}.g3{grid-template-columns:1fr 1fr;}}
        @media(max-width:640px) {.g4{grid-template-columns:1fr 1fr;}.g2{grid-template-columns:1fr;}.g3{grid-template-columns:1fr;}}
        @media(max-width:400px) {.g4{grid-template-columns:1fr;}}
        input[type=date]::-webkit-calendar-picker-indicator{filter:invert(1);opacity:.7;cursor:pointer;}
        a{transition:opacity .15s;}
        a:hover{opacity:.85;}
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ background: "linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#0f4c75 100%)", padding: "24px 24px 76px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -80, right: -60, width: 240, height: 240, borderRadius: "50%", background: "rgba(66,133,244,0.12)" }} />
        <div style={{ position: "absolute", bottom: -40, left: "38%", width: 160, height: 160, borderRadius: "50%", background: "rgba(52,168,83,0.09)" }} />
        <div style={{ maxWidth: 1200, margin: "0 auto", position: "relative", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(66,133,244,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#fff" }}>Analytics Overview</h1>
              <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>Google Analytics 4 · Live data</p>
            </div>
          </div>
          <FilterBar preset={preset || "7days"} from={from} to={to} disabled={loading} />
        </div>
      </div>

      {/* ── CONTENT ── */}
      <div style={{ maxWidth: 1200, margin: "-60px auto 0", padding: "0 20px 48px", position: "relative", zIndex: 2 }}>

        {error ? (
          <Card style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 2 }}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
              <div>
                <b style={{ color: "#dc2626", display: "block", marginBottom: 4 }}>Failed to load analytics</b>
                <span style={{ fontSize: 13, color: "#ef4444" }}>{error}</span>
              </div>
            </div>
          </Card>
        ) : loading ? <Skeleton /> : data ? (
          <>
            {/* STAT CARDS */}
            <div className="g4" style={{ marginBottom: 16 }}>
              <Stat label="Page Views" value={fmt(m.pv)} trend={m.trends.pv} icon="👁" bg="linear-gradient(135deg,#4285f4,#1a73e8)" />
              <Stat label="Sessions" value={fmt(m.s)} trend={m.trends.s} icon="🔗" bg="linear-gradient(135deg,#34a853,#1e8e3e)" />
              <Stat label="Active Users" value={fmt(m.u)} trend={m.trends.u} icon="👥" bg="linear-gradient(135deg,#a142f4,#7627bb)" />
              <Stat label="Conversions" value={fmt(m.cv)} trend={m.trends.cv} icon="🎯" bg="linear-gradient(135deg,#fa7b17,#e37400)" />
            </div>

            {/* TRAFFIC CHART */}
            <Card title="Traffic Overview" subtitle="Page views & sessions over time" style={{ marginBottom: 16 }}>
              <Chart height={240}>
                {(w, h) => m.chart.length > 0 ? (
                  <LineChart width={w} height={h} data={m.chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#9ca3af" }} padding={{ left: 10, right: 10 }} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#9ca3af" }} width={44} tickFormatter={fmt} />
                    <Tooltip content={<Tip />} />
                    <Line type="monotone" dataKey="pv" name="Page Views" stroke="#4285f4" strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 0 }} />
                    <Line type="monotone" dataKey="sessions" name="Sessions" stroke="#34a853" strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 0 }} />
                  </LineChart>
                ) : (
                  <div style={{ height: h, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>No chart data</div>
                )}
              </Chart>
            </Card>

            {/* USERS + CONVERSIONS */}
            <div className="g2" style={{ marginBottom: 16 }}>
              <Card title="Active Users" subtitle="Daily unique users">
                <Chart height={180}>
                  {(w, h) => m.chart.length > 0 ? (
                    <LineChart width={w} height={h} data={m.chart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#9ca3af" }} />
                      <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#9ca3af" }} width={32} tickFormatter={fmt} />
                      <Tooltip content={<Tip />} />
                      <Line type="monotone" dataKey="users" name="Users" stroke="#a142f4" strokeWidth={2.5} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                    </LineChart>
                  ) : <div style={{ height: h, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>No data</div>}
                </Chart>
              </Card>

              <Card title="Conversions" subtitle="Daily conversion events">
                <Chart height={180}>
                  {(w, h) => m.chart.length > 0 ? (
                    <BarChart width={w} height={h} data={m.chart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#9ca3af" }} />
                      <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#9ca3af" }} width={28} />
                      <Tooltip content={<Tip />} />
                      <Bar dataKey="conversions" name="Conversions" fill="#fa7b17" radius={[4, 4, 0, 0]} maxBarSize={28} />
                    </BarChart>
                  ) : <div style={{ height: h, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13 }}>No data</div>}
                </Chart>
              </Card>
            </div>

            {/* CHANNELS + DEVICES + TOP PAGES */}
            <div className="g3" style={{ marginBottom: 16 }}>

              {/* Traffic Channels */}
              <Card title="Traffic Channels" subtitle="Sessions by source">
                {m.channels.length > 0 ? m.channels.map((c, i) => (
                  <div key={i} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                      <span style={{ fontWeight: 500, color: "#111827" }}>{c.name}</span>
                      <span style={{ fontWeight: 700, color: "#111827" }}>{fmt(c.sessions)}</span>
                    </div>
                    <div style={{ height: 5, background: "#f3f4f6", borderRadius: 3 }}>
                      <div style={{ height: "100%", width: `${Math.round(c.sessions / maxCh * 100)}%`, background: "linear-gradient(90deg,#4285f4,#34a853)", borderRadius: 3, transition: "width .4s" }} />
                    </div>
                  </div>
                )) : <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>No channel data</p>}
              </Card>

              {/* Devices */}
              <Card title="Devices" subtitle="Sessions by device">
                {m.devices.length > 0 ? m.devices.map((d, i) => {
                  const colors = ["#4285f4", "#34a853", "#fa7b17", "#a142f4", "#ea4335"];
                  return (
                    <div key={i} style={{ marginBottom: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                        <span style={{ fontWeight: 500, color: "#111827", textTransform: "capitalize" }}>{d.device}</span>
                        <span style={{ fontWeight: 700, color: "#111827" }}>{fmt(d.sessions)}</span>
                      </div>
                      <div style={{ height: 5, background: "#f3f4f6", borderRadius: 3 }}>
                        <div style={{ height: "100%", width: `${Math.round(d.sessions / maxDev * 100)}%`, background: colors[i % colors.length], borderRadius: 3, transition: "width .4s" }} />
                      </div>
                    </div>
                  );
                }) : <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>No device data</p>}
              </Card>

              {/* Top Pages */}
              <Card title="Top Pages" subtitle="Most viewed pages">
                {m.topPages.length > 0 ? m.topPages.slice(0, 6).map((p, i) => (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 12 }}>
                      <span style={{ fontWeight: 500, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" }} title={p.path}>{p.path}</span>
                      <span style={{ fontWeight: 700, color: "#111827", flexShrink: 0, marginLeft: 8 }}>{fmt(p.views)}</span>
                    </div>
                    <div style={{ height: 4, background: "#f3f4f6", borderRadius: 2 }}>
                      <div style={{ height: "100%", width: `${Math.round(p.views / maxPg * 100)}%`, background: "linear-gradient(90deg,#a142f4,#4285f4)", borderRadius: 2 }} />
                    </div>
                  </div>
                )) : <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>No page data</p>}
              </Card>
            </div>

            {/* ORGANIC SOURCES TABLE */}
            <Card title="Top Organic Traffic Sources" subtitle="Landing pages from organic search">
              {m.organic.length > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, minWidth: 360 }}>
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
                              <div style={{ height: "100%", width: `${Math.round(r.sessions / Math.max(1, m.organic[0].sessions) * 100)}%`, background: "linear-gradient(90deg,#4285f4,#34a853)", borderRadius: 2 }} />
                            </div>
                          </td>
                          <td style={{ padding: "12px 14px", fontSize: 14, fontWeight: 700, color: "#111827", textAlign: "right" }}>{fmt(r.sessions)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p style={{ color: "#9ca3af", fontSize: 13, margin: "8px 0 0" }}>No organic data for this period</p>}
            </Card>
          </>
        ) : (
          <Card style={{ padding: 48, textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "#9ca3af" }}>No data available for this period</div>
          </Card>
        )}

        <div style={{ textAlign: "center", marginTop: 40, fontSize: 12, color: "#9ca3af" }}>
          Google Analytics 4 · Data refreshes on page load
        </div>
      </div>
    </div>
  );
}
