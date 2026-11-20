import config from "../../../firmware/playbook.json";

const { screen, spotlights } = config;
const f32 = Math.fround;
const tenth = f32(0.1);

export function decodeRle(bytes: Uint8Array, length: number): Uint8Array {
    if (bytes.length % 2 !== 0) throw new Error("Invalid RLE pair");
    const pixels = new Uint8Array(length);
    let offset = 0;
    for (let i = 0; i < bytes.length; i += 2) {
        const end = offset + bytes[i + 1];
        if (end > length) throw new Error("RLE overflow");
        pixels.fill(bytes[i], offset, end);
        offset = end;
    }
    if (offset !== length) throw new Error("RLE underflow");
    return pixels;
}

export function readSpawnTable(bytes: Uint8Array): Float32Array {
    if (bytes.byteLength !== 298 * 4) throw new Error("Invalid spawn table size");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Float32Array.from({ length: 298 }, (_, i) => {
        const value = view.getFloat32(i * 4, true);
        if (!(value >= 0 && value <= 1)) throw new Error("Invalid spawn coordinate");
        return value;
    });
}

function smooth(t: number) {
    return f32(f32(t * t) * f32(3 - f32(2 * t)));
}

export function createMotion(quadrant: Uint8Array, spawns: Float32Array, seed: number) {
    const { small, large, palette, paletteCycleSeconds } = spotlights;
    const { quadrantSize: half } = spotlights.light;
    const side = half * 2;
    function random() {
        seed = Math.imul(seed, 16807);
        return (seed & 0x7fffff) / 0x800000;
    }

    const light = new Uint8Array(side * side);
    for (let y = 0; y < half; y++) {
        for (let x = 0; x < half; x++) {
            const p = f32(quadrant[y * half + x] / 255);
            const lo = Math.min(1, f32(2.25 * p));
            const hi = Math.min(1, f32(2.5 * p));
            const value = Math.trunc(f32(255 * f32(p * f32(lo + f32(f32(hi - lo) * random())))));
            const top = y * side;
            const bottom = (side - 1 - y) * side;
            light[top + half - 1 - x] =
                light[top + half + x] =
                light[bottom + half - 1 - x] =
                light[bottom + half + x] =
                    value;
        }
    }

    const quads = Array.from({ length: small.count + large.count }, () => ({
        x: 0,
        y: 0,
        size: 0,
        r: 0,
        g: 0,
        b: 0,
        alpha: 0,
    }));
    const lights = quads.map(() => ({
        delay: 0,
        remaining: 0,
        x: 0,
        y: 0,
        size: 0,
        vx: 0,
        vy: 0,
        phase: 0,
        peak: 0,
    }));
    let cursor = 0;
    let colorSeconds = 0;
    const slope = f32(0.12000001966953278);
    const motionSeed = seed;

    function rewind() {
        seed = motionSeed;
        cursor = colorSeconds = 0;
        for (let i = 0; i < lights.length; i++) {
            const state = lights[i];
            state.delay =
                i < small.count ? f32(small.lifetimeSeconds * random()) : (i - small.count) * large.startDelaySeconds;
            state.remaining = state.x = state.y = state.size = state.vx = state.vy = state.phase = state.peak = 0;
            const quad = quads[i];
            quad.x = quad.y = quad.size = quad.r = quad.g = quad.b = quad.alpha = 0;
        }
    }
    rewind();

    function spawn(state: (typeof lights)[number], big: boolean) {
        const x = spawns[cursor];
        const y = spawns[cursor + 1];
        cursor = (cursor + 2) % spawns.length;
        const a = random(),
            b = random(),
            c = random(),
            d = random(),
            e = random();
        if (big) {
            state.x = f32(f32(f32(screen.width * x) - 350) * f32(0.6));
            state.y = f32(f32(screen.height * y) - 350);
            state.size = f32(700 + f32(300 * b));
            state.vx = f32(f32(6 * c) - 3);
            state.vy = f32(f32(6 * d) - 3);
            state.phase = f32(tenth + f32(tenth * e));
        } else {
            state.x = f32(f32(f32(screen.width * x) - 100) * f32(0.8));
            state.y = f32(f32(screen.height * y) - 100);
            state.size = f32(200 + f32(400 * a));
            state.vx = f32(f32(4 + f32(5 * b)) + f32(10 * f32(1 + f32(state.size / -600))));
            state.vy = f32(f32(6 * c) - 3);
            state.phase = f32(tenth * e);
        }
        state.peak = f32(f32(0.24) + f32(slope * (big ? a : d)));
        state.remaining = big ? large.lifetimeSeconds : small.lifetimeSeconds;
    }

    function advance(ms: number) {
        const dt = f32(f32(ms) * f32(0.001));
        colorSeconds = f32(colorSeconds + dt);
        if (colorSeconds >= paletteCycleSeconds) colorSeconds = 0;
        for (let i = 0; i < lights.length; i++) {
            const state = lights[i];
            const big = i >= small.count;
            const group = big ? large : small;
            const delay = f32(state.delay - dt);
            state.delay = Math.max(0, delay);
            if (delay <= 0 && state.remaining <= 0) {
                spawn(state, false);
                if (big) spawn(state, true);
                continue;
            }
            state.remaining = f32(state.remaining - dt);
            state.x = f32(state.x + f32(dt * state.vx));
            state.y = f32(state.y + f32(dt * state.vy));
            if (state.size === 0) continue;
            const ramp = f32(group.lifetimeSeconds * f32(group.fadeFraction));
            const enter = f32(f32(group.lifetimeSeconds - state.remaining) / ramp);
            const alpha = f32(
                state.peak *
                    (enter < 1 ? smooth(enter) : state.remaining < ramp ? smooth(f32(state.remaining / ramp)) : 1),
            );
            const t = f32(f32(colorSeconds / paletteCycleSeconds) + state.phase);
            const frac = f32(t - Math.trunc(t));
            const index = Math.trunc(f32(frac / tenth)) % palette.length;
            const weight = f32(f32(frac - f32(index * tenth)) / tenth);
            const w = weight < 0 || weight > 1 ? 1 : weight;
            const inv = f32(1 - w);
            const from = palette[index];
            const to = palette[(index + 1) % palette.length];
            const quad = quads[i];
            quad.x = state.x;
            quad.y = state.y;
            quad.size = state.size;
            quad.alpha = alpha;
            quad.r = f32(alpha * f32(f32(inv * f32(from[0] / 255)) + f32(w * f32(to[0] / 255))));
            quad.g = f32(alpha * f32(f32(inv * f32(from[1] / 255)) + f32(w * f32(to[1] / 255))));
            quad.b = f32(alpha * f32(f32(inv * f32(from[2] / 255)) + f32(w * f32(to[2] / 255))));
        }
    }

    return { light, quads, advance, rewind };
}
