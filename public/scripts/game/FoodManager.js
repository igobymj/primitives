/*
 * FoodManager — scatters short horizontal/vertical line segments around the
 * canvas as "food" for creatures to consume. Active only while the app is in
 * play mode.
 *
 * Distribution uses Perlin-noise rejection sampling: random candidates are
 * accepted only when the noise field at that location exceeds a threshold,
 * producing organic clusters rather than uniform scatter.
 *
 * Contact: when a creature's body radius overlaps a food segment, the segment
 * is added as a new line on the creature in local space. Length and parallel
 * position are preserved; the perpendicular coordinate snaps to 0 when within
 * the editor's cardinal band (bodyRadius / 3), mirroring how the editor
 * places lines on click.
 */

import { generateSmudgeVariance, renderFountainPenLine } from "./fountainPen.js";

const TARGET_COUNT = 15;
const MIN_LENGTH = 24;
const MAX_LENGTH = 84;
// Reference length for jitter scaling — matches a default-radius creature
// (3 × diameter, with bodyRadius = 24).
const NOMINAL_LENGTH = 144;
const MIN_STROKE = 1.5;
const MAX_STROKE = 3.0;
const MIN_JITTER_AMP = 2.0;
const MAX_JITTER_AMP = 6.0;
const MIN_JITTER_FREQ = 4;
const MAX_JITTER_FREQ = 7;
// Each food line is rotated off its cardinal axis by a uniform random angle
// in this range (radians). Skew is preserved when the line is consumed.
const SKEW_RANGE_RAD = 3 * Math.PI / 180;
const PEN_EFFECT = 1.0;
// Activation: food is "ready to eat" when its line is within ACTIVATE_RADIUS
// body-radii of the creature center AND the food's orientation matches what
// the editor would place at that position relative to the creature.
const ACTIVATE_RADIUS_MULT = 2;
// While food is in range + legal, the creature body animates jitter to signal
// "ready to eat". Amplitude (jitter scalar) and frequency (shorter interval)
// both ramp linearly from 0 at the outer activation edge to their maxima at
// the body edge: jitter goes 0 → CREATURE_MAX_JITTER, interval goes
// CREATURE_MAX_INTERVAL_MS → CREATURE_MIN_INTERVAL_MS. Inside the body (or for
// any nearer reading) the maxima clamp.
const CREATURE_MAX_JITTER = 1.5;
const CREATURE_MAX_INTERVAL_MS = 240; // slowest, just inside activation range
const CREATURE_MIN_INTERVAL_MS = 60;  // fastest, when food touches the body
const NOISE_SCALE = 0.006;
const NOISE_THRESHOLD = 0.45;
const MAX_TRIES_PER_ITEM = 20;
const EDGE_MARGIN = 24;

export default class FoodManager {
    constructor(gameSession, creatureManager) {
        this.gameSession = gameSession;
        this.creatureManager = creatureManager;
        this.items = [];
        this.enabled = false;
        // Deferred spawn flag: spawning needs canvas dimensions, which aren't
        // set until p5's setup runs. enable() flags; update() spawns lazily.
        this._needsSpawn = false;
        // Stroke color for food — cached on first render once p5 is ready.
        this._strokeColor = null;
        // Creatures whose jitter is currently being driven by nearby active
        // food, paired with their pre-override settings so we can restore them.
        this._animatedCreatures = new Map();
    }

    enable() {
        this.enabled = true;
        this._needsSpawn = true;
    }

    disable() {
        this.enabled = false;
        this.items = [];
        this._needsSpawn = false;
        // Restore any creatures we were driving.
        for (const [c, baseline] of this._animatedCreatures) {
            this._restoreCreature(c, baseline);
        }
        this._animatedCreatures.clear();
    }

