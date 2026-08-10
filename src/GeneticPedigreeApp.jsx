import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { computePedigreeLayout } from "./pedigreeLayout.js";
import {
  GitFork, UserPlus, Upload, Download, Undo2, Redo2, Trash2, Search,
  Plus, Minus, Maximize2, RotateCcw, Users, ChevronDown, Crosshair,
} from "lucide-react";

const uid = (p = "p") => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const clone = (x) => JSON.parse(JSON.stringify(x));

class PedigreeJSAdapter {
  constructor() { this.isReady = false; this.engine = null; }
  async ensureLoaded() {
    if (window.Pedigree || window.pedigree) { this.engine = window.Pedigree || window.pedigree; this.isReady = true; return true; }
    return false;
  }
  toPedigreeModel(data) {
    const persons = Object.values(data.people).map((p) => ({
      id: p.id, name: p.name,
      sex: p.sex === 'male' ? 'M' : p.sex === 'female' ? 'F' : 'U',
      affected: !!p.affected, carrier: !!p.carrier, deceased: !!p.deceased, mutation: !!p.hasMutation,
      mother: p.motherId || null, father: p.fatherId || null, spouses: p.spouseIds || [], children: p.childIds || [],
    }));
    return { persons };
  }
  layout(data) {
    if (!this.isReady || !this.engine) return null;
    try {
      const model = this.toPedigreeModel(data);
      const result = this.engine.layout ? this.engine.layout(model) : null;
      if (!result) return null;
      const nodes = {}; (result.nodes || result).forEach((n) => (nodes[n.id] = { x: n.x, y: n.y }));
      return nodes;
    } catch (e) { console.warn("PedigreeJS layout failed:", e); return null; }
  }
}
const pedigreeAdapter = new PedigreeJSAdapter();

function calcCarrierRisk(person, data) {
  const mother = person.motherId ? data.people[person.motherId] : undefined;
  const father = person.fatherId ? data.people[person.fatherId] : undefined;
  if (person.carrier) return { risk: 1, reason: "خود فرد ناقل است" };
  if (mother?.carrier && father?.carrier) return { risk: 0.6667, reason: "هر دو والد ناقل؛ ~۲/۳" };
  if (mother?.affected || father?.affected) return { risk: 0.5, reason: "والد مبتلا؛ ~۵۰٪" };
  if (mother?.carrier || father?.carrier) return { risk: 0.25, reason: "یک والد ناقل؛ ~۲۵٪" };
  return { risk: 0.05, reason: "ریسک زمینه‌ای پایین (نمایشی)" };
}

