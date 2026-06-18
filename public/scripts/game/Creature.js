/*
 * Creature — a primitive-based "amoeba" entity rendered in a hand-drawn style.
 *
 * A wobbly body circle with a pupil dot, surrounded by asymmetric "arms".
 * An arm is a series of rungs along a direction; each rung carries 1+ short
 * tick marks perpendicular(-ish) to the arm.
 *
 * `jitter` is a scalar (default 1.0) that scales all hand-drawn imperfection
 * — body wobble, tick angle/length/radial/overshoot drift, arm-angle drift.
 * Set to 0 for crisp geometric form, raise to ~2 for very chaotic.
 *
 * Mutating `jitter` re-bakes the random offsets so the change is visible
 * immediately. Call `reroll()` to re-bake without changing the amount —
 * useful for animation (call periodically for a "boiling" cartoon effect).
 *
 * Data model:
 *   arms: [{
 *     angle: number,         // radians (0 = right, -PI/2 = up)
 *     rungs: [{
 *       offset: number,      // distance from body center
 *       tickLength: number,
 *       ticks: number,       // 1 or 2 (parallel marks at this rung)
 *       tickSpacing: number, // perpendicular spacing for paired ticks
 *     }]
 *   }]
 */

import GameObject from "../engine/GameObject.js";

// Per-feature base jitter amounts (all multiplied by the per-instance scalar).
const BODY_JITTER = 2.0;        // wobble of body outline radius
const TICK_RADIAL_JITTER = 1.5; // drift along arm direction
const TICK_ANGLE_JITTER = 0.25; // radians off perpendicular
const TICK_LENGTH_JITTER = 2.0;
const TICK_OVERSHOOT = 1.0;     // extra at each end of a tick line
const ARM_ANGLE_JITTER = 0.06;  // arm angle drift from cardinal

export default class Creature extends GameObject {
    constructor(gameSession, x, y, params = {}) {
        const bodyRadius = params.bodyRadius ?? 22;
        const size = bodyRadius * 2;
        super(gameSession, x, y, size, size, 0, 1, 255);

        this.__bodyRadius = bodyRadius;
        this.__pupilRadius = params.pupilRadius ?? 3;
        this.__strokeWeight = params.strokeWeight ?? 2.2;

        this.__armSpecs = params.arms ?? this._defaultArms(bodyRadius);
        this.__jitter = params.jitter ?? 1.0;
        // Per-creature pen effect — drives stroke-weight noise on the body
        // outline only (no blob or halo on the body). Lines have their own.
        this.__penEffect = params.penEffect ?? 1.0;

        this._bake();

        this.__armStretch = new Array(this.__arms.length).fill(1);
        this.__targetStretch = new Array(this.__arms.length).fill(1);

        this.__fillColor = params.fillColor ?? this.p5.color(248, 244, 232);
        this.__strokeColor = params.strokeColor ?? this.p5.color(20);
        this.__grabbed = false;
        this.__selected = false;

        // User-drawn lines in local space:
        //   [{ id, p1: {x,y}, p2: {x,y}, strokeWeight }]
        this.__lines = [];
        this.__lineIdCounter = 0;
        this.__selectedLine = null;

        // Animated-jitter state (ms between rerolls; 0 disables)
        this.__jitterAnimateInterval = 0;
        this.__jitterLastReroll = performance.now();
    }

    addLine(p1, p2) {
        const line = {
            id: ++this.__lineIdCounter,
            p1: { x: p1.x, y: p1.y },
            p2: { x: p2.x, y: p2.y },
            strokeWeight: this.__strokeWeight,
            // Per-line fountain-pen intensity. 0 = pure crisp line; 1 = default;
            // 2 = exaggerated. Set independently per line via the editor.
            penEffect: 1.0,
            smudge: this._generateSmudgeVariance(),
        };
        this.__lines.push(line);
        return line;
    }

