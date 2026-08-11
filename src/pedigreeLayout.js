// pedigreeLayout.js  (engine v5 — family-unit model, layered DAG layout)
// ---------------------------------------------------------------------------
// Production-style genealogical pedigree layout engine.
//
// A pedigree is NOT a tree: every person has up to two biological parents, so
// the structure is a CONSTRAINED LAYERED DAG. Earlier versions of this engine
// grouped spouses via ad-hoc union-find over raw person ids. This version is
// built around a proper FAMILY-UNIT model instead — much closer to how real
// genealogy data (e.g. GEDCOM) is structured:
//
//   a Family = 1-2 parents + their children.
//
// Every person belongs to AT MOST one family as a child (their family of
// origin — you only have one mother and one father), and to zero or more
// families as a parent (remarriage, multiple partners). That single fact
// removes most of the special-casing the previous version needed.
//
// Pipeline:
//   1. buildFamilies         – derive Family units from motherId/fatherId and
//                              spouseIds; index family-of-origin & families-as-parent
//   2. computeBlocks         – pick each person's "primary" family (the one with
//                              the most children) to sit adjacent to in the chart
//   3. computeRowGroups      – union a family's two parents so they always end
//                              up sharing one generation row
//   4. assignGenerations     – longest-path layering over row-groups
//   5. buildLayeredGraph     – per-person nodes + dummy nodes for edges that
//                              skip a generation (e.g. adoption across generations)
//   6. orderLayers           – DFS seed (male-first couples) + barycenter sweeps
//                              to minimise edge crossings
//   7. assignCoordinates     – damped relaxation + overlap resolution: every
//                              node is pulled toward the average of its parents
//                              and children each pass (couples stay adjacent
//                              via the minimum-gap packing alone — see the
//                              comment above `damping` for why pulling co-
//                              parents together directly is unsafe), using a
//                              variable sibling-gap "separation" formula ported
//                              from family-chart's d3.tree() layout
//                              (github.com/donatso/family-chart): unrelated
//                              neighbours, half-siblings and people with several
//                              partners get extra breathing room. (family-chart's
//                              own CalculateTree is centred on one focal person
//                              and can't lay out a whole multi-family pedigree at
//                              once, so this engine keeps its own DAG pipeline
//                              and only borrows the spacing technique.)
//   8. buildFamilyConnectors – mating line, sibship bus, child drop-lines,
//                              routed through dummy waypoints for long edges
//   9. normalizeBounds       – shift everything to a top-left margin
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
    xPasses: 60, // coordinate relaxation passes
    margin: 70, // outer margin around the whole chart
    busYFactor: 0.55, // sibship bus line height, as a fraction of layerGap below the parents
    // family-chart-style separation() multipliers (see calculateTree in
    // donatso/family-chart) — extra fractions of nodeGap added between
    // neighbours that are not close blood relatives.
    unrelatedGapFactor: 0.25, // neighbours that share no parent
    halfSiblingGapFactor: 0.125, // share one parent but not both
    spouseGapFactor: 0.5, // extra room per partner-family a neighbour anchors
};

const EMPTY_LAYOUT = {
    nodes: {},
    connectors: { mating: [], drop: [], sibship: [], childLink: [], longEdge: [] },
    generations: {},
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
};

// ---- minimal union-find, used only to keep a couple on one shared row -----
function makeDSU() {
    const parent = new Map();
    const find = (x) => {
        if (!parent.has(x)) parent.set(x, x);
        let r = x;
        while (parent.get(r) !== r) r = parent.get(r);
        while (parent.get(x) !== r) {
            const n = parent.get(x);
            parent.set(x, r);
            x = n;
        }
        return r;
    };
    const union = (a, b) => {
        const ra = find(a),
            rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
    };
    return { find, union };
}

