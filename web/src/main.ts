import "./style.scss";
import { resetSidebarWidth } from "./preview-layout";

import { mountBoot } from "./animation/render";
import config from "./animation/playbook.json";

const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const restart = document.querySelector<HTMLButtonElement>("#restart")!;
const playback = document.querySelector<HTMLButtonElement>("#playback")!;
const orientation = document.querySelector<HTMLSelectElement>("#scr-ort")!;
const fit = document.querySelector<HTMLInputElement>("#scr-fit")!;
const logo = document.querySelector<HTMLInputElement>("#scr-logo")!;
const renderer = document.querySelector<HTMLSelectElement>("#scr-renderer")!;
const speed = document.querySelector<HTMLInputElement>("#scr-spd")!;
const label = document.querySelector<HTMLOutputElement>("#scr-spd-label")!;
const loop = document.querySelector<HTMLInputElement>("#scr-loop")!;
const duration = document.querySelector<HTMLInputElement>("#scr-duration")!;
const delay = document.querySelector<HTMLInputElement>("#scr-delay")!;
delay.defaultValue = String(config.preview.replayDelayMs / 1000);
duration.defaultValue = String(config.preview.handoffMs / 1000);

const settings = [orientation, fit, logo, renderer, speed, loop, duration, delay];
for (const control of settings) {
    const key = `bbokeh:${control.id}`;
    const checkbox = control instanceof HTMLInputElement && control.type === "checkbox" ? control : null;
    try {
        const saved = localStorage.getItem(key);
        if (checkbox) {
            if (saved === "true" || saved === "false") checkbox.checked = saved === "true";
        } else if (control instanceof HTMLSelectElement) {
            if (saved !== null && Array.from(control.options).some((option) => option.value === saved))
                control.value = saved;
        } else if (saved && Number.isFinite(Number(saved) * 1000)) {
            const initial = control.value;
            control.value = saved;
            if (!control.validity.valid) control.value = initial;
        }
        if (control === renderer) continue;
        control.addEventListener("input", () => {
            if (
                !control.validity.valid ||
                (control instanceof HTMLInputElement && !checkbox && !Number.isFinite(control.valueAsNumber * 1000))
            )
                return;
            try {
                localStorage.setItem(key, checkbox ? String(checkbox.checked) : control.value);
            } catch {}
        });
    } catch {}
}

const rendererStatus = document.querySelector<HTMLElement>("#renderer-status")!;
const resetSettings = document.querySelector<HTMLButtonElement>("#reset-settings")!;
let switchRenderer: ((save: boolean) => Promise<void>) | undefined;
const form = document.querySelector<HTMLFormElement>("#preview-settings")!;
let applySettings: (() => void) | undefined;
form.addEventListener("submit", (event) => event.preventDefault());
resetSettings.addEventListener("click", () => {
    form.reset();
    resetSidebarWidth();
    try {
        for (const control of settings) localStorage.removeItem(`bbokeh:${control.id}`);
    } catch {}
    void switchRenderer?.(false);
    applySettings?.();
});

void mountBoot(canvas, canvas.parentElement!, orientation.value === "portrait", renderer.value === "webgpu")
    .then((boot) => {
        renderer.disabled = false;

        switchRenderer = async (save) => {
            const selected = renderer.value;
            renderer.disabled = resetSettings.disabled = true;
            rendererStatus.textContent = "";
            try {
                await boot.setBackend(selected === "webgpu");
                if (save) {
                    try {
                        localStorage.setItem(`bbokeh:${renderer.id}`, selected);
                    } catch {}
                }
            } catch (error) {
                console.warn("Rendering backend switch failed", error);
                renderer.value = boot.backend;
                const requested = selected === "webgpu" ? "WebGPU" : "WebGL 2";
                const active = boot.backend === "webgpu" ? "WebGPU" : "WebGL 2";
                rendererStatus.textContent = `${requested} unavailable. Still using ${active}.`;
            } finally {
                renderer.disabled = resetSettings.disabled = false;
            }
        };
        renderer.addEventListener("change", () => void switchRenderer?.(true));
        if (boot.backend !== renderer.value) {
            if (renderer.value === "webgl") void switchRenderer(false);
            else rendererStatus.textContent = "WebGPU unavailable. Using WebGL 2.";
        }
        restart.disabled = false;
        restart.addEventListener("click", boot.restart);
        playback.disabled = false;
        playback.addEventListener("click", () => {
            playback.textContent = boot.togglePlayback() ? "Pause" : "Play";
        });
        const fadeOut = document.querySelector<HTMLButtonElement>("#fade-out")!;
        fadeOut.disabled = false;
        fadeOut.addEventListener("click", () => {
            if (boot.fadeOut()) playback.textContent = "Pause";
        });
        for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-step]")) {
            button.disabled = false;
            button.addEventListener("click", () => {
                boot.stepFrames(Number(button.dataset.step));
                playback.textContent = "Play";
            });
        }
        const setOrientation = () => boot.setPortrait(orientation.value === "portrait");
        orientation.addEventListener("change", setOrientation);
        const setFit = () => boot.setFit(fit.checked);
        fit.addEventListener("change", setFit);
        const setLogo = () => boot.setLogoVisible(logo.checked);
        logo.addEventListener("change", setLogo);
        function setSpeed() {
            boot.setSpeed(speed.valueAsNumber);
            label.value = `${speed.value}x`;
        }
        speed.addEventListener("input", setSpeed);

        let delayMs = config.preview.replayDelayMs;
        function setDuration() {
            if (duration.validity.valid && Number.isFinite(duration.valueAsNumber * 1000)) {
                boot.setDuration(duration.valueAsNumber * 1000);
            }
        }
        duration.addEventListener("input", setDuration);
        function setReplayDelay() {
            delay.disabled = loop.checked;
            duration.disabled = loop.checked;
            if (!delay.disabled && delay.validity.valid && Number.isFinite(delay.valueAsNumber * 1000)) {
                delayMs = delay.valueAsNumber * 1000;
            }
            boot.setReplayDelay(loop.checked ? null : delayMs);
        }
        loop.addEventListener("change", setReplayDelay);
        delay.addEventListener("input", setReplayDelay);
        applySettings = () => {
            setOrientation();
            setFit();
            setLogo();
            setSpeed();
            setDuration();
            setReplayDelay();
        };
        applySettings();
    })
    .catch((error: unknown) => {
        console.error(error);
        const status = document.createElement("p");
        status.setAttribute("role", "alert");
        status.textContent = "Boot playback unavailable.";
        restart.after(status);
    });