    // Per-line random profile for fountain-pen rendering. Re-roll on reroll().
    _generateSmudgeVariance() {
        const rand = (min, max) => min + Math.random() * (max - min);
        return {
            taperLenFactor: rand(0.55, 1.4),
            taperWidthFactor: rand(0.85, 1.25),
            // -0.45..0.45: asymmetric widening of the taper across the line axis.
            // Positive shifts widening toward +perp side; negative the opposite.
            taperSideBias: rand(-0.45, 0.45),
            // Blob at p2
            blobSizeFactor: rand(0.6, 1.1),
            blobOffsetPerp: rand(-0.4, 0.4),       // in strokeWeight units
            blobStretch: rand(0.85, 1.25),         // along-line stretch
            blobRotation: rand(-Math.PI / 5, Math.PI / 5),
            // Smaller touch at p1
            p1TouchFactor: rand(0.6, 1.1),
            p1TouchOffsetPerp: rand(-0.35, 0.35),
            // Halo at p2
            haloFactor: rand(0.8, 1.25),
            haloOffsetPerp: rand(-0.35, 0.35),
            // Subtle stroke-weight noise along the line — one value per segment.
            // Each in [-1, 1]; amplitude is scaled by penEffect at render time.
            strokeNoise: Array.from({ length: 6 }, () => rand(-1, 1)),
            // Perpendicular wobble at each interior segment boundary (5 = 6
            // segments minus 1). Each in [-1, 1]; amplitude is scaled by
            // jitter at half the body's BODY_JITTER amount at render time.
            pathJitter: Array.from({ length: 5 }, () => rand(-1, 1)),
        };
    }

    removeLine(line) {
        const idx = this.__lines.indexOf(line);
        if (idx >= 0) this.__lines.splice(idx, 1);
        if (this.__selectedLine === line) this.__selectedLine = null;
    }

    setSelectedLine(line) {
        this.__selectedLine = line;
    }

    // Returns the closest line within `tolerance` of (localX, localY), or null.
    lineAtPoint(localX, localY, tolerance = 8) {
        let best = null;
        let bestDist = tolerance;
        for (const ln of this.__lines) {
            const d = this._distanceToSegment(localX, localY, ln.p1, ln.p2);
            if (d <= bestDist) {
                bestDist = d;
                best = ln;
            }
        }
        return best;
    }