function reducer(history, action) {
  const apply = (s, a) => {
    const data = clone(s.data);
    switch (a.type) {
      case "ADD_PERSON": {
        const id = uid();
        data.people[id] = { id, name: "بی‌نام", sex: "unknown", spouseIds: [], childIds: [], twinType: "none", adopted: false, ...(a.person || {}) };
        return { ...s, data, selectedId: id };
      }
      case "UPDATE": {
        const p = data.people[a.id]; if (p) data.people[a.id] = { ...p, ...a.patch }; return { ...s, data };
      }
      case "DELETE": {
        const id = a.id;
        Object.values(data.people).forEach((p) => {
          if (p.motherId === id) p.motherId = null;
          if (p.fatherId === id) p.fatherId = null;
          p.spouseIds = (p.spouseIds || []).filter((v) => v !== id);
          p.childIds = (p.childIds || []).filter((v) => v !== id);
        });
        delete data.people[id]; return { ...s, data, selectedId: null };
      }
      case "ADD_CHILD": {
        const id = uid();
        data.people[id] = { id, name: "نوزاد", sex: "unknown", spouseIds: [], childIds: [], motherId: a.motherId ?? null, fatherId: a.fatherId ?? null };
        if (a.motherId && data.people[a.motherId]) data.people[a.motherId].childIds.push(id);
        if (a.fatherId && data.people[a.fatherId]) data.people[a.fatherId].childIds.push(id);
        return { ...s, data, selectedId: id };
      }
      case "ADD_PARENT": {
        const child = data.people[a.childId]; if (!child) return s;
        const sex = a.sex || "unknown";
        const id = uid();
        const name = sex === 'male' ? 'پدر' : sex === 'female' ? 'مادر' : 'والد';
        data.people[id] = { id, name, sex, spouseIds: [], childIds: [a.childId], twinType: "none", adopted: false };
        if (sex === 'male') child.fatherId = id; else if (sex === 'female') child.motherId = id;
        const otherId = sex === 'female' ? child.fatherId : sex === 'male' ? child.motherId : null;
        if (otherId && data.people[otherId] && otherId !== id) {
          if (!data.people[id].spouseIds.includes(otherId)) data.people[id].spouseIds.push(otherId);
          data.people[otherId].spouseIds = data.people[otherId].spouseIds || [];
          if (!data.people[otherId].spouseIds.includes(id)) data.people[otherId].spouseIds.push(id);
        }
        return { ...s, data, selectedId: id };
      }
      case "ADD_SPOUSE": {
        const person = data.people[a.personId]; if (!person) return s;
        const sex = a.sex || (person.sex === 'male' ? 'female' : person.sex === 'female' ? 'male' : 'unknown');
        const id = uid();
        data.people[id] = { id, name: 'همسر', sex, spouseIds: [a.personId], childIds: [], twinType: "none", adopted: false };
        person.spouseIds = person.spouseIds || [];
        if (!person.spouseIds.includes(id)) person.spouseIds.push(id);
        (person.childIds || []).forEach((cid) => {
          const ch = data.people[cid]; if (!ch) return;
          if (sex === 'female' && !ch.motherId) { ch.motherId = id; data.people[id].childIds.push(cid); }
          else if (sex === 'male' && !ch.fatherId) { ch.fatherId = id; data.people[id].childIds.push(cid); }
        });
        return { ...s, data, selectedId: id };
      }
      case "LOAD": {
        if (!a.data || typeof a.data !== 'object' || !a.data.people || typeof a.data.people !== 'object') return s;
        return { ...s, data: clone(a.data), selectedId: null };
      }
      case "SELECT": return { ...s, selectedId: a.id };
      case "ZOOM": return { ...s, zoom: Math.max(0.2, Math.min(4, s.zoom + a.delta)) };
      case "PAN": return { ...s, offset: { x: s.offset.x + a.dx, y: s.offset.y + a.dy } };
      case "SET_VIEW": return { ...s, zoom: a.zoom, offset: a.offset };
      case "RESET": return { ...s, zoom: 1, offset: { x: 80, y: 80 } };
      default: return s;
    }
  };
  const { past, present, future } = history;
  if (action.type === "UNDO") {
    if (!past.length) return history;
    return { past: past.slice(0, -1), present: past[past.length - 1], future: [present, ...future] };
  }
  if (action.type === "REDO") {
    if (!future.length) return history;
    return { past: [...past, present], present: future[0], future: future.slice(1) };
  }
  if (["SELECT", "ZOOM", "PAN", "RESET", "SET_VIEW"].includes(action.type)) {
    return { past, present: apply(present, action), future };
  }
  const newPresent = apply(present, action);
  return { past: [...past, present], present: newPresent, future: [] };
}

function useHistory(initial) {
  const [history, dispatch] = useReducer(reducer, { past: [], present: initial, future: [] });
  return { history, dispatch };
}

function buildSample() {
  const a = { id: uid(), name: "پدربزرگ", sex: "male", deceased: true, deathAge: 78, spouseIds: [], childIds: [] };
  const b = { id: uid(), name: "مادربزرگ", sex: "female", spouseIds: [], childIds: [] };
  const c = { id: uid(), name: "پدر", sex: "male", spouseIds: [], childIds: [], motherId: b.id, fatherId: a.id };
  const d = { id: uid(), name: "مادر", sex: "female", carrier: true, spouseIds: [], childIds: [] };
  const e = { id: uid(), name: "فرزند ۱", sex: "female", affected: true, hasMutation: true, spouseIds: [], childIds: [], motherId: d.id, fatherId: c.id };
  const f = { id: uid(), name: "فرزند ۲", sex: "male", spouseIds: [], childIds: [], motherId: d.id, fatherId: c.id };
  a.spouseIds.push(b.id); b.spouseIds.push(a.id);
  c.spouseIds.push(d.id); d.spouseIds.push(c.id);
  a.childIds.push(c.id); b.childIds.push(c.id);
  d.childIds.push(e.id, f.id); c.childIds.push(e.id, f.id);
  return { people: { [a.id]: a, [b.id]: b, [c.id]: c, [d.id]: d, [e.id]: e, [f.id]: f } };
}

function computeGenerations(data) {
  const depth = {}; const people = data.people;
  const roots = Object.values(people).filter((p) => !p.motherId && !p.fatherId);
  const visit = (id, d, stack) => { const node = people[id]; if (!node || stack.has(id)) return; depth[id] = depth[id] !== undefined ? Math.max(depth[id], d) : d; stack.add(id); (node.childIds || []).forEach((cid) => visit(cid, d + 1, stack)); stack.delete(id); };
  (roots.length ? roots : Object.values(people)).forEach((r) => visit(r.id, 0, new Set()));
  return depth;
}