    _spawn() {
        const p = this.gameSession.p5;
        const w = this.gameSession.canvasWidth;
        const h = this.gameSession.canvasHeight;
        if (!p || !p.noise || w <= 0 || h <= 0) return;
        p.noiseSeed(Math.floor(Math.random() * 100000));
        this.items = [];
        let placed = 0;
        const maxTries = TARGET_COUNT * MAX_TRIES_PER_ITEM;
        for (let tries = 0; tries < maxTries && placed < TARGET_COUNT; tries++) {
            const x = EDGE_MARGIN + Math.random() * (w - EDGE_MARGIN * 2);
            const y = EDGE_MARGIN + Math.random() * (h - EDGE_MARGIN * 2);
            if (p.noise(x * NOISE_SCALE, y * NOISE_SCALE) < NOISE_THRESHOLD) continue;
            const orientation = Math.random() < 0.5 ? 'h' : 'v';
            const length = MIN_LENGTH + Math.random() * (MAX_LENGTH - MIN_LENGTH);
            const strokeWeight = MIN_STROKE + Math.random() * (MAX_STROKE - MIN_STROKE);
            const jitter = MIN_JITTER_AMP + Math.random() * (MAX_JITTER_AMP - MIN_JITTER_AMP);
            // Frequency slider is integer segment count; pick uniformly inclusive.
            const segments = MIN_JITTER_FREQ + Math.floor(Math.random() * (MAX_JITTER_FREQ - MIN_JITTER_FREQ + 1));
            // Cardinal axis (0 for horizontal, π/2 for vertical) plus uniform
            // skew. Stored as a unit direction vector to avoid trig per frame.
            const baseAngle = orientation === 'h' ? 0 : Math.PI / 2;
            const angle = baseAngle + (Math.random() * 2 - 1) * SKEW_RANGE_RAD;
            const dx = Math.cos(angle);
            const dy = Math.sin(angle);
            this.items.push({
                x, y, orientation, length, strokeWeight, jitter, segments,
                dx, dy,
                smudge: generateSmudgeVariance(),
                active: false,
                activeCreature: null,
            });
            placed++;
        }
    }

    update() {
        if (!this.enabled) return;
        if (this._needsSpawn) {
            this._spawn();
            this._needsSpawn = false;
        }
        const creatures = this.creatureManager.creatures;
        // Pass 1: compute per-food activation. Per triggered creature, remember
        // the closest active food's distance so jitter can scale with proximity.
        const creatureMinDist = new Map();
        for (const f of this.items) {
            f.active = false;
            f.activeCreature = null;
            if (creatures.length === 0) continue;
            const p1 = this._p1(f);
            const p2 = this._p2(f);
            for (const c of creatures) {
                const d = this._distanceToSegment(c.position.x, c.position.y, p1, p2);
                if (d > c.bodyRadius * ACTIVATE_RADIUS_MULT) continue;
                if (!this._isLegal(f, c)) continue;
                f.active = true;
                f.activeCreature = c;
                const prev = creatureMinDist.get(c);
                if (prev === undefined || d < prev) creatureMinDist.set(c, d);
                break;
            }
        }
        // Pass 2: drive creature jitter scaled by proximity. Capture baselines
        // on first activation, push live values each frame (applyJitterAnimation
        // bypasses the rebake-on-set behavior so smooth interpolation keeps
        // running between cycles).
        for (const [c, minD] of creatureMinDist) {
            if (!this._animatedCreatures.has(c)) {
                this._animatedCreatures.set(c, {
                    jitter: c.jitter,
                    interval: c.jitterAnimateInterval,
                    smooth: c.smoothJitter,
                });
            }
            const r = c.bodyRadius;
            // t = 0 at d = 2r, 1 at d = r and inside. Linear in between.
            const t = Math.max(0, Math.min(1, (2 * r - minD) / r));
            const jitter = t * CREATURE_MAX_JITTER;
            const interval = Math.round(
                CREATURE_MAX_INTERVAL_MS + (CREATURE_MIN_INTERVAL_MS - CREATURE_MAX_INTERVAL_MS) * t,
            );
            c.applyJitterAnimation(jitter, interval, true);
        }
        // Pass 3: restore creatures that no longer have active food, and drop
        // map entries for creatures that have been deleted from the world.
        for (const [c, baseline] of [...this._animatedCreatures]) {
            if (creatureMinDist.has(c) && creatures.includes(c)) continue;
            if (creatures.includes(c)) this._restoreCreature(c, baseline);
            this._animatedCreatures.delete(c);
        }
    }

