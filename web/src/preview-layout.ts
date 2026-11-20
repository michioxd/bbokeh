const preview = document.querySelector<HTMLElement>(".main")!;
const fullscreen = document.querySelector<HTMLButtonElement>("#fullscreen")!;
const exit = document.querySelector<HTMLButtonElement>("#exit-fullscreen")!;
const status = document.querySelector<HTMLElement>("#fullscreen-status")!;

fullscreen.disabled = !document.fullscreenEnabled;
fullscreen.addEventListener("click", async () => {
    status.textContent = "";
    try {
        await preview.requestFullscreen();
    } catch {
        status.textContent = "Fullscreen unavailable.";
    }
});
exit.addEventListener("click", () => {
    void document.exitFullscreen().catch(() => {
        exit.textContent = "Could not exit fullscreen";
    });
});
preview.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === preview) {
        exit.textContent = "Exit fullscreen";
        preview.focus({ preventScroll: true });
    } else {
        fullscreen.focus({ preventScroll: true });
    }
});

const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const divider = document.querySelector<HTMLElement>(".handler")!;
const layout = sidebar.parentElement!;
const minWidth = parseFloat(getComputedStyle(sidebar).getPropertyValue("--sidebar-min"));
divider.setAttribute("aria-valuemin", String(minWidth));

const widthKey = "bbokeh:sidebar-width";
try {
    const width = Number(localStorage.getItem(widthKey));
    if (Number.isFinite(width) && width >= minWidth) sidebar.style.setProperty("--sidebar-width", `${width}px`);
} catch {}

function saveSidebarWidth() {
    const width = parseFloat(sidebar.style.getPropertyValue("--sidebar-width"));
    if (!Number.isFinite(width)) return;
    try {
        localStorage.setItem(widthKey, String(width));
    } catch {}
}

export function resetSidebarWidth() {
    sidebar.style.removeProperty("--sidebar-width");
    try {
        localStorage.removeItem(widthKey);
    } catch {}
}

function updateDivider() {
    divider.setAttribute("aria-valuenow", String(sidebar.offsetWidth));
    divider.setAttribute("aria-valuemax", String(Math.floor(layout.clientWidth / 2)));
}

function resizeSidebar(width: number) {
    const max = Math.floor(layout.clientWidth / 2);
    const next = Math.max(minWidth, Math.min(max, width));
    if (next !== sidebar.offsetWidth) sidebar.style.setProperty("--sidebar-width", `${next}px`);
}

const sidebarObserver = new ResizeObserver(updateDivider);
sidebarObserver.observe(layout);
sidebarObserver.observe(sidebar);

let dragOffset = 0;
divider.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    dragOffset = sidebar.offsetWidth - event.clientX;
    divider.setPointerCapture(event.pointerId);
    divider.focus({ preventScroll: true });
    event.preventDefault();
});
divider.addEventListener("pointermove", (event) => {
    if (divider.hasPointerCapture(event.pointerId)) resizeSidebar(event.clientX + dragOffset);
});
divider.addEventListener("lostpointercapture", saveSidebarWidth);
divider.addEventListener("keydown", (event) => {
    const width = sidebar.offsetWidth;
    switch (event.key) {
        case "ArrowLeft":
            resizeSidebar(width - 16);
            break;
        case "ArrowRight":
            resizeSidebar(width + 16);
            break;
        case "Home":
            resizeSidebar(minWidth);
            break;
        case "End":
            resizeSidebar(layout.clientWidth / 2);
            break;
        default:
            return;
    }
    event.preventDefault();
    saveSidebarWidth();
});
