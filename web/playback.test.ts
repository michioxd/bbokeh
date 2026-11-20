import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createMotion, decodeRle, readSpawnTable } from "./src/animation/motion";
import { createPlaybackClock } from "./src/animation/timeline";

const asset = (name: string) => new Uint8Array(readFileSync(new URL(`../firmware/${name}`, import.meta.url)));
const quadrant = decodeRle(asset("spotlight.rle"), 128 * 128);
const motion = createMotion(quadrant, readSpawnTable(asset("spotlight-spawns.f32")), 1395216409);
assert.equal(createHash("sha256").update(motion.light).digest("hex"), "a05fbefd9221acb80cbbede0d0310435b9cf00cd5a7b7767778aab76ce8772d5");
const wordmark = asset("logo-spotlights-la.rle");
assert.equal(createHash("sha256").update(decodeRle(wordmark.subarray(0, 9612), 512 * 64)).digest("hex"), "e1165170015ecf48dded69d329c1b3214c972b1307b28db4cef2b68af7ba3cc2");
assert.equal(createHash("sha256").update(decodeRle(wordmark.subarray(9612), 512 * 64)).digest("hex"), "91c432efa94c974e1384c67b2632557f84fcf11ae93eb54e6209538bc1f210e6");
const checkpoints = new Map([
    [1, [-90.38475037, 84.76743317, 768.180786, 0, 0.00007193098, 0.00007598430, 0.00010568738]],
    [30, [-89.13741302, 86.58476257, 768.18081, 0, 0.05186606, 0.05386926, 0.07604145]],
    [300, [-77.52829742, 103.49890137, 768.18076, 0, 0, 0, 0]],
    [600, [75.419678, 213.744858, 964.825806, 0.000001, 0.000076, 0.000041, 0.000114]],
]);
for (let frame = 0; frame <= 600; frame++) {
    motion.advance(frame === 0 ? 10 : Math.round(frame * 100 / 3) - Math.round((frame - 1) * 100 / 3));
    const expected = checkpoints.get(frame);
    if (!expected) continue;
    const { x, y, size, r, g, b, alpha } = motion.quads[7];
    [x, y, size, r, g, b, alpha].forEach((value, i) => {
        assert.ok(Math.abs(value - expected[i]) < (i < 3 ? 0.005 : 0.000003), `frame ${frame}, value ${i}: ${value}`);
    });
    if (frame === 300) {
        const small = motion.quads[0];
        assert.ok(Math.abs(small.x - -27.21957588) < 0.005 && Math.abs(small.y - 243.46624756) < 0.005);
        assert.ok(Math.abs(small.alpha - 0.2055511028) < 0.000003);
    }
}
assert.throws(() => decodeRle(Uint8Array.of(255, 3), 2), /RLE/);
assert.throws(() => decodeRle(Uint8Array.of(255, 1), 2), /RLE/);

const clock = createPlaybackClock();
clock.speed = 10;
clock.setReplayDelay(2000);
assert.equal(clock.advance(9169), false); // Last 10 animation ms before black.
assert.equal(clock.advance(2000), false); // About 1 ms went to the fade, not the delay.
assert.equal(clock.advance(1), true);
clock.reset();
clock.setReplayDelay(null);
assert.equal(clock.advance(20000), false);
assert.equal(clock.animationEnd, Infinity);
clock.setReplayDelay(0);
assert.equal(clock.advance(49), false); // Turning off an overdue loop still fades.
assert.equal(clock.advance(1), true);

clock.reset();
clock.setDuration(3000);
assert.equal(clock.animationEnd, 4700); // Splash + spotlights + fade.
assert.equal(clock.advance(420), false);
clock.setDuration(1000); // At the fade boundary: do not restart or skip the current fade.
assert.equal(clock.advance(49), false);
assert.equal(clock.advance(1), true);
clock.reset();
assert.equal(clock.animationEnd, 2700);
clock.setReplayDelay(null);
clock.setDuration(5000);
assert.equal(clock.animationEnd, Infinity);
assert.equal(clock.advance(2000), false);
clock.setReplayDelay(0);
assert.equal(clock.animationEnd, 20500);

const stepping = createPlaybackClock();
stepping.speed = 10;
stepping.step(-10);
assert.equal(stepping.elapsed, 0);
stepping.advance(119);
stepping.step(1);
assert.equal(stepping.elapsed, 1200); // Step from the splash to the first motion frame.
for (let frame = 0; frame < 100; frame++) stepping.step(1);
assert.equal(stepping.frame, 100); // Fractional frame intervals must not stall or drift.
stepping.step(-10);
assert.equal(stepping.elapsed, 4200);
stepping.step(10000);
assert.equal(stepping.elapsed, stepping.animationEnd); // Stop at black; do not replay.
stepping.step(-1);
assert.equal(stepping.frame, 2714);
stepping.setReplayDelay(null);
stepping.step(10);
assert.equal(stepping.frame, 2724);

const manualFade = createPlaybackClock();
manualFade.setDuration(3000);
manualFade.setReplayDelay(200);
manualFade.advance(2200);
manualFade.fadeOut();
assert.equal(manualFade.advance(250), false);
manualFade.fadeOut(); // A second click must not restart the fade.
manualFade.setDuration(4000);
assert.equal(manualFade.advance(249), false);
assert.equal(manualFade.elapsed, 2699);
assert.equal(manualFade.advance(200), false);
assert.equal(manualFade.elapsed, 2700);
assert.equal(manualFade.advance(1), true);
manualFade.reset();
assert.equal(manualFade.animationEnd, 5700); // Manual fade did not change the saved duration.

manualFade.setReplayDelay(null);
manualFade.advance(2200);
manualFade.fadeOut();
assert.equal(manualFade.advance(5000), false);
assert.equal(manualFade.elapsed, 2700); // Loop forever holds on black after a manual fade.
manualFade.reset();
assert.equal(manualFade.animationEnd, Infinity);
