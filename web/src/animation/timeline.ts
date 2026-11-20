import config from "../../../firmware/playbook.json";

const fadeMs = config.spotlights.configuredFadeMs / 2;
const splashMs = config.preview.firstSplashMs;
const frameNumerator = 1000 * config.screen.swapInterval;
const refreshHz = config.screen.refreshHz;
const frameTime = (frame: number) => splashMs + Math.ceil((frame * frameNumerator) / refreshHz);

export function createPlaybackClock() {
    let scheduledEnd = splashMs + config.preview.handoffMs + fadeMs;
    let animationEnd = scheduledEnd;
    let elapsed = 0;
    let waiting = 0;
    let replayDelay: number | null = config.preview.replayDelayMs;
    let manualFade = false;

    return {
        speed: 1,
        get elapsed() {
            return elapsed;
        },
        get frame() {
            return Math.floor(((Math.floor(elapsed) - splashMs) * refreshHz) / frameNumerator);
        },
        get animationEnd() {
            return animationEnd;
        },
        setDuration(duration: number) {
            scheduledEnd = splashMs + duration + fadeMs;
            if (!manualFade && replayDelay !== null && elapsed <= animationEnd - fadeMs) {
                animationEnd = Math.max(scheduledEnd, elapsed + fadeMs);
            }
        },
        setReplayDelay(delay: number | null) {
            if (delay === null) {
                if (!manualFade) animationEnd = Infinity;
                waiting = 0;
            } else if (!manualFade && replayDelay === null) animationEnd = Math.max(scheduledEnd, elapsed + fadeMs);
            replayDelay = delay;
        },
        fadeOut() {
            if (manualFade || elapsed >= animationEnd - fadeMs) return false;
            manualFade = true;
            animationEnd = elapsed + fadeMs;
            return true;
        },
        reset() {
            elapsed = waiting = 0;
            manualFade = false;
            animationEnd = replayDelay === null ? Infinity : scheduledEnd;
        },
        step(frames: number) {
            let frame = this.frame;
            if (elapsed === animationEnd && elapsed > frameTime(frame)) frame++;
            const time = Math.max(0, Math.min(animationEnd, frameTime(frame + frames)));
            if (time === elapsed) return;
            elapsed = time;
            waiting = 0;
        },
        advance(deltaMs: number) {
            const untilEnd = (animationEnd - elapsed) / this.speed;
            elapsed = Math.min(animationEnd, elapsed + deltaMs * this.speed);
            if (replayDelay === null || elapsed < animationEnd) return false;
            waiting += Math.max(0, deltaMs - untilEnd);
            return waiting >= replayDelay;
        },
    };
}