// ---- stage 1: family units --------------------------------------------------
// A Family is 1-2 parents + their children. Built once from motherId/fatherId
// (family of origin) and spouseIds (so a childless couple still gets a mating
// line); the two sources are unified by keying on the sorted parent-id set, so
// a couple that both share children AND are marked as spouses map to the same
// Family rather than being recorded twice.
function buildFamilies(people, ids) {
    const families = new Map(); // key -> Family
    const familyKey = (parentIds) => parentIds.filter(Boolean).sort().join('+');
    const getOrCreateFamily = (parentIds) => {
        const validParents = [...new Set(parentIds.filter((pid) => pid && people[pid]))];
        const key = familyKey(validParents);
        if (!key) return null;
        if (!families.has(key)) families.set(key, { id: 'F:' + key, parents: validParents, children: [] });
        return families.get(key);
    };

    ids.forEach((id) => {
        const p = people[id];
        const fam = getOrCreateFamily([p.motherId, p.fatherId]);
        if (fam) fam.children.push(id);
    });
    ids.forEach((id) => {
        (people[id].spouseIds || []).forEach((sid) => getOrCreateFamily([id, sid]));
    });

    const familyOfOrigin = {}; // personId -> Family | undefined
    const familiesAsParent = {}; // personId -> Family[]
    families.forEach((fam) => {
        fam.children.forEach((cid) => { familyOfOrigin[cid] = fam; });
        fam.parents.forEach((pid) => { (familiesAsParent[pid] = familiesAsParent[pid] || []).push(fam); });
    });

    return { families, familyOfOrigin, familiesAsParent };
}

// ---- stage 2: each person's "primary" family — who they sit adjacent to ---
// A person can be a parent in several families (remarriage); only one can be
// their physical neighbour in the chart, so the family with the most children
// wins (ties broken by family id for determinism). Other partners are still
// pulled toward them by the coordinate relaxation stage and still get their
// own full set of connectors — they just aren't guaranteed hard adjacency.
function computeBlocks(ids, familiesAsParent) {
    const blockOf = {};
    ids.forEach((id) => {
        const fams = familiesAsParent[id] || [];
        if (fams.length === 0) { blockOf[id] = 'P:' + id; return; }
        let primary = fams[0];
        fams.forEach((f) => {
            if (f.children.length > primary.children.length) primary = f;
            else if (f.children.length === primary.children.length && f.id < primary.id) primary = f;
        });
        blockOf[id] = primary.id;
    });
    return blockOf;
}

// ---- stage 3: a family's two parents always share one generation row -----
function computeRowGroups(ids, families) {
    const dsu = makeDSU();
    ids.forEach((id) => dsu.find(id));
    families.forEach((fam) => {
        if (fam.parents.length === 2) dsu.union(fam.parents[0], fam.parents[1]);
    });
    return (id) => dsu.find(id);
}

// ---- stage 4: longest-path generation layering (cycle-safe) ---------------
function assignGenerations(ids, families, rowGroupOf) {
    const groupEdges = new Map(); // gp -> Set(gc)
    const addEdge = (gp, gc) => {
        if (gp === gc) return;
        if (!groupEdges.has(gp)) groupEdges.set(gp, new Set());
        groupEdges.get(gp).add(gc);
    };
    families.forEach((fam) => {
        fam.parents.forEach((pid) => fam.children.forEach((cid) => addEdge(rowGroupOf(pid), rowGroupOf(cid))));
    });

    const groupIds = [...new Set(ids.map(rowGroupOf))];
    const layerG = new Map();
    groupIds.forEach((g) => layerG.set(g, 0));
    // iterative relaxation = longest path on a DAG; the iteration cap makes it
    // terminate gracefully even if consanguinity introduces a cycle.
    const cap = groupIds.length + 1;
    for (let it = 0; it < cap; it++) {
        let changed = false;
        for (const [gp, children] of groupEdges) {
            const lp = layerG.get(gp) || 0;
            for (const gc of children) {
                if ((layerG.get(gc) || 0) < lp + 1) {
                    layerG.set(gc, lp + 1);
                    changed = true;
                }
            }
        }
        if (!changed) break;
    }
    const layerOf = {};
    ids.forEach((id) => { layerOf[id] = layerG.get(rowGroupOf(id)) || 0; });
    return layerOf;
}

