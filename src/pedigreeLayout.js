// pedigreeLayout.js  (engine v3 — damped centred relaxation, family-chart spacing)
// ---------------------------------------------------------------------------
// Production-style genealogical pedigree layout engine.
//
// A pedigree is NOT a tree: every person has up to two biological parents, so
// the structure is a CONSTRAINED LAYERED DAG. This engine implements the
// classic Sugiyama-style pipeline specialised for genealogy:
//
//   1. Normalisation        – read people / parent / spouse / child relations
//   2. Couple abstraction    – spouses & co-parents are unioned into one row
//   3. Generation layering   – longest-path layers (parent strictly above child)
//   4. Dummy nodes           – split edges that span more than one generation
//   5. Ordering              – barycenter sweep to minimise edge crossings
//                              (couples kept adjacent as a block, male-first)
//   6. Coordinate assignment – barycenter relaxation + overlap resolution,
//                              using a variable sibling-gap "separation"
//                              formula ported from family-chart's d3.tree()
//                              layout (github.com/donatso/family-chart):
//                              unrelated neighbours, half-siblings and people
//                              with several spouses get extra breathing room.
//                              (family-chart's own CalculateTree is centred on
//                              one focal person and can't lay out a whole
//                              multi-family pedigree at once, so we keep this
//                              engine's DAG pipeline and only borrow its
//                              spacing technique.)
//   7. Family connectors      – mating line, sibship bus, child drop-lines
//
// Pure & framework-free: it returns geometry only. Rendering is the caller's
// job, so it can be unit-tested with plain Node.
// ---------------------------------------------------------------------------

const DEFAULTS = {
    nodeGap: 96, // min horizontal center-to-center gap between siblings/strangers
    coupleGap: 72, // horizontal gap between the two partners of a couple
    layerGap: 150, // vertical gap between generations
    nodeRadius: 28, // half the glyph size (glyph ≈ 52px) – used for edge endpoints
    sweeps: 8, // barycenter ordering sweeps
    xPasses: 60, // coordinate relaxation passes (damped)
    // family-chart-style separation() multipliers (see calculateTree in
    // donatso/family-chart) — extra fractions of nodeGap added between
    // neighbours that are not close blood relatives.
    unrelatedGapFactor: 0.25, // neighbours that share no parent
    halfSiblingGapFactor: 0.125, // share one parent but not both
    spouseGapFactor: 0.5, // extra room per spouse a neighbour has
};