    _distanceToSegment(x, y, p1, p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 0.0001) {
            const ex = x - p1.x; const ey = y - p1.y;
            return Math.sqrt(ex * ex + ey * ey);
        }
        let t = ((x - p1.x) * dx + (y - p1.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const px = p1.x + t * dx;
        const py = p1.y + t * dy;
        const ex = x - px; const ey = y - py;
        return Math.sqrt(ex * ex + ey * ey);
    }

    get lines() { return this.__lines; }
    get selectedLine() { return this.__selectedLine; }

    /*
     * Default arm pattern — modeled on the larger sketch creature.
     * Asymmetry summary:
     *   Top    — 2 rungs, simple singles
     *   Right  — 3 rungs, one doubled in the middle
     *   Bottom — 2 rungs, simple singles
     *   Left   — 4 rungs, heavy: two doubled near body, then two singles
     *            extending furthest
     */
    _defaultArms(r) {
        return [
            // Top
            { angle: -Math.PI / 2, rungs: [
                { offset: r + 9,  tickLength: 6, ticks: 1 },
                { offset: r + 22, tickLength: 7, ticks: 1 },
            ]},
            // Right
            { angle: 0, rungs: [
                { offset: r + 9,  tickLength: 6, ticks: 1 },
                { offset: r + 21, tickLength: 8, ticks: 2, tickSpacing: 4 },
                { offset: r + 34, tickLength: 5, ticks: 1 },
            ]},
            // Bottom
            { angle: Math.PI / 2, rungs: [
                { offset: r + 9,  tickLength: 6, ticks: 1 },
                { offset: r + 22, tickLength: 7, ticks: 1 },
            ]},
            // Left — heaviest arm, extends furthest
            { angle: Math.PI, rungs: [
                { offset: r + 9,  tickLength: 9, ticks: 2, tickSpacing: 5 },
                { offset: r + 22, tickLength: 8, ticks: 2, tickSpacing: 4 },
                { offset: r + 35, tickLength: 6, ticks: 1 },
                { offset: r + 46, tickLength: 5, ticks: 1 },
            ]},
        ];
    }

    // Re-roll all jitter-driven random offsets (body verts + per-tick wobble)
    // using the current jitter amount. Also re-rolls per-segment body
    // stroke-weight noise used by the pen effect on the body outline.
    _bake() {
        this.__arms = this.__armSpecs.map((arm) => this._materializeArm(arm));
        this.__bodyVertices = this._materializeBody(this.__bodyRadius);
        this.__bodyStrokeNoise = Array.from(
            { length: this.__bodyVertices.length },
            () => Math.random() * 2 - 1
        );
    }

    _materializeArm(arm) {
        const j = this.__jitter;
        const angle = arm.angle + (Math.random() - 0.5) * ARM_ANGLE_JITTER * j;
        const rungs = arm.rungs.map((rung) => {
            const tickCount = rung.ticks ?? 1;
            const tickSpacing = rung.tickSpacing ?? 4;
            const ticks = [];
            for (let t = 0; t < tickCount; t++) {
                ticks.push({
                    perpOffset: tickCount === 1 ? 0 : (t - (tickCount - 1) / 2) * tickSpacing,
                    radialJitter: (Math.random() - 0.5) * TICK_RADIAL_JITTER * j,
                    angleJitter: (Math.random() - 0.5) * TICK_ANGLE_JITTER * j,
                    lengthJitter: (Math.random() - 0.5) * TICK_LENGTH_JITTER * j,
                    overshootA: Math.random() * TICK_OVERSHOOT * j,
                    overshootB: Math.random() * TICK_OVERSHOOT * j,
                });
            }
            return { offset: rung.offset, tickLength: rung.tickLength, ticks };
        });
        return { angle, rungs };
    }

    _materializeBody(r) {
        const j = this.__jitter;
        const count = 16;
        const verts = [];
        for (let i = 0; i < count; i++) {
            const a = (i * 2 * Math.PI) / count;
            const rr = r + (Math.random() - 0.5) * BODY_JITTER * j;
            verts.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
        }
        return verts;
    }

    get bodyRadius() { return this.__bodyRadius; }
    set bodyRadius(v) {
        this.__bodyRadius = v;
        // Re-bake body verts at the new radius. Existing lines keep their
        // local-space positions; inner/outer rings and the line-drawing band
        // scale automatically since they read from __bodyRadius.
        this._bake();
    }
    get position() { return this.__position; }
    get grabbed() { return this.__grabbed; }
    set grabbed(v) { this.__grabbed = v; }
    get selected() { return this.__selected; }
    set selected(v) { this.__selected = v; }

    // Inner ring — grab/select hit area. Slightly larger than the body so
    // clicks just outside a wobbly outline still register.
    get innerRingRadius() { return this.__bodyRadius + 6; }
    // Outer ring — legal region for new lines. Clicks here don't deselect.
    get outerRingRadius() { return this.__bodyRadius * 10; }

    // Editor hooks — jitter is a scalar; setting it re-bakes.
    get jitter() { return this.__jitter; }
    set jitter(v) {
        this.__jitter = v;
        this._bake();
    }

    get strokeWeight() { return this.__strokeWeight; }
    set strokeWeight(v) { this.__strokeWeight = v; }

    get penEffect() { return this.__penEffect; }
    set penEffect(v) { this.__penEffect = v; }

    get jitterAnimateInterval() { return this.__jitterAnimateInterval; }
    set jitterAnimateInterval(ms) {
        this.__jitterAnimateInterval = ms;
        this.__jitterLastReroll = performance.now();
    }

    // Re-roll all random offsets at the current jitter amount.
    // Call periodically (e.g. every 80–150ms) for a "boiling" cartoon effect.
    // Also re-rolls per-line smudge variance so lines animate with the rest.
    reroll() {
        this._bake();
        for (const ln of this.__lines) {
            ln.smudge = this._generateSmudgeVariance();
        }
    }

    containsPoint(x, y) {
        const dx = x - this.__position.x;
        const dy = y - this.__position.y;
        const r = this.innerRingRadius;
        return dx * dx + dy * dy <= r * r;
    }

    containsOuterRing(x, y) {
        const dx = x - this.__position.x;
        const dy = y - this.__position.y;
        const r = this.outerRingRadius;
        return dx * dx + dy * dy <= r * r;
    }

    reachToward(x, y) {
        const dx = x - this.__position.x;
        const dy = y - this.__position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.001) {
            this.__targetStretch.fill(1);
            return;
        }
        const reachRange = 120;
        const falloff = Math.max(0, 1 - Math.max(0, dist - this.__bodyRadius) / reachRange);
        for (let i = 0; i < this.__arms.length; i++) {
            const arm = this.__arms[i];
            const ax = Math.cos(arm.angle);
            const ay = Math.sin(arm.angle);
            const align = (ax * dx + ay * dy) / dist;
            const extra = Math.max(0, align) * falloff * 0.7;
            this.__targetStretch[i] = 1 + extra;
        }
    }