function layoutNodes(data) {
  const pedNodes = pedigreeAdapter.layout(data);
  if (pedNodes) return pedNodes;
  const generations = computeGenerations(data), byGen = {}, nodes = {}, xGap = 160, yGap = 140;
  Object.values(data.people).forEach((p) => { const g = generations[p.id] ?? 0; (byGen[g] = byGen[g] || []).push(p); });
  Object.entries(byGen).forEach(([gStr, list]) => { const g = +gStr; list.forEach((p, i) => { nodes[p.id] = { x: i * xGap, y: g * yGap }; }); });
  return nodes;
}

// Fallback layout (only used if the engine throws): old generation rows + simple straight links.
function fallbackLayout(data) {
  const nodes = layoutNodes(data);
  const r = 28;
  const connectors = { mating: [], drop: [], sibship: [], childLink: [], longEdge: [] };
  Object.values(data.people).forEach((p) => {
    (p.spouseIds || []).forEach((sid) => { if (String(sid) < String(p.id)) return; const a = nodes[p.id], b = nodes[sid]; if (a && b) connectors.mating.push({ x1: Math.min(a.x, b.x) + r, y1: a.y, x2: Math.max(a.x, b.x) - r, y2: b.y }); });
  });
  Object.values(data.people).forEach((p) => {
    const a = nodes[p.id]; if (!a) return;
    (p.childIds || []).forEach((cid) => { const b = nodes[cid]; if (b) connectors.longEdge.push({ points: [[a.x, a.y + r], [b.x, b.y - r]] }); });
  });
  return { nodes, connectors, generations: {}, simple: true };
}

function PersonGlyph({ person, size = 52 }) {
  const stroke = person.deceased ? "stroke-[3px] stroke-gray-400" : "stroke-[2px] stroke-gray-700";
  const fill = person.affected ? "fill-red-500/60" : person.carrier ? "fill-amber-400/60" : person.hasMutation ? "fill-sky-400/50" : "fill-white";
  const shape = person.sex === "male" ? "square" : person.sex === "female" ? "circle" : "diamond";
  const base = `drop-shadow-sm ${fill} ${stroke}`;
  if (shape === 'square') return <rect x={-size / 2} y={-size / 2} width={size} height={size} rx={6} className={base} />;
  if (shape === 'circle') return <circle r={size / 2} className={base} />;
  return <polygon points={`${-size / 2},0 0,${-size / 2} ${size / 2},0 0,${size / 2}`} className={base} />;
}

/* ---------------- glass UI primitives ---------------- */
const GLASS = "border border-white/40 bg-white/55 shadow-[0_8px_32px_rgba(31,38,135,0.18)] backdrop-blur-2xl";
const BTN = {
  primary: "bg-gradient-to-r from-indigo-500 to-fuchsia-500 text-white shadow-lg hover:brightness-110",
  ghost: "bg-white/55 text-slate-700 border border-white/50 hover:bg-white/80",
};