// ---- minimal union-find (couple / co-parent grouping) ---------------------
function makeDSU() {
    const parent = new Map();
    const find = (x) => {
        if (!parent.has(x)) parent.set(x, x);
        let r = x;
        while (parent.get(r) !== r) r = parent.get(r);
        while (parent.get(x) !== r) { const n = parent.get(x);
            parent.set(x, r);
            x = n; }
        return r;
    };
    const union = (a, b) => { const ra = find(a),
            rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    return { find, union };
}

export function computePedigreeLayout(data, options = {}) {
    const opt = {...DEFAULTS, ...options };
    const people = (data && data.people) ? data.people : {};
    const ids = Object.keys(people);

    const empty = {
        nodes: {},
        connectors: { mating: [], drop: [], sibship: [], childLink: [], longEdge: [] },
        generations: {},
        bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
    };
    if (ids.length === 0) return empty;

    const P = (id) => people[id];
    const parentsOf = (p) => [p.motherId, p.fatherId].filter((x) => x && people[x]);

    // ---- 2. couple / co-parent unioning -------------------------------------
    const dsu = makeDSU();
    ids.forEach((id) => dsu.find(id));
    ids.forEach((id) => {
        const p = P(id);
        (p.spouseIds || []).forEach((s) => { if (people[s]) dsu.union(id, s); });
        if (p.motherId && p.fatherId && people[p.motherId] && people[p.fatherId]) {
            dsu.union(p.motherId, p.fatherId); // co-parents form a couple even w/o spouseIds
        }
    });
    const groupOf = (id) => dsu.find(id);

    // ---- 3. group DAG + longest-path layering (cycle-safe) ------------------
    const groupEdges = new Map(); // gp -> Set(gc)
    const addGE = (gp, gc) => {
        if (gp === gc) return;
        if (!groupEdges.has(gp)) groupEdges.set(gp, new Set());
        groupEdges.get(gp).add(gc);
    };
    ids.forEach((id) => parentsOf(P(id)).forEach((par) => addGE(groupOf(par), groupOf(id))));

    const groupIds = [...new Set(ids.map(groupOf))];
    const layerG = new Map();
    groupIds.forEach((g) => layerG.set(g, 0));
    // iterative relaxation = longest path on a DAG; the iteration cap makes it
    // terminate gracefully even if consanguinity introduces a cycle.
    const cap = groupIds.length + 1;
    for (let it = 0; it < cap; it++) {
        let changed = false;
        for (const [gp, set] of groupEdges) {
            const lp = layerG.get(gp) || 0;
            for (const gc of set) {
                if ((layerG.get(gc) || 0) < lp + 1) { layerG.set(gc, lp + 1);
                    changed = true; }
            }
        }
        if (!changed) break;
    }
    const layerOf = {};
    ids.forEach((id) => { layerOf[id] = layerG.get(groupOf(id)) || 0; });

    // ---- 4. layered graph with dummy nodes for long edges -------------------
    const layers = {}; // layer -> [nodeKey]
    const node = {}; // nodeKey -> { key, kind, layer, person?, block }
    const pushLayer = (L, key) => {
        (layers[L] = layers[L] || []).push(key); };
    ids.forEach((id) => {
        const L = layerOf[id];
        const key = 'P:' + id;
        node[key] = { key, kind: 'person', layer: L, person: id, block: 'G:' + groupOf(id) };
        pushLayer(L, key);
    });

    const upAdj = {}; // key -> [keys in layer-1]
    const downAdj = {}; // key -> [keys in layer+1]
    const link = (aKey, bKey) => {
        (downAdj[aKey] = downAdj[aKey] || []).push(bKey);
        (upAdj[bKey] = upAdj[bKey] || []).push(aKey);
    };
    const dummyChains = {}; // `${parentId}->${childId}` -> [dummyKey] (top->bottom)
    let dseq = 0;
    ids.forEach((id) => {
        const Lc = layerOf[id];
        parentsOf(P(id)).forEach((parId) => {
            const Lp = layerOf[parId];
            if (Lc <= Lp) return; // safety guard against any residual cycle
            if (Lc === Lp + 1) { link('P:' + parId, 'P:' + id); return; }
            const chain = [];
            let prev = 'P:' + parId;
            for (let L = Lp + 1; L <= Lc - 1; L++) {
                const dk = 'D:' + (dseq++);
                node[dk] = { key: dk, kind: 'dummy', layer: L, block: dk };
                pushLayer(L, dk);
                link(prev, dk);
                chain.push(dk);
                prev = dk;
            }
            link(prev, 'P:' + id);
            dummyChains[parId + '->' + id] = chain;
        });
    });

    const layerNums = Object.keys(layers).map(Number).sort((a, b) => a - b);

    // ---- 5a. initial ordering: DFS from roots, keep group members together --
    const order = {};
    (function orderInit() {
        const placed = new Set();
        const seq = {};
        layerNums.forEach((L) => (seq[L] = []));
        const stack = [];
        // family-chart convention: within a couple, male sits left, female right.
        const genderRank = (k) => {
            const pid = node[k].person;
            if (!pid) return 1;
            const sx = P(pid).sex;
            return sx === 'male' ? 0 : sx === 'female' ? 2 : 1;
        };
        const pushBlock = (key) => {
            if (placed.has(key)) return;
            const blk = node[key].block;
            const L = node[key].layer;
            const members = layers[L]
                .filter((k) => node[k].block === blk && !placed.has(k))
                .sort((a, b) => genderRank(a) - genderRank(b));
            members.forEach((k) => { placed.add(k);
                seq[L].push(k); });
            // descend (push children so they are visited near their parents)
            for (let i = members.length - 1; i >= 0; i--) {
                (downAdj[members[i]] || []).forEach((ch) => stack.push(ch));
            }
        };
        const roots = ids
            .filter((id) => parentsOf(P(id)).length === 0)
            .sort((a, b) => (layerOf[a] - layerOf[b]) ||
                String(P(a).name || '').localeCompare(String(P(b).name || '')))
            .map((id) => 'P:' + id);
        roots.forEach((rk) => { stack.push(rk); while (stack.length) pushBlock(stack.pop()); });
        // leftovers (orphans / cycle remnants)
        layerNums.forEach((L) => layers[L].forEach((k) => { if (!placed.has(k)) { placed.add(k);
                seq[L].push(k); } }));
        layerNums.forEach((L) => { layers[L] = seq[L];
            seq[L].forEach((k, i) => (order[k] = i)); });
    })();

    // ---- 5b. barycenter crossing minimisation (couple cohesion) -------------
    const baryOf = (key, useUp) => {
        const adj = (useUp ? upAdj[key] : downAdj[key]) || [];
        if (adj.length === 0) return null;
        let s = 0;
        adj.forEach((k) => (s += order[k]));
        return s / adj.length;
    };
    const reorderLayer = (L, useUp) => {
        const keys = layers[L];
        const blocks = new Map();
        keys.forEach((k) => {
            const b = node[k].block;
            if (!blocks.has(b)) blocks.set(b, []);
            blocks.get(b).push(k);
        });
        const blockList = [...blocks.entries()].map(([b, ks]) => {
            const vals = ks.map((k) => baryOf(k, useUp)).filter((v) => v !== null);
            const bary = vals.length ?
                vals.reduce((a, c) => a + c, 0) / vals.length :
                Math.min(...ks.map((k) => order[k]));
            return { b, ks, bary };
        });
        blockList.sort((a, b) => a.bary - b.bary);
        const next = [];
        blockList.forEach((bl) => bl.ks.sort((a, b) => order[a] - order[b]).forEach((k) => next.push(k)));
        layers[L] = next;
        next.forEach((k, i) => (order[k] = i));
    };
    for (let s = 0; s < opt.sweeps; s++) {
        const useUp = s % 2 === 0;
        (useUp ? layerNums : [...layerNums].reverse()).forEach((L) => reorderLayer(L, useUp));
    }

    // ---- 6. x coordinates: seed by order, relax to neighbours, de-overlap ---
    const x = {};
    // family-chart's calculateTree() spaces siblings with a separation()
    // multiplier instead of a flat gap: 1 normally, +.25 if the pair shares no
    // parent, +.125 if they share only one parent (half-siblings), plus extra
    // room per spouse either neighbour has. Ported here as fractions of nodeGap.
    const parentKeySet = (key) => new Set(upAdj[key] || []);
    const sharesParent = (aKey, bKey) => {
        const pa = parentKeySet(aKey);
        if (!pa.size) return false;
        for (const p of parentKeySet(bKey)) if (pa.has(p)) return true;
        return false;
    };
    const sharesBothParents = (aKey, bKey) => {
        const pa = [...parentKeySet(aKey)].sort();
        const pb = [...parentKeySet(bKey)].sort();
        return pa.length > 0 && pa.length === pb.length && pa.every((p, i) => p === pb[i]);
    };
    const spouseCountOf = (key) => {
        const pid = node[key].person;
        if (!pid) return 0;
        return (P(pid).spouseIds || []).filter((s) => people[s]).length;
    };
    const gapBetween = (prev, k) => {
        if (node[k].block === node[prev].block && node[k].kind === 'person' && node[prev].kind === 'person') {
            return opt.coupleGap;
        }
        let offset = 1;
        if (node[k].kind === 'person' && node[prev].kind === 'person') {
            const related = sharesParent(prev, k);
            if (!related) offset += opt.unrelatedGapFactor;
            else if (!sharesBothParents(prev, k)) offset += opt.halfSiblingGapFactor;
            offset += (spouseCountOf(prev) + spouseCountOf(k)) * opt.spouseGapFactor;
        }
        return opt.nodeGap * offset;
    };
    layerNums.forEach((L) => {
        let cx = 0;
        layers[L].forEach((k, i) => {
            if (i > 0) cx += gapBetween(layers[L][i - 1], k);
            x[k] = cx;
        });
    });
    // same-layer spouse adjacency keeps couples cohesive & centered over their children
    const spouseAdj = {};
    ids.forEach((id) => {
        (P(id).spouseIds || []).forEach((s) => {
            if (people[s] && layerOf[s] === layerOf[id])(spouseAdj['P:' + id] = spouseAdj['P:' + id] || []).push('P:' + s);
        });
    });
    // Centroid-preserving overlap resolver: pack left-to-right to the minimum gaps,
    // then rigidly shift the whole layer back so its average position is unchanged.
    // This keeps a row of siblings centred under their parents — a plain one-
    // directional pack would drift the row to one side.
    const resolve = (L) => {
        const keys = layers[L];
        if (keys.length < 2) return;
        const before = keys.reduce((s, k) => s + x[k], 0) / keys.length;
        for (let i = 1; i < keys.length; i++) {
            const need = x[keys[i - 1]] + gapBetween(keys[i - 1], keys[i]);
            if (x[keys[i]] < need) x[keys[i]] = need;
        }
        const after = keys.reduce((s, k) => s + x[k], 0) / keys.length;
        const shift = before - after;
        if (shift)
            for (const k of keys) x[k] += shift;
    };
    // Pull every node toward the average of its parents, children and spouse(s),
    // damped, with centroid-preserving overlap resolution each pass. Converges to
    // a stable, centred, untangled layout.
    const allKeys = Object.keys(node);
    for (let pass = 0; pass < opt.xPasses; pass++) {
        const target = {};
        for (const k of allKeys) {
            const ups = upAdj[k] || [],
                downs = downAdj[k] || [],
                sps = spouseAdj[k] || [];
            let sum = 0,
                cnt = 0;
            for (const a of ups) { sum += x[a];
                cnt++; }
            for (const a of downs) { sum += x[a];
                cnt++; }
            for (const a of sps) { sum += x[a];
                cnt++; }
            target[k] = cnt ? sum / cnt : x[k];
        }
        for (const k of allKeys) x[k] = x[k] * 0.4 + target[k] * 0.6;
        layerNums.forEach(resolve);
    }
    layerNums.forEach(resolve); // final: centred & collision-free

    // ---- 7. person coordinates ----------------------------------------------
    const yOf = (L) => L * opt.layerGap;
    const nodes = {};
    ids.forEach((id) => { nodes[id] = { x: x['P:' + id], y: yOf(layerOf[id]) }; });

    // ---- 8. family connectors -----------------------------------------------
    const connectors = { mating: [], drop: [], sibship: [], childLink: [], longEdge: [] };
    const r = opt.nodeRadius;
    const families = new Map(); // "motherId+fatherId" -> { m, f, children:[] }
    ids.forEach((id) => {
        const c = P(id);
        const m = c.motherId && people[c.motherId] ? c.motherId : null;
        const f = c.fatherId && people[c.fatherId] ? c.fatherId : null;
        if (!m && !f) return;
        const fkey = [m, f].filter(Boolean).sort().join('+');
        if (!families.has(fkey)) families.set(fkey, { m, f, children: [] });
        families.get(fkey).children.push(id);
    });
    families.forEach((fam) => {
        const { m, f, children } = fam;
        const partners = [m, f].filter(Boolean);
        const parentLayer = Math.max(...partners.map((p) => layerOf[p]));
        const parentY = yOf(parentLayer);
        let junctionX;
        if (m && f) {
            const xm = nodes[m].x,
                xf = nodes[f].x;
            const lo = Math.min(xm, xf),
                hi = Math.max(xm, xf);
            connectors.mating.push({ x1: lo + r, y1: parentY, x2: hi - r, y2: parentY });
            junctionX = (xm + xf) / 2;
        } else {
            junctionX = nodes[partners[0]].x;
        }
        const near = children.filter((c) => layerOf[c] === parentLayer + 1);
        const far = children.filter((c) => layerOf[c] > parentLayer + 1);
        if (near.length) {
            const busY = parentY + opt.layerGap * 0.55;
            connectors.drop.push({ x: junctionX, y1: parentY + (m && f ? 0 : r), y2: busY });
            const xs = near.map((c) => nodes[c].x);
            const lo = Math.min(...xs, junctionX),
                hi = Math.max(...xs, junctionX);
            if (near.length > 1 || xs[0] !== junctionX) connectors.sibship.push({ x1: lo, x2: hi, y: busY });
            near.forEach((c) => connectors.childLink.push({ x: nodes[c].x, y1: busY, y2: nodes[c].y - r }));
        }
        far.forEach((c) => {
            const via = (m && dummyChains[m + '->' + c]) ? m : (f && dummyChains[f + '->' + c] ? f : null);
            const pts = [
                [junctionX, parentY + (m && f ? 0 : r)]
            ];
            if (via)(dummyChains[via + '->' + c] || []).forEach((dk) => pts.push([x[dk], yOf(node[dk].layer)]));
            pts.push([nodes[c].x, nodes[c].y - r]);
            connectors.longEdge.push({ points: pts });
        });
    });

    // ---- 9. normalise to a top-left margin ----------------------------------
    const allX = ids.map((id) => nodes[id].x);
    const allY = ids.map((id) => nodes[id].y);
    const minX = Math.min(...allX),
        maxX = Math.max(...allX);
    const minY = Math.min(...allY),
        maxY = Math.max(...allY);
    const margin = 70;
    const sx = margin - minX,
        sy = margin - minY;
    ids.forEach((id) => { nodes[id].x += sx;
        nodes[id].y += sy; });
    connectors.mating.forEach((s) => { s.x1 += sx;
        s.x2 += sx;
        s.y1 += sy;
        s.y2 += sy; });
    connectors.drop.forEach((s) => { s.x += sx;
        s.y1 += sy;
        s.y2 += sy; });
    connectors.sibship.forEach((s) => { s.x1 += sx;
        s.x2 += sx;
        s.y += sy; });
    connectors.childLink.forEach((s) => { s.x += sx;
        s.y1 += sy;
        s.y2 += sy; });
    connectors.longEdge.forEach((e) => { e.points = e.points.map(([px, py]) => [px + sx, py + sy]); });

    const width = (maxX - minX) + margin * 2;
    const height = (maxY - minY) + margin * 2;
    const generations = {};
    ids.forEach((id) => (generations[id] = layerOf[id]));

    return { nodes, connectors, generations, bounds: { minX: 0, minY: 0, maxX: width, maxY: height, width, height } };
}

export default computePedigreeLayout;