    relax() {
        this.__targetStretch.fill(1);
    }

    update() {
        const lerpSpeed = 0.18;
        for (let i = 0; i < this.__arms.length; i++) {
            this.__armStretch[i] += (this.__targetStretch[i] - this.__armStretch[i]) * lerpSpeed;
        }
        if (this.__jitterAnimateInterval > 0) {
            const now = performance.now();
            if (now - this.__jitterLastReroll >= this.__jitterAnimateInterval) {
                this.reroll();
                this.__jitterLastReroll = now;
            }
        }
    }

    render() {
        const p = this.p5;
        p.push();
        p.translate(this.__position.x, this.__position.y);
        p.rotate(this.__rotation);
        p.strokeCap(p.ROUND);
        p.strokeJoin(p.ROUND);

        this._renderArms(p);
        this._renderLines(p);
        this._renderBody(p);
        this._renderPupil(p);
        if (this.__selected) this._renderSelectionRing(p);

        p.pop();
    }

    _renderLines(p) {
        if (this.__lines.length === 0) return;
        for (const ln of this.__lines) {
            this._renderFountainPenLine(p, ln, ln === this.__selectedLine);
        }
    }

    /*
     * Fountain-pen rendering for a single line.
     *
     * Layers (back to front):
     *   1. Selection underlay (only if selected)
     *   2. Bleed halos at both endpoints (stronger at p2)
     *   3. Base line stroke
     *   4. Tapered widening along the last ~40% approaching p2
     *      — gives the "line widens as it approaches the point" feel
     *   5. Pooled ink blob at p2 (lift point) and smaller touch at p1
     *   6. Selection endpoint dots (only if selected)
     */
    _renderFountainPenLine(p, ln, isSelected) {
        if (!ln.smudge) ln.smudge = this._generateSmudgeVariance(); // safety net
        if (ln.penEffect == null) ln.penEffect = 1.0;                // safety net
        const sm = ln.smudge;
        const sw = ln.strokeWeight;
        // Halved internally so slider 1.00 → 0.5 of the prior effect.
        const pe = ln.penEffect * 0.5;
        const r = p.red(this.__strokeColor);
        const g = p.green(this.__strokeColor);
        const b = p.blue(this.__strokeColor);

        // Direction + perpendicular for the line
        const dx = ln.p2.x - ln.p1.x;
        const dy = ln.p2.y - ln.p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        let ux = 0, uy = 0, perpX = 0, perpY = 0;
        if (len > 0.001) {
            ux = dx / len; uy = dy / len;
            perpX = -uy;   perpY = ux;
        }

        // 1. Selection underlay
        if (isSelected) {
            p.noFill();
            p.stroke(60, 130, 200, 90);
            p.strokeWeight(sw + 6);
            p.line(ln.p1.x, ln.p1.y, ln.p2.x, ln.p2.y);
        }

        // 2. Bleed halos — slightly offset to one side. Scaled by pen effect.
        if (pe > 0.01) {
            const haloOX = perpX * sm.haloOffsetPerp * sw * pe;
            const haloOY = perpY * sm.haloOffsetPerp * sw * pe;
            p.noStroke();
            p.fill(r, g, b, 28);
            p.circle(ln.p2.x + haloOX, ln.p2.y + haloOY, sw * 4.2 * sm.haloFactor * pe);
            p.fill(r, g, b, 55);
            p.circle(ln.p2.x + haloOX * 0.5, ln.p2.y + haloOY * 0.5, sw * 2.6 * sm.haloFactor * pe);
            p.fill(r, g, b, 22);
            p.circle(ln.p1.x, ln.p1.y, sw * 2.4 * pe);
        }

        // 3. Base line — segmented, with per-segment strokeWeight noise (from
        // penEffect) and perpendicular path jitter at interior boundaries
        // (from creature.jitter, halved relative to the body). Endpoints stay
        // anchored at p1/p2; only intermediate vertices wobble. Round caps
        // hide the segment joins.
        p.noFill();
        p.stroke(this.__strokeColor);
        const noise = sm.strokeNoise;
        const segCount = noise.length;
        const noiseAmount = 0.10 * pe;
        const pathJitter = sm.pathJitter || [];
        const jitterAmount = 0.1 * this.__jitter * BODY_JITTER;
        let prevX = ln.p1.x, prevY = ln.p1.y;
        for (let i = 0; i < segCount; i++) {
            let nextX, nextY;
            if (i === segCount - 1) {
                nextX = ln.p2.x;
                nextY = ln.p2.y;
            } else {
                const t = (i + 1) / segCount;
                const baseX = ln.p1.x + dx * t;
                const baseY = ln.p1.y + dy * t;
                const off = (pathJitter[i] || 0) * jitterAmount;
                nextX = baseX + perpX * off;
                nextY = baseY + perpY * off;
            }
            p.strokeWeight(sw * (1 + noise[i] * noiseAmount));
            p.line(prevX, prevY, nextX, nextY);
            prevX = nextX;
            prevY = nextY;
        }

        // 4. Asymmetric tapered approach toward p2. All widths scaled by pen
        // effect — at pe=0 the polygon collapses to zero, at pe=1 it widens to
        // the default, at pe=2 it's dramatic.
        if (pe > 0.01 && len > sw * 2) {
            const taperLen = Math.min(len * 0.4 * sm.taperLenFactor, sw * 8 * sm.taperLenFactor);
            const totalW = sw * 1.7 * sm.taperWidthFactor * pe;
            const wEndA = totalW * (0.5 + sm.taperSideBias);
            const wEndB = totalW * (0.5 - sm.taperSideBias);
            const wBackA = sw * 1.0 * pe * (0.5 + sm.taperSideBias * 0.4);
            const wBackB = sw * 1.0 * pe * (0.5 - sm.taperSideBias * 0.4);
            const tBackX = ln.p2.x - ux * taperLen;
            const tBackY = ln.p2.y - uy * taperLen;

            p.noStroke();
            p.fill(this.__strokeColor);
            p.beginShape();
            p.vertex(tBackX + perpX * wBackA, tBackY + perpY * wBackA);
            p.vertex(tBackX - perpX * wBackB, tBackY - perpY * wBackB);
            p.vertex(ln.p2.x - perpX * wEndB, ln.p2.y - perpY * wEndB);
            p.vertex(ln.p2.x + perpX * wEndA, ln.p2.y + perpY * wEndA);
            p.endShape(p.CLOSE);
        }

        // 5. Asymmetric pooled blob at p2 and small touch at p1, scaled by pe.
        if (pe > 0.01) {
            p.noStroke();
            p.fill(this.__strokeColor);
            const blobR = sw * 1.0 * sm.blobSizeFactor * pe;
            const blobX = ln.p2.x + perpX * sm.blobOffsetPerp * sw * pe;
            const blobY = ln.p2.y + perpY * sm.blobOffsetPerp * sw * pe;
            const lineAngle = Math.atan2(uy, ux);
            p.push();
            p.translate(blobX, blobY);
            p.rotate(lineAngle + sm.blobRotation);
            p.ellipse(0, 0, blobR * 2 * sm.blobStretch, blobR * 2);
            p.pop();

            const p1OX = perpX * sm.p1TouchOffsetPerp * sw * pe;
            const p1OY = perpY * sm.p1TouchOffsetPerp * sw * pe;
            p.circle(ln.p1.x + p1OX, ln.p1.y + p1OY, sw * 0.85 * sm.p1TouchFactor * pe);
        }

        // 6. Selection endpoint dots
        if (isSelected) {
            p.fill(60, 130, 200, 230);
            p.circle(ln.p1.x, ln.p1.y, 6);
            p.circle(ln.p2.x, ln.p2.y, 6);
        }
    }