function Btn({ children, onClick, variant = 'ghost', className = '', title, disabled }) {
  return (
    <button title={title} disabled={disabled} onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${BTN[variant] || BTN.ghost} ${className}`}>
      {children}
    </button>
  );
}
function IconBtn({ children, onClick, title, disabled, className = '' }) {
  return (
    <button title={title} disabled={disabled} onClick={onClick}
      className={`grid h-9 w-9 place-items-center rounded-xl bg-white/65 text-slate-700 shadow-sm transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}>
      {children}
    </button>
  );
}
function Toggle({ checked, onChange, label, color = 'indigo' }) {
  const track = { indigo: 'bg-indigo-500', rose: 'bg-rose-500', amber: 'bg-amber-400', sky: 'bg-sky-500', slate: 'bg-slate-500' }[color] || 'bg-indigo-500';
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className="flex items-center justify-between gap-2 rounded-xl border border-white/50 bg-white/45 px-3 py-2 text-sm transition hover:bg-white/65">
      <span className="text-slate-700">{label}</span>
      <span className={`relative inline-block h-5 w-9 rounded-full transition ${checked ? track : 'bg-slate-300/70'}`}>
        <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all" style={{ left: checked ? 18 : 2 }} />
      </span>
    </button>
  );
}
function Segmented({ value, onChange, options }) {
  return (
    <div className="flex gap-1 rounded-xl border border-white/50 bg-white/40 p-1">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`flex-1 rounded-lg px-2 py-1.5 text-sm transition ${value === o.value ? 'bg-gradient-to-r from-indigo-500 to-fuchsia-500 text-white shadow' : 'text-slate-600 hover:bg-white/60'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
function StatPill({ label, value, accent }) {
  const a = { indigo: 'text-indigo-600', sky: 'text-sky-600', rose: 'text-rose-600', amber: 'text-amber-600' }[accent] || 'text-slate-700';
  return (
    <div className="rounded-xl bg-white/50 px-3 py-2">
      <div className={`text-xl font-extrabold ${a}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
function MiniGlyph({ person, size = 22 }) {
  const fill = person.affected ? '#ef4444' : person.carrier ? '#f59e0b' : person.hasMutation ? '#60a5fa' : '#ffffff';
  const stroke = person.deceased ? '#94a3b8' : '#475569';
  const shape = person.sex === 'male' ? 'sq' : person.sex === 'female' ? 'ci' : 'di';
  return (
    <svg width={size} height={size} viewBox="-14 -14 28 28" className="shrink-0">
      {shape === 'sq' && <rect x={-10} y={-10} width={20} height={20} rx={3} fill={fill} stroke={stroke} strokeWidth={2} />}
      {shape === 'ci' && <circle r={11} fill={fill} stroke={stroke} strokeWidth={2} />}
      {shape === 'di' && <polygon points="-11,0 0,-11 11,0 0,11" fill={fill} stroke={stroke} strokeWidth={2} />}
      {person.deceased && <line x1={-11} y1={-11} x2={11} y2={11} stroke={stroke} strokeWidth={2} />}
    </svg>
  );
}
/* ---------------- family connectors (lines between relatives) ---------------- */
const LINE = { mating: "#475569", descent: "#94a3b8" };

function FamilyConnectors({ connectors }) {
  return (
    <>
      {connectors.mating.map((s, i) => (<line key={`mat-${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={LINE.mating} strokeWidth={2} />))}
      {connectors.drop.map((s, i) => (<line key={`drp-${i}`} x1={s.x} y1={s.y1} x2={s.x} y2={s.y2} stroke={LINE.descent} strokeWidth={2} />))}
      {connectors.sibship.map((s, i) => (<line key={`sib-${i}`} x1={s.x1} y1={s.y} x2={s.x2} y2={s.y} stroke={LINE.descent} strokeWidth={2} />))}
      {connectors.childLink.map((s, i) => (<line key={`cl-${i}`} x1={s.x} y1={s.y1} x2={s.x} y2={s.y2} stroke={LINE.descent} strokeWidth={2} />))}
      {connectors.longEdge.map((e, i) => (<polyline key={`le-${i}`} points={e.points.map((pt) => pt.join(',')).join(' ')} fill="none" stroke={LINE.descent} strokeWidth={2} />))}
    </>
  );
}

function PersonNode({ person, pos, selected, risk, onSelect, onContextMenu }) {
  return (
    <g transform={`translate(${pos.x},${pos.y})`} data-node onClick={onSelect} onContextMenu={onContextMenu} className="cursor-pointer">
      {selected && <circle r={40} fill="none" stroke="#6366f1" strokeWidth={3} strokeDasharray="4 4" className="opacity-90" />}
      <PersonGlyph person={person} />
      <text y={42} textAnchor="middle" className="select-none fill-slate-700 text-xs font-medium">{person.name}</text>
      {person.deceased && <line x1={-28} y1={-28} x2={28} y2={28} stroke={LINE.mating} strokeWidth={2} />}
      {risk > 0.5 && (
        <g transform="translate(34,-34)">
          <circle r={10} fill="#fee2e2" stroke="#ef4444" />
          <text textAnchor="middle" dy={4} className="text-[10px]">⚠</text>
        </g>
      )}
    </g>
  );
}

function LegendRow({ vertical = false }) {
  const items = [
    { t: 'sq', label: 'مرد' }, { t: 'ci', label: 'زن' }, { t: 'di', label: 'نامشخص' },
    { t: 'dot', c: '#ef4444', label: 'مبتلا' }, { t: 'dot', c: '#f59e0b', label: 'ناقل' },
    { t: 'dot', c: '#60a5fa', label: 'جهش' }, { t: 'slash', label: 'فوت' },
  ];
  const g = (it) => {
    if (it.t === 'sq') return <rect x={-5} y={-5} width={10} height={10} fill="#fff" stroke="#475569" strokeWidth={1.5} />;
    if (it.t === 'ci') return <circle r={5.5} fill="#fff" stroke="#475569" strokeWidth={1.5} />;
    if (it.t === 'di') return <polygon points="-6,0 0,-6 6,0 0,6" fill="#fff" stroke="#475569" strokeWidth={1.5} />;
    if (it.t === 'dot') return <circle r={5.5} fill={it.c} />;
    return <line x1={-5} y1={-5} x2={5} y2={5} stroke="#475569" strokeWidth={1.5} />;
  };
  return (
    <div className={vertical ? 'grid grid-cols-2 gap-1.5 text-[11px] text-slate-600' : 'flex flex-wrap items-center gap-x-3 gap-y-1'}>
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          <svg width="14" height="14" viewBox="-8 -8 16 16">{g(it)}</svg>
          <span>{it.label}</span>
        </span>
      ))}
    </div>
  );
}

/* ---------------- main app ---------------- */
export default function GeneticPedigreeApp() {
  const initial = { data: buildSample(), selectedId: null, zoom: 1, offset: { x: 80, y: 80 } };
  const { history, dispatch } = useHistory(initial);
  const state = history.present;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  const [menu, setMenu] = useState({ x: 0, y: 0, id: null });
  const [query, setQuery] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const dragging = useRef(null);
  const didFit = useRef(false);

  const layout = useMemo(() => {
    try { return computePedigreeLayout(state.data); }
    catch (err) { console.warn('Pedigree layout engine failed, using fallback:', err); return fallbackLayout(state.data); }
  }, [state.data]);
  const nodes = layout.nodes;

  const selected = state.selectedId ? state.data.people[state.selectedId] : null;
  const people = Object.values(state.data.people);
  const filtered = people.filter((p) => !query || String(p.name || '').includes(query));
  const stats = useMemo(() => {
    const gens = Object.values(layout.generations || {});
    return {
      total: people.length,
      affected: people.filter((p) => p.affected).length,
      carriers: people.filter((p) => p.carrier).length,
      generations: gens.length ? Math.max(...gens) + 1 : 0,
    };
  }, [state.data, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- interactions ----
  const onMouseDown = (e) => { if (e.target.closest('[data-node]') || e.target.closest('[data-ui]')) return; dragging.current = { x: e.clientX, y: e.clientY }; };
  const onMouseMove = (e) => { if (!dragging.current) return; const dx = e.clientX - dragging.current.x, dy = e.clientY - dragging.current.y; dragging.current = { x: e.clientX, y: e.clientY }; dispatch({ type: 'PAN', dx, dy }); };
  const onMouseUp = () => { dragging.current = null; };
  const onWheel = (e) => { dispatch({ type: 'ZOOM', delta: e.deltaY < 0 ? 0.08 : -0.08 }); };
  const openMenu = (e, id) => { e.preventDefault(); const r = wrapRef.current?.getBoundingClientRect(); setMenu({ x: e.clientX - (r?.left || 0), y: e.clientY - (r?.top || 0), id }); };

  const addRelative = (kind, baseId) => {
    const base = state.data.people[baseId]; if (!base) return;
    if (kind === 'mother') dispatch({ type: 'ADD_PARENT', childId: baseId, sex: 'female' });
    else if (kind === 'father') dispatch({ type: 'ADD_PARENT', childId: baseId, sex: 'male' });
    else if (kind === 'spouse') dispatch({ type: 'ADD_SPOUSE', personId: baseId });
    else if (kind === 'child') dispatch({ type: 'ADD_CHILD', motherId: base.sex === 'female' ? baseId : base.spouseIds?.[0], fatherId: base.sex === 'male' ? baseId : base.spouseIds?.[0] });
  };

  const fitView = () => {
    const b = layout.bounds; if (!b || !b.width) return;
    const vw = 1200, vh = 700, pad = 50;
    const z = Math.max(0.2, Math.min(2, Math.min((vw - 2 * pad) / b.width, (vh - 2 * pad) / b.height)));
    dispatch({ type: 'SET_VIEW', zoom: z, offset: { x: (vw - b.width * z) / 2, y: (vh - b.height * z) / 2 } });
  };

  // ---- exports ----
  const downloadBlob = (blob, name) => { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); };
  const exportJSON = () => downloadBlob(new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json" }), "pedigree.json");
  const exportCSV = () => {
    const rows = [["id", "name", "sex", "affected", "carrier", "deceased", "hasMutation", "diseaseOnsetAge", "deathAge", "twinType", "adopted", "motherId", "fatherId", "spouseIds", "childIds"],
      ...people.map((p) => [p.id, p.name, p.sex, !!p.affected, !!p.carrier, !!p.deceased, !!p.hasMutation, p.diseaseOnsetAge ?? "", p.deathAge ?? "", p.twinType || "none", !!p.adopted, p.motherId || "", p.fatherId || "", (p.spouseIds || []).join("|"), (p.childIds || []).join("|")])];
    const csv = rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "pedigree.csv");
  };
  const exportSVG = () => {
    if (!svgRef.current) return; const svg = svgRef.current.cloneNode(true);
    svg.querySelectorAll('[data-ui]').forEach((n) => n.parentElement?.removeChild(n));
    downloadBlob(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }), "pedigree.svg");
  };
  const exportPNG = () => {
    if (!svgRef.current) return; const svg = svgRef.current.cloneNode(true);
    svg.querySelectorAll('[data-ui]').forEach((n) => n.parentElement?.removeChild(n));
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image(); const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    img.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 700;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1200, 700); ctx.drawImage(img, 0, 0, 1200, 700);
      canvas.toBlob((png) => { if (png) downloadBlob(png, 'pedigree.png'); URL.revokeObjectURL(url); });
    };
    img.src = url;
  };

  const importJSON = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { try { const data = JSON.parse(String(reader.result)); if (!data || !data.people) throw new Error('invalid'); dispatch({ type: 'LOAD', data }); didFit.current = false; } catch { alert('JSON نامعتبر است'); } };
    reader.readAsText(file); e.target.value = '';
  };

  // ---- effects ----
  useEffect(() => { pedigreeAdapter.ensureLoaded().then(() => dispatch({ type: 'SELECT', id: null })); }, []);
  useEffect(() => { if (didFit.current) return; didFit.current = true; fitView(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); dispatch({ type: e.shiftKey ? 'REDO' : 'UNDO' }); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); dispatch({ type: 'REDO' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div dir="rtl" className="relative min-h-screen w-full text-slate-800">
      {/* background */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-100 via-fuchsia-100 to-rose-100" />
        <div className="absolute -top-24 -right-24 h-96 w-96 rounded-full bg-fuchsia-300/40 blur-3xl animate-floatBlob" />
        <div className="absolute top-1/3 -left-24 h-[30rem] w-[30rem] rounded-full bg-indigo-300/40 blur-3xl animate-floatBlob" style={{ animationDelay: '4s' }} />
        <div className="absolute -bottom-20 right-1/4 h-80 w-80 rounded-full bg-sky-300/40 blur-3xl animate-floatBlob" style={{ animationDelay: '8s' }} />
      </div>

      <div className="mx-auto flex h-screen max-w-[1500px] flex-col gap-3 p-3 sm:p-4">
        {/* top bar */}
        <header className={`${GLASS} flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3`}>
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg"><GitFork size={20} /></div>
            <div>
              <h1 className="text-lg font-extrabold leading-tight">شجره‌نامه ژنتیکی</h1>
              <p className="text-xs text-slate-500">{pedigreeAdapter.isReady ? 'موتور PedigreeJS' : 'موتور layout داخلی'} · {stats.total} نفر · {stats.generations} نسل</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Btn variant="primary" onClick={() => dispatch({ type: 'ADD_PERSON' })}><UserPlus size={16} /> افزودن فرد</Btn>
            <div className="mx-1 h-6 w-px bg-white/60" />
            <IconBtn title="بازگردانی (Ctrl+Z)" disabled={!canUndo} onClick={() => dispatch({ type: 'UNDO' })}><Undo2 size={16} /></IconBtn>
            <IconBtn title="تکرار (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => dispatch({ type: 'REDO' })}><Redo2 size={16} /></IconBtn>
            <div className="mx-1 h-6 w-px bg-white/60" />
            <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition ${BTN.ghost}`}>
              <Upload size={16} /> ورود
              <input type="file" accept="application/json" className="hidden" onChange={importJSON} />
            </label>
            <div className="relative">
              <Btn onClick={() => setExportOpen((o) => !o)}><Download size={16} /> خروجی <ChevronDown size={14} /></Btn>
              {exportOpen && (
                <div className={`${GLASS} absolute left-0 top-full z-30 mt-1 w-40 rounded-xl p-1`}>
                  {[['JSON', exportJSON], ['CSV', exportCSV], ['SVG', exportSVG], ['PNG', exportPNG]].map(([l, fn]) => (
                    <button key={l} onClick={() => { fn(); setExportOpen(false); }} className="block w-full rounded-lg px-3 py-2 text-right text-sm hover:bg-white/70">{l}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* body */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-12">
          {/* people + stats (right in RTL) */}
          <aside className="flex min-h-0 flex-col gap-3 lg:col-span-3">
            <div className={`${GLASS} flex min-h-0 flex-1 flex-col rounded-2xl p-3`}>
              <div className="mb-2 flex items-center gap-2">
                <Users size={16} className="text-indigo-500" />
                <h2 className="text-sm font-bold">افراد</h2>
                <span className="mr-auto rounded-full bg-white/60 px-2 py-0.5 text-xs text-slate-500">{filtered.length}</span>
              </div>
              <div className="relative mb-2">
                <Search size={14} className="pointer-events-none absolute right-2 top-2.5 text-slate-400" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="جستجوی نام…"
                  className="w-full rounded-xl border border-white/50 bg-white/50 py-2 pr-7 pl-2 text-sm outline-none placeholder:text-slate-400 focus:bg-white/80" />
              </div>
              <div className="scroll-glass -mr-1 flex-1 space-y-1 overflow-y-auto pr-1">
                {filtered.length === 0 && <p className="px-2 py-6 text-center text-xs text-slate-400">موردی پیدا نشد</p>}
                {filtered.map((p) => (
                  <button key={p.id} onClick={() => dispatch({ type: 'SELECT', id: p.id })}
                    className={`flex w-full items-center gap-2 rounded-xl px-2 py-2 text-right transition ${state.selectedId === p.id ? 'bg-gradient-to-l from-indigo-500/90 to-fuchsia-500/90 text-white shadow' : 'hover:bg-white/60'}`}>
                    <MiniGlyph person={p} />
                    <span className="flex-1 truncate text-sm">{p.name || 'بی‌نام'}</span>
                    {p.affected && <span className="h-2 w-2 rounded-full bg-rose-500" title="مبتلا" />}
                    {p.carrier && <span className="h-2 w-2 rounded-full bg-amber-400" title="ناقل" />}
                  </button>
                ))}
              </div>
            </div>
            <div className={`${GLASS} grid grid-cols-2 gap-2 rounded-2xl p-3`}>
              <StatPill label="افراد" value={stats.total} accent="indigo" />
              <StatPill label="نسل‌ها" value={stats.generations} accent="sky" />
              <StatPill label="مبتلا" value={stats.affected} accent="rose" />
              <StatPill label="ناقل" value={stats.carriers} accent="amber" />
            </div>
          </aside>

          {/* canvas */}
          <main className="min-h-0 lg:col-span-6">
            <div ref={wrapRef} className={`${GLASS} relative h-[58vh] overflow-hidden rounded-2xl lg:h-full`}>
              <div data-ui className="absolute left-3 top-3 z-10 flex gap-1">
                <IconBtn title="بزرگ‌نمایی" onClick={() => dispatch({ type: 'ZOOM', delta: 0.15 })}><Plus size={16} /></IconBtn>
                <IconBtn title="کوچک‌نمایی" onClick={() => dispatch({ type: 'ZOOM', delta: -0.15 })}><Minus size={16} /></IconBtn>
                <IconBtn title="جا دادن در کادر" onClick={fitView}><Maximize2 size={16} /></IconBtn>
                <IconBtn title="ریست نما" onClick={() => dispatch({ type: 'RESET' })}><RotateCcw size={16} /></IconBtn>
              </div>
              <div data-ui className="absolute bottom-3 left-3 z-10 max-w-[70%] rounded-xl bg-white/60 px-3 py-2 backdrop-blur">
                <LegendRow />
              </div>
              <svg ref={svgRef} className="canvas-svg h-full w-full" viewBox="0 0 1200 700"
                onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
                onWheel={onWheel} onContextMenu={(e) => openMenu(e, null)}>
                <defs>
                  <pattern id="pgrid" width="28" height="28" patternUnits="userSpaceOnUse">
                    <path d="M28 0H0V28" fill="none" stroke="rgba(99,102,241,0.10)" strokeWidth="1" />
                  </pattern>
                </defs>
                <rect x="0" y="0" width="1200" height="700" fill="url(#pgrid)" />
                <g transform={`translate(${state.offset.x},${state.offset.y}) scale(${state.zoom})`}>
                  <FamilyConnectors connectors={layout.connectors} />
                  {people.map((p) => {
                    const pos = nodes[p.id]; if (!pos) return null;
                    const { risk } = calcCarrierRisk(p, state.data);
                    return (
                      <PersonNode key={p.id} person={p} pos={pos} risk={risk}
                        selected={state.selectedId === p.id}
                        onSelect={() => dispatch({ type: 'SELECT', id: p.id })}
                        onContextMenu={(e) => openMenu(e, p.id)} />
                    );
                  })}
                </g>
              </svg>

              {/* glass context menu */}
              {menu.id !== null && (
                <div className={`${GLASS} absolute z-40 rounded-xl p-2 text-sm`} style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu({ x: 0, y: 0, id: null })}>
                  <div className="mb-1 px-1 text-xs text-slate-500">عملیات سریع</div>
                  <div className="grid grid-cols-2 gap-1">
                    <button className="rounded-lg px-2 py-1 text-right hover:bg-white/70" onClick={() => { addRelative('mother', menu.id); setMenu({ x: 0, y: 0, id: null }); }}>افزودن مادر</button>
                    <button className="rounded-lg px-2 py-1 text-right hover:bg-white/70" onClick={() => { addRelative('father', menu.id); setMenu({ x: 0, y: 0, id: null }); }}>افزودن پدر</button>
                    <button className="rounded-lg px-2 py-1 text-right hover:bg-white/70" onClick={() => { addRelative('spouse', menu.id); setMenu({ x: 0, y: 0, id: null }); }}>افزودن همسر</button>
                    <button className="rounded-lg px-2 py-1 text-right hover:bg-white/70" onClick={() => { addRelative('child', menu.id); setMenu({ x: 0, y: 0, id: null }); }}>افزودن فرزند</button>
                    <button className="col-span-2 mt-1 rounded-lg bg-rose-500/90 px-2 py-1 text-white transition hover:bg-rose-600" onClick={() => { dispatch({ type: 'DELETE', id: menu.id }); setMenu({ x: 0, y: 0, id: null }); }}>حذف فرد</button>
                  </div>
                </div>
              )}
            </div>
          </main>

          {/* inspector (left in RTL) */}
          <aside className="min-h-0 lg:col-span-3">
            <div className={`${GLASS} scroll-glass h-[58vh] overflow-y-auto rounded-2xl p-4 lg:h-full`}>
              {selected ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <MiniGlyph person={selected} size={28} />
                    <h2 className="flex-1 truncate text-base font-bold">{selected.name || 'بی‌نام'}</h2>
                    <IconBtn title="حذف فرد" className="!bg-rose-500/90 !text-white hover:!bg-rose-600" onClick={() => dispatch({ type: 'DELETE', id: selected.id })}><Trash2 size={16} /></IconBtn>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">نام</label>
                    <input value={selected.name || ''} onChange={(e) => dispatch({ type: 'UPDATE', id: selected.id, patch: { name: e.target.value } })}
                      className="w-full rounded-xl border border-white/50 bg-white/50 px-3 py-2 text-sm outline-none focus:bg-white/80" />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">جنسیت</label>
                    <Segmented value={selected.sex} onChange={(v) => dispatch({ type: 'UPDATE', id: selected.id, patch: { sex: v } })}
                      options={[{ value: 'male', label: 'مرد' }, { value: 'female', label: 'زن' }, { value: 'unknown', label: 'نامشخص' }]} />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">وضعیت</label>
                    <div className="grid grid-cols-2 gap-2">
                      <Toggle label="مبتلا" color="rose" checked={!!selected.affected} onChange={(v) => dispatch({ type: 'UPDATE', id: selected.id, patch: { affected: v } })} />
                      <Toggle label="ناقل" color="amber" checked={!!selected.carrier} onChange={(v) => dispatch({ type: 'UPDATE', id: selected.id, patch: { carrier: v } })} />
                      <Toggle label="جهش‌دار" color="sky" checked={!!selected.hasMutation} onChange={(v) => dispatch({ type: 'UPDATE', id: selected.id, patch: { hasMutation: v } })} />
                      <Toggle label="فوت‌شده" color="slate" checked={!!selected.deceased} onChange={(v) => dispatch({ type: 'UPDATE', id: selected.id, patch: { deceased: v } })} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-500">سن شروع بیماری</label>
                      <input type="number" value={selected.diseaseOnsetAge ?? ''} onChange={(e) => dispatch({ type: 'UPDATE', id: selected.id, patch: { diseaseOnsetAge: e.target.value ? Number(e.target.value) : null } })}
                        className="w-full rounded-xl border border-white/50 bg-white/50 px-3 py-2 text-sm outline-none focus:bg-white/80" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-500">سن فوت</label>
                      <input type="number" value={selected.deathAge ?? ''} onChange={(e) => dispatch({ type: 'UPDATE', id: selected.id, patch: { deathAge: e.target.value ? Number(e.target.value) : null } })}
                        className="w-full rounded-xl border border-white/50 bg-white/50 px-3 py-2 text-sm outline-none focus:bg-white/80" />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">افزودن خویشاوند</label>
                    <div className="grid grid-cols-2 gap-2">
                      <Btn onClick={() => addRelative('mother', selected.id)}>＋ مادر</Btn>
                      <Btn onClick={() => addRelative('father', selected.id)}>＋ پدر</Btn>
                      <Btn onClick={() => addRelative('spouse', selected.id)}>＋ همسر</Btn>
                      <Btn onClick={() => addRelative('child', selected.id)}>＋ فرزند</Btn>
                    </div>
                  </div>

                  {(() => {
                    const { risk, reason } = calcCarrierRisk(selected, state.data);
                    const pct = Math.round(risk * 100);
                    return (
                      <div className="rounded-xl bg-white/50 p-3">
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-500">ریسک ناقل بودن</span>
                          <span className="font-bold text-slate-700">~{pct}٪</span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200/70">
                          <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-rose-500" style={{ width: `${pct}%` }} />
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500">{reason}</p>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <div className="grid h-14 w-14 place-items-center rounded-2xl bg-white/50 text-indigo-400"><Crosshair size={26} /></div>
                  <p className="text-sm text-slate-500">یک فرد را از نمودار یا لیست انتخاب کن تا اینجا ویرایش شود.</p>
                  <div className="mt-2 w-full"><LegendRow vertical /></div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
