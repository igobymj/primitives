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
import { generateSmudgeVariance, renderFountainPenLine, DEFAULT_SEGMENTS, lerpSmudge } from "./fountainPen.js";

// Per-feature base jitter amounts (all multiplied by the per-instance scalar).
// The body's smooth out-of-round comes from harmonic deformation; per-vertex
// jitter (the old "twitchy" effect) layers on top via VERTEX_JITTER_SCALE.
const VERTEX_JITTER_SCALE = 5.0; // ±2.5 * jitter px peak vertex bump
const TICK_RADIAL_JITTER = 1.5;  // drift along arm direction
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
        // Two complementary "wobble" channels:
        //   __deformation — slow, smooth out-of-round shape from low harmonics
        //                   (always visible; what a confident pen stroke gives).
        //   __jitter      — fast per-vertex random offsets layered on top;
        //                   used by the animation pipeline (e.g. food activation)
        //                   to make the creature visibly twitch.
        this.__deformation = params.deformation ?? 1.0;
        this.__jitter = params.jitter ?? 0;
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
        //   [{ id, p1, p2, strokeWeight, penEffect, smudgePrev, smudgeNext }]
        this.__lines = [];
        this.__lineIdCounter = 0;
        this.__selectedLine = null;

        // Animated-jitter state. interval=0 disables. When smoothJitter is
        // off, each tick snaps to a new random state (boiling). When on, the
        // creature drifts linearly from prev → next across the interval.
        this.__jitterAnimateInterval = 0;
        this.__smoothJitter = false;
        this.__animT0 = performance.now();
    }

    addLine(p1, p2) {
        // Initialize prev = next so a brand new line doesn't animate yet; the
        // next animation tick will set prev = current next and pick a new next,
        // and from then on it drifts/snaps with the rest of the creature.
        const smudge = generateSmudgeVariance();
        const line = {
            id: ++this.__lineIdCounter,
            p1: { x: p1.x, y: p1.y },
            p2: { x: p2.x, y: p2.y },
            strokeWeight: this.__strokeWeight,
            // Per-line fountain-pen intensity. 0 = pure crisp line; 1 = default;
            // 2 = exaggerated. Set independently per line via the editor.
            penEffect: 1.0,
            // Per-line path wobble. Inherits from the creature's deformation
            // (the "amount of pen wobble" baseline) so a freshly drawn line
            // matches its surroundings; the editor can adjust it independently.
            jitter: this.__deformation,
            // Number of segments the line is split into (frequency of wobble).
            segments: DEFAULT_SEGMENTS,
            // When true, segment widths are randomized rather than equal.
            randomSegmentLengths: false,
            smudgePrev: smudge,
            smudgeNext: smudge,
        };
        this.__lines.push(line);
        return line;
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

    // Snap body + arms to a freshly generated state. Both prev and next are
    // set to the same state, so animation has no transition until the next
    // tick advances prev → next.
    _bake() {
        this.__arms = this.__armSpecs.map((arm) => this._materializeArm(arm));
        const newState = this._generateBodyState();
        this.__bodyStatePrev = newState;
        this.__bodyState = newState;
        this.__animT0 = performance.now();
    }

    _generateBodyState() {
        const vertices = this._materializeBody(this.__bodyRadius);
        const strokeNoise = Array.from(
            { length: vertices.length },
            () => Math.random() * 2 - 1
        );
        return { vertices, strokeNoise };
    }

    // Advance the animation by one tick if the interval has elapsed. Sets
    // prev = current next and picks a new next for body + each line; also
    // re-rolls arms (snap only — arms don't interpolate).
    _advanceAnim(now) {
        const interval = this.__jitterAnimateInterval;
        if (interval <= 0) return;
        const elapsed = now - this.__animT0;
        if (elapsed < interval) return;

        this.__bodyStatePrev = this.__bodyState;
        this.__bodyState = this._generateBodyState();
        for (const ln of this.__lines) {
            ln.smudgePrev = ln.smudgeNext;
            ln.smudgeNext = generateSmudgeVariance();
        }
        // Arms snap with the cycle (no prev/next interpolation for ticks).
        this.__arms = this.__armSpecs.map((arm) => this._materializeArm(arm));
        this.__animT0 = now;
    }

    // 0..1 phase between prev and next, linear. Returns 1 when not animating
    // or when smooth jitter is off (renderers use next state directly).
    _currentPhase() {
        const interval = this.__jitterAnimateInterval;
        if (interval <= 0 || !this.__smoothJitter) return 1;
        const elapsed = performance.now() - this.__animT0;
        return Math.min(Math.max(elapsed / interval, 0), 1);
    }

    _lerpVerts(a, b, t) {
        const out = new Array(a.length);
        for (let i = 0; i < a.length; i++) {
            out[i] = { x: a[i].x + (b[i].x - a[i].x) * t, y: a[i].y + (b[i].y - a[i].y) * t };
        }
        return out;
    }
    _lerpArr(a, b, t) {
        const out = new Array(a.length);
        for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
        return out;
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
        const d = this.__deformation;
        const j = this.__jitter;
        const count = 16;
        const verts = [];
        // Smooth deformation: sum of low harmonics with random phases. 1st
        // harmonic gives ovality, 2nd a gentle pinch, 3rd a 3-lobe lean.
        // Amplitude scales with radius so larger creatures deform
        // proportionally. This is the "confident pen stroke" look.
        const amp = d * r * 0.08;
        const a1 = amp * (0.7 + Math.random() * 0.6);
        const a2 = amp * (0.3 + Math.random() * 0.3);
        const a3 = amp * (0.1 + Math.random() * 0.2);
        const phi1 = Math.random() * 2 * Math.PI;
        const phi2 = Math.random() * 2 * Math.PI;
        const phi3 = Math.random() * 2 * Math.PI;
        // Per-vertex random jitter layered on top — twitchy bumps. Used by
        // the animation pipeline to make food-activation visible. At j=0
        // this contributes nothing.
        const vertexAmp = j * VERTEX_JITTER_SCALE;
        for (let i = 0; i < count; i++) {
            const a = (i * 2 * Math.PI) / count;
            const harmonic = a1 * Math.sin(a + phi1)
                           + a2 * Math.sin(2 * a + phi2)
                           + a3 * Math.sin(3 * a + phi3);
            const bump = (Math.random() - 0.5) * vertexAmp;
            const rr = r + harmonic + bump;
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

    // Editor hooks — both deformation and jitter are scalars; setting either
    // re-bakes so slider tweaks are visible immediately.
    get deformation() { return this.__deformation; }
    set deformation(v) {
        this.__deformation = v;
        this._bake();
    }

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
        this.__animT0 = performance.now();
    }

    get smoothJitter() { return this.__smoothJitter; }
    set smoothJitter(v) { this.__smoothJitter = v; }

    // Update jitter/interval/smooth without rebaking the body or resetting the
    // animation clock — used by per-frame drivers (e.g. food activation) that
    // would otherwise wipe out the smooth-interpolation cycle by triggering a
    // fresh _bake() on every value change.
    applyJitterAnimation(jitter, interval, smooth) {
        this.__jitter = jitter;
        this.__jitterAnimateInterval = interval;
        this.__smoothJitter = smooth;
    }

    // Snap to a brand-new state for body, arms, and all line smudges. Resets
    // the phase to 0 — useful as "force immediate randomize" while animation
    // is on (drift starts from the new state).
    reroll() {
        this._bake();
        for (const ln of this.__lines) {
            const newSmudge = generateSmudgeVariance();
            ln.smudgePrev = newSmudge;
            ln.smudgeNext = newSmudge;
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
            this._advanceAnim(performance.now());
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
        const phase = this._currentPhase();
        for (const ln of this.__lines) {
            const smudge = (phase === 1 || ln.smudgePrev === ln.smudgeNext)
                ? ln.smudgeNext
                : lerpSmudge(ln.smudgePrev, ln.smudgeNext, phase);
            renderFountainPenLine(
                p, ln, smudge, this.__strokeColor,
                ln.jitter ?? this.__deformation,
                ln === this.__selectedLine,
                this.__bodyRadius * 6,
            );
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
        const phase = this._currentPhase();
        const prev = this.__bodyStatePrev;
        const next = this.__bodyState;
        const verts = (phase === 1 || prev === next)
            ? next.vertices
            : this._lerpVerts(prev.vertices, next.vertices, phase);
        const noise = (phase === 1 || prev === next)
            ? next.strokeNoise
            : this._lerpArr(prev.strokeNoise, next.strokeNoise, phase);
        const n = verts.length;
        const sw = this.__strokeWeight;
        // Halved internally so slider 1.00 → 0.5 of the prior effect.
        const pe = this.__penEffect * 0.5;

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
        const noiseAmount = 0.30 * pe; // ±15% at slider 1, ±30% at slider 2 —
                                       // visibly uneven stroke for fountain-pen feel
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