    _renderSelectionRing(p) {
        p.noFill();

        // Inner drag ring — matches the grab hit area.
        p.stroke(60, 130, 200, 220);
        p.strokeWeight(1.5);
        const dragR = this.innerRingRadius;
        p.circle(0, 0, dragR * 2);

        // Outer area ring — the legal region where new lines/arms may be added.
        // Clicks in this region preserve selection; they don't deselect.
        p.stroke(60, 130, 200, 110);
        p.strokeWeight(1);
        p.drawingContext.setLineDash([6, 5]);
        const areaR = this.outerRingRadius;
        p.circle(0, 0, areaR * 2);
        p.drawingContext.setLineDash([]);
    }

    _renderArms(p) {
        p.stroke(this.__strokeColor);
        p.strokeWeight(this.__strokeWeight);
        p.noFill();
        for (let i = 0; i < this.__arms.length; i++) {
            const arm = this.__arms[i];
            const stretch = this.__armStretch[i];
            const ax = Math.cos(arm.angle);
            const ay = Math.sin(arm.angle);
            const px = -ay; // perpendicular to arm direction
            const py = ax;
            for (const rung of arm.rungs) {
                for (const tick of rung.ticks) {
                    const r = (rung.offset + tick.radialJitter) * stretch;
                    const cx = ax * r + px * tick.perpOffset;
                    const cy = ay * r + py * tick.perpOffset;
                    const baseLen = (rung.tickLength + tick.lengthJitter) * stretch;
                    const halfA = baseLen * 0.5 + tick.overshootA;
                    const halfB = baseLen * 0.5 + tick.overshootB;
                    const tAngle = Math.atan2(py, px) + tick.angleJitter;
                    const tdx = Math.cos(tAngle);
                    const tdy = Math.sin(tAngle);
                    p.line(cx - tdx * halfA, cy - tdy * halfA, cx + tdx * halfB, cy + tdy * halfB);
                }
            }
        }
    }