    _restoreCreature(c, baseline) {
        c.jitter = baseline.jitter;
        c.jitterAnimateInterval = baseline.interval;
        c.smoothJitter = baseline.smooth;
    }

    // Spacebar handler — consumes every active food via the creature that
    // triggered it. Any food not currently active is ignored.
    keyPressed(key) {
        if (!this.enabled) return;
        if (key !== ' ') return;
        for (let i = this.items.length - 1; i >= 0; i--) {
            const f = this.items[i];
            if (f.active && f.activeCreature) {
                this._consume(f.activeCreature, f);
                this.items.splice(i, 1);
            }
        }
    }

    // Mirror of the editor's _startPendingLine snap rule: based on which
    // cardinal axis dominates the food's local position and whether it sits
    // inside the cardinal band (bodyRadius/3), decide which orientation the
    // editor would assign. Legal == matches the food's actual orientation.
    _isLegal(food, creature) {
        const lx = food.x - creature.position.x;
        const ly = food.y - creature.position.y;
        // Wider than the editor's r/3 cardinal band — at activation distance
        // (~2r) this opens the per-axis wedge from ~±9.5° to ~±18°, making
        // attachment forgiving of imprecise approach.
        const band = creature.bodyRadius * (2 / 3);
        const cardinalIsHorizontal = Math.abs(lx) >= Math.abs(ly);
        let expected;
        if (cardinalIsHorizontal) {
            expected = Math.abs(ly) <= band ? 'h' : 'v';
        } else {
            expected = Math.abs(lx) <= band ? 'v' : 'h';
        }
        return food.orientation === expected;
    }

    _consume(creature, food) {
        // Attach the food line at its exact current position and orientation
        // relative to the creature — no cardinal-axis snapping.
        const localCx = food.x - creature.position.x;
        const localCy = food.y - creature.position.y;
        const half = food.length / 2;
        const p1 = { x: localCx - food.dx * half, y: localCy - food.dy * half };
        const p2 = { x: localCx + food.dx * half, y: localCy + food.dy * half };
        const line = creature.addLine(p1, p2);
        // Carry the food's stroke weight, penEffect, and jitter profile onto
        // the new creature line so it looks continuous with what was just
        // being rendered as food.
        if (line) {
            line.strokeWeight = food.strokeWeight;
            line.penEffect = PEN_EFFECT;
            line.jitter = food.jitter;
            line.segments = food.segments;
        }
        // Fire the juice event so anything enabled in the juice editor
        // (shake / particles / timeSlow) triggers on attach. The particle
        // effector reads .position and .velocity off the trigger; creatures
        // don't carry a velocity, so we pass a wrapper.
        const jem = this.gameSession.juiceEventManager;
        if (jem) {
            jem.addNew('line attaches', {
                position: { x: creature.position.x, y: creature.position.y },
                velocity: { x: 0, y: 0 },
            });
        }
    }

    render() {
        if (!this.enabled || this.items.length === 0) return;
        const p = this.gameSession.p5;
        if (!this._strokeColor) this._strokeColor = p.color(20);
        p.push();
        p.strokeCap(p.ROUND);
        p.strokeJoin(p.ROUND);
        for (const f of this.items) {
            const ln = {
                p1: this._p1(f),
                p2: this._p2(f),
                strokeWeight: f.strokeWeight,
                penEffect: PEN_EFFECT,
                segments: f.segments,
            };
            renderFountainPenLine(p, ln, f.smudge, this._strokeColor, f.jitter, false, NOMINAL_LENGTH);
        }
        p.pop();
    }

    _p1(f) {
        const half = f.length / 2;
        return { x: f.x - f.dx * half, y: f.y - f.dy * half };
    }

    _p2(f) {
        const half = f.length / 2;
        return { x: f.x + f.dx * half, y: f.y + f.dy * half };
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
}