// ---- stage 5: layered graph — one node per person, dummies for long edges -
function buildLayeredGraph(people, ids, families, layerOf, blockOf) {
    const layers = {}; // layer -> [nodeKey]
    const node = {}; // nodeKey -> { key, kind, layer, person?, block }
    const pushLayer = (L, key) => { (layers[L] = layers[L] || []).push(key); };

    ids.forEach((id) => {
        const L = layerOf[id];
        const key = 'P:' + id;
        node[key] = { key, kind: 'person', layer: L, person: id, block: blockOf[id] };
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
    families.forEach((fam) => {
        fam.parents.forEach((parId) => {
            const Lp = layerOf[parId];
            fam.children.forEach((id) => {
                const Lc = layerOf[id];
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
    });

    const layerNums = Object.keys(layers).map(Number).sort((a, b) => a - b);
    return { layers, node, upAdj, downAdj, dummyChains, layerNums };
}

// ---- stage 6: initial DFS order + barycenter crossing minimisation --------
function orderLayers(people, ids, familyOfOrigin, { layers, node, upAdj, downAdj, layerNums }, opt) {
    const order = {};

    // 6a. seed order via DFS from roots, keeping each couple block adjacent.
    // family-chart convention: within a couple, male sits left, female right.
    const genderRank = (k) => {
        const pid = node[k].person;
        if (!pid) return 1;
        const sex = people[pid].sex;
        return sex === 'male' ? 0 : sex === 'female' ? 2 : 1;
    };
    const placed = new Set();
    const seq = {};
    layerNums.forEach((L) => (seq[L] = []));
    const stack = [];
    const pushBlock = (key) => {
        if (placed.has(key)) return;
        const blk = node[key].block;
        const L = node[key].layer;
        const members = layers[L]
            .filter((k) => node[k].block === blk && !placed.has(k))
            .sort((a, b) => genderRank(a) - genderRank(b));
        members.forEach((k) => {
            placed.add(k);
            seq[L].push(k);
        });
        // descend (push children so they are visited near their parents)
        for (let i = members.length - 1; i >= 0; i--) {
            (downAdj[members[i]] || []).forEach((ch) => stack.push(ch));
        }
    };
    const roots = ids
        .filter((id) => !familyOfOrigin[id])
        .sort((a, b) => (node['P:' + a].layer - node['P:' + b].layer) ||
            String(people[a].name || '').localeCompare(String(people[b].name || '')))
        .map((id) => 'P:' + id);
    roots.forEach((rk) => {
        stack.push(rk);
        while (stack.length) pushBlock(stack.pop());
    });
    // leftovers (orphans / cycle remnants)
    layerNums.forEach((L) => layers[L].forEach((k) => {
        if (!placed.has(k)) {
            placed.add(k);
            seq[L].push(k);
        }
    }));
    layerNums.forEach((L) => {
        layers[L] = seq[L];
        seq[L].forEach((k, i) => (order[k] = i));
    });

    // 6b. barycenter sweeps: reorder each layer toward the average position of
    // its neighbours in the layer above/below, alternating direction, while
    // keeping couple blocks glued together.
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
}

// ---- stage 7: x coordinates — damped relaxation + de-overlap --------------
function assignCoordinates(people, familyOfOrigin, familiesAsParent, { node, layers, upAdj, downAdj, layerNums }, opt) {
    // family-chart's calculateTree() spaces siblings with a separation()
    // multiplier instead of a flat gap: 1 normally, +.25 if the pair shares no
    // parent, +.125 if they share only one parent (half-siblings), plus extra
    // room per partner-family either neighbour anchors. Ported here as
    // fractions of nodeGap.
    const sharesParent = (aId, bId) => {
        const fa = familyOfOrigin[aId],
            fb = familyOfOrigin[bId];
        return !!fa && !!fb && fa.parents.some((p) => fb.parents.includes(p));
    };
    const sharesBothParents = (aId, bId) => {
        const fa = familyOfOrigin[aId];
        return !!fa && fa === familyOfOrigin[bId];
    };
    const spouseFamilyCountOf = (key) => {
        const pid = node[key].person;
        return pid ? (familiesAsParent[pid] || []).length : 0;
    };
    const gapBetween = (prevKey, k) => {
        if (node[k].block === node[prevKey].block && node[k].kind === 'person' && node[prevKey].kind === 'person') {
            return opt.coupleGap;
        }
        let offset = 1;
        if (node[k].kind === 'person' && node[prevKey].kind === 'person') {
            const prevId = node[prevKey].person,
                curId = node[k].person;
            const related = sharesParent(prevId, curId);
            if (!related) offset += opt.unrelatedGapFactor;
            else if (!sharesBothParents(prevId, curId)) offset += opt.halfSiblingGapFactor;
            offset += (spouseFamilyCountOf(prevKey) + spouseFamilyCountOf(k)) * opt.spouseGapFactor;
        }
        return opt.nodeGap * offset;
    };

    const x = {};
    layerNums.forEach((L) => {
        let cx = 0;
        layers[L].forEach((k, i) => {
            if (i > 0) cx += gapBetween(layers[L][i - 1], k);
            x[k] = cx;
        });
    });

    // Overlap resolver: pack left-to-right, pushing a node just far enough right
    // to satisfy the minimum gap from its left neighbour. A single sweep per
    // layer is enough to remove every overlap in that layer — each check uses
    // the neighbour's just-updated position, so a push cascades through the
    // whole row in one pass.
    //
    // This deliberately runs ONCE, after ALL blend passes below, not inside the
    // per-pass loop. Blend pulls every node toward the average of its relatives
    // each pass; for any node NOT involved in the pull (or an entire connected
    // group of them), that average is translation-invariant — shifting the whole
    // group by a constant leaves every average, and so every blend step, exactly
    // unchanged. Packing is the only step that isn't translation-invariant: it
    // clamps against an absolute minimum gap. If a gap keeps getting violated
    // pass after pass — blend keeps pulling a node one way, the minimum gap
    // requires the other — packing only ever pushes right, never left, so
    // running it every pass keeps adding the same small correction with nothing
    // to cancel it, and an entire connected side of the chart drifts sideways
    // without bound over enough passes. Confining packing to a single pass at
    // the end still guarantees a collision-free result, just without an
    // opportunity to accumulate.
    const resolve = (L) => {
        const keys = layers[L];
        for (let i = 1; i < keys.length; i++) {
            const need = x[keys[i - 1]] + gapBetween(keys[i - 1], keys[i]);
            if (x[keys[i]] < need) x[keys[i]] = need;
        }
    };

    // Damped relaxation: pull every node toward the plain average of its own
    // parents and children, each pass. This is the one part of the whole
    // pipeline that has to stay a PURE average of each node's OWN current
    // neighbours — nothing else — because that's what keeps it bounded: a
    // node's new position is always a weighted blend of its old position and
    // its neighbours' current positions, so it can never end up outside the
    // range its neighbours already occupy. Two tempting variations both break
    // that guarantee and were tried and reverted: pulling same-layer co-parents
    // together directly (on top of their own parent/child pulls) lets a hub
    // with two marriages average partly against copies of its own position;
    // moving a couple as one rigid unit toward their COMBINED neighbour average
    // shifts each member by a fixed offset from that average, which can land
    // outside the neighbours' range by design. Both look reasonable per pass,
    // but compound over many passes into unbounded drift for exactly the kind
    // of family (remarriage, or an unrelated person sharing a generation) this
    // engine has to support. Couples still end up adjacent — resolve() below
    // enforces coupleGap as a hard minimum regardless of what blend does.
    const allKeys = Object.keys(node);
    const damping = 0.6;
    for (let pass = 0; pass < opt.xPasses; pass++) {
        const target = {};
        for (const k of allKeys) {
            const ups = upAdj[k] || [],
                downs = downAdj[k] || [];
            let sum = 0,
                cnt = 0;
            for (const a of ups) { sum += x[a]; cnt++; }
            for (const a of downs) { sum += x[a]; cnt++; }
            target[k] = cnt ? sum / cnt : x[k];
        }
        for (const k of allKeys) x[k] = x[k] * (1 - damping) + target[k] * damping;
    }
    layerNums.forEach(resolve); // single collision-free pass, see comment above

    return x;
}

// ---- stage 8: family connectors — mating line, sibship bus, child drops ---
// Every connector is derived directly from the Family units, independent of
// how x was computed, so it stays correct even if the coordinate stage changes.
function buildFamilyConnectors(families, layerOf, nodeXY, dummyChains, node, x, opt) {
    const yOf = (L) => L * opt.layerGap;
    const r = opt.nodeRadius;
    const connectors = { mating: [], drop: [], sibship: [], childLink: [], longEdge: [] };

    families.forEach(({ parents, children }) => {
        if (parents.length === 0) return;
        const parentLayer = Math.max(...parents.map((p) => layerOf[p]));
        const parentY = yOf(parentLayer);
        const junctionX = addMatingLine(parents, parentY);

        const near = children.filter((c) => layerOf[c] === parentLayer + 1);
        const far = children.filter((c) => layerOf[c] > parentLayer + 1);
        const dropStartY = parentY + (parents.length === 2 ? 0 : r);
        if (near.length) addNearChildren({ junctionX, parentY, dropStartY, near });
        far.forEach((c) => addFarChild({ junctionX, dropStartY, parents, c }));
    });

    return connectors;

    function addMatingLine(parents, parentY) {
        if (parents.length === 2) {
            const [a, b] = parents;
            const xa = nodeXY[a].x,
                xb = nodeXY[b].x;
            const lo = Math.min(xa, xb),
                hi = Math.max(xa, xb);
            connectors.mating.push({ x1: lo + r, y1: parentY, x2: hi - r, y2: parentY });
            return (xa + xb) / 2;
        }
        return nodeXY[parents[0]].x;
    }

    function addNearChildren({ junctionX, parentY, dropStartY, near }) {
        const busY = parentY + opt.layerGap * opt.busYFactor;
        connectors.drop.push({ x: junctionX, y1: dropStartY, y2: busY });
        const xs = near.map((c) => nodeXY[c].x);
        const lo = Math.min(...xs, junctionX),
            hi = Math.max(...xs, junctionX);
        if (near.length > 1 || xs[0] !== junctionX) connectors.sibship.push({ x1: lo, x2: hi, y: busY });
        near.forEach((c) => connectors.childLink.push({ x: nodeXY[c].x, y1: busY, y2: nodeXY[c].y - r }));
    }

    function addFarChild({ junctionX, dropStartY, parents, c }) {
        const via = parents.find((p) => dummyChains[p + '->' + c]) || null;
        const points = [[junctionX, dropStartY]];
        if (via) (dummyChains[via + '->' + c] || []).forEach((dk) => points.push([x[dk], yOf(node[dk].layer)]));
        points.push([nodeXY[c].x, nodeXY[c].y - r]);
        connectors.longEdge.push({ points });
    }
}

// ---- stage 9: shift everything to a top-left margin ------------------------
function normalizeBounds(ids, nodes, connectors, opt) {
    const allX = ids.map((id) => nodes[id].x);
    const allY = ids.map((id) => nodes[id].y);
    const minX = Math.min(...allX),
        maxX = Math.max(...allX);
    const minY = Math.min(...allY),
        maxY = Math.max(...allY);
    const margin = opt.margin;
    const dx = margin - minX,
        dy = margin - minY;

    ids.forEach((id) => { nodes[id].x += dx; nodes[id].y += dy; });
    connectors.mating.forEach((s) => { s.x1 += dx; s.x2 += dx; s.y1 += dy; s.y2 += dy; });
    connectors.drop.forEach((s) => { s.x += dx; s.y1 += dy; s.y2 += dy; });
    connectors.sibship.forEach((s) => { s.x1 += dx; s.x2 += dx; s.y += dy; });
    connectors.childLink.forEach((s) => { s.x += dx; s.y1 += dy; s.y2 += dy; });
    connectors.longEdge.forEach((e) => { e.points = e.points.map(([px, py]) => [px + dx, py + dy]); });

    const width = (maxX - minX) + margin * 2;
    const height = (maxY - minY) + margin * 2;
    return { minX: 0, minY: 0, maxX: width, maxY: height, width, height };
}

export function computePedigreeLayout(data, options = {}) {
    const opt = { ...DEFAULTS, ...options };
    const people = (data && data.people) ? data.people : {};
    const ids = Object.keys(people);
    if (ids.length === 0) return EMPTY_LAYOUT;

    const { families, familyOfOrigin, familiesAsParent } = buildFamilies(people, ids);
    const blockOf = computeBlocks(ids, familiesAsParent);
    const rowGroupOf = computeRowGroups(ids, families);
    const layerOfId = assignGenerations(ids, families, rowGroupOf);
    const graph = buildLayeredGraph(people, ids, families, layerOfId, blockOf);
    orderLayers(people, ids, familyOfOrigin, graph, opt);
    const x = assignCoordinates(people, familyOfOrigin, familiesAsParent, graph, opt);

    const nodes = {};
    ids.forEach((id) => { nodes[id] = { x: x['P:' + id], y: layerOfId[id] * opt.layerGap }; });

    const connectors = buildFamilyConnectors(families, layerOfId, nodes, graph.dummyChains, graph.node, x, opt);
    const bounds = normalizeBounds(ids, nodes, connectors, opt);

    const generations = {};
    ids.forEach((id) => (generations[id] = layerOfId[id]));

    return { nodes, connectors, generations, bounds };
}

export default computePedigreeLayout;