    _renderBody(p) {
        const verts = this.__bodyVertices;
        const n = verts.length;
        const sw = this.__strokeWeight;
        // Halved internally so slider 1.00 → 0.5 of the prior effect.
        const pe = this.__penEffect * 0.5;
        const noise = this.__bodyStrokeNoise;

        // 1. Fill — single closed Catmull-Rom shape, no stroke.
        p.noStroke();
        p.fill(this.__fillColor);
        p.beginShape();
        p.curveVertex(verts[n - 1].x, verts[n - 1].y);
        for (let i = 0; i < n; i++) {
            p.curveVertex(verts[i].x, verts[i].y);
        }
        p.curveVertex(verts[0].x, verts[0].y);
        p.curveVertex(verts[1].x, verts[1].y);
        p.endShape();

        // 2. Outline — one Catmull-Rom segment per pair of adjacent verts,
        // each drawn with its own stroke weight so pen-effect noise modulates
        // along the perimeter. Round caps hide the segment joins.
        p.noFill();
        p.stroke(this.__strokeColor);
        const noiseAmount = 0.10 * pe; // ±10% at pe=1, ±20% at pe=2, 0 at pe=0
        for (let i = 0; i < n; i++) {
            const v0 = verts[(i - 1 + n) % n];
            const v1 = verts[i];
            const v2 = verts[(i + 1) % n];
            const v3 = verts[(i + 2) % n];
            p.strokeWeight(sw * (1 + noise[i] * noiseAmount));
            p.curve(v0.x, v0.y, v1.x, v1.y, v2.x, v2.y, v3.x, v3.y);
        }
    }

    _renderPupil(p) {
        p.fill(this.__strokeColor);
        p.noStroke();
        p.circle(0, 0, this.__pupilRadius * 2);
    }
}
