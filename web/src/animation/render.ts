import {
    Application,
    Buffer,
    BufferImageSource,
    BufferUsage,
    Container,
    Geometry,
    Mesh,
    Shader,
    Sprite,
    Texture,
    UniformGroup,
} from "pixi.js";
import { loadBootAssets } from "./assets";
import { createMotion } from "./motion";
import config from "./playbook.json";
import { createPlaybackClock } from "./timeline";

const { screen, firstSplash, spotlights, preview } = config;
const frameMs = (1000 * screen.swapInterval) / screen.refreshHz;
const vertex = `
    in vec2 aPosition;
    in vec2 aUV;
    in vec4 aRGBA;
    out vec2 vUV;
    out vec4 vRGBA;
    uniform mat3 uProjectionMatrix;
    uniform mat3 uWorldTransformMatrix;
    uniform mat3 uTransformMatrix;
    void main() {
        vec3 p = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0);
        gl_Position = vec4(p.xy, 0.0, 1.0);
        vUV = aUV;
        vRGBA = aRGBA;
    }`;
const fragment = `
    precision highp float;
    in vec2 vUV;
    in vec4 vRGBA;
    uniform sampler2D uPixels;
    uniform float uHasAlpha;
    uniform float uLightMask;
    out vec4 finalColor;
    void main() {
        vec2 la = texture(uPixels, vUV).rg;
        float a = mix(1.0, la.g, uHasAlpha);
        // ponytail: keep the native RGB, but let dark spotlight texels preserve earlier layers.
        finalColor = vec4(la.r * a * vRGBA.rgb, mix(a, la.r, uLightMask) * vRGBA.a);
    }`;

function makePass(
    resource: Uint8Array,
    width: number,
    height: number,
    count: number,
    kind: "splash" | "logo" | "light",
) {
    const hasAlpha = kind === "logo";
    const source = new BufferImageSource({
        resource,
        width,
        height,
        format: hasAlpha ? "rg8unorm" : "r8unorm",
        scaleMode: kind === "splash" ? "nearest" : "linear",
        alphaMode: "no-premultiply-alpha",
    });
    const vertices = new Float32Array(count * 32);
    const indices = new Uint16Array(count * 6);
    for (let i = 0; i < count; i++) {
        const v = i * 4;
        indices.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6);
    }
    const buffer = new Buffer({ data: vertices, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    const geometry = new Geometry({
        attributes: {
            aPosition: { buffer, format: "float32x2", stride: 32, offset: 0 },
            aUV: { buffer, format: "float32x2", stride: 32, offset: 8 },
            aRGBA: { buffer, format: "float32x4", stride: 32, offset: 16 },
        },
        indexBuffer: indices,
    });
    const shader = Shader.from({
        gl: { vertex, fragment },
        resources: {
            uPixels: source,
            settings: new UniformGroup({
                uHasAlpha: { value: Number(hasAlpha), type: "f32" },
                uLightMask: { value: Number(kind === "light"), type: "f32" },
            }),
        },
    });
    const mesh = new Mesh({ geometry, shader, blendMode: "normal" });
    return { mesh, vertices, buffer, source };
}

function writeQuad(
    vertices: Float32Array,
    index: number,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
    a: number,
) {
    let offset = index * 32;
    for (let v = 0; v < 4; v++) {
        const u = v & 1;
        const t = v >> 1;
        vertices[offset++] = x + u * w;
        vertices[offset++] = y + t * h;
        vertices[offset++] = u;
        vertices[offset++] = t;
        vertices[offset++] = r;
        vertices[offset++] = g;
        vertices[offset++] = b;
        vertices[offset++] = a;
    }
}

export async function mountBoot(canvas: HTMLCanvasElement, host: HTMLElement, portrait: boolean) {
    const assets = await loadBootAssets();
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) throw new Error("WebGL 2 is required");
    const app = new Application();
    await app.init({ canvas, context: gl, preference: "webgl", autoStart: false, background: 0x000000 });
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const root = app.stage.addChild(new Container());
    root.pivot.set(screen.width / 2, screen.height / 2);
    const first = makePass(assets.firstImage, firstSplash.width, firstSplash.height, 1, "splash");
    const logo = makePass(assets.logoImage, spotlights.logo.width, spotlights.logo.height, 1, "logo");
    const count = spotlights.small.count + spotlights.large.count;
    const lightSize = 2 * spotlights.light.quadrantSize;
    let motion = createMotion(assets.quadrant, assets.spawns, (Date.now() / 1000) | 0);
    const lights = makePass(motion.light, lightSize, lightSize, count, "light");
    writeQuad(first.vertices, 0, firstSplash.x, firstSplash.y, firstSplash.width, firstSplash.height, 1, 1, 1, 1);
    writeQuad(
        logo.vertices,
        0,
        spotlights.logo.x,
        spotlights.logo.y,
        spotlights.logo.width,
        spotlights.logo.height,
        1,
        1,
        1,
        1,
    );
    const fade = new Sprite(Texture.WHITE);
    fade.tint = 0x000000;
    fade.setSize(screen.width, screen.height);
    root.addChild(first.mesh, lights.mesh, logo.mesh, fade);
    const clock = createPlaybackClock();
    let frame = -1;
    let fitToViewport = true;
    let showLogo = true;

    function resize() {
        const w = portrait ? screen.height : screen.width;
        const h = portrait ? screen.width : screen.height;
        const shouldFit = fitToViewport || document.fullscreenElement === host;
        const fit = shouldFit ? Math.min(host.clientWidth / w, host.clientHeight / h) : 1;
        if (!(fit > 0)) return;
        const width = w * fit;
        const height = h * fit;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const resolution = shouldFit ? window.devicePixelRatio : 1;
        app.renderer.resize(width, height, resolution);
        root.position.set(app.screen.width / 2, app.screen.height / 2);
        root.scale.set(Math.min(app.screen.width / w, app.screen.height / h));
        root.angle = portrait ? 90 : 0;
        app.render();
    }

    const glass = new ResizeObserver(resize);
    glass.observe(host);
    window.addEventListener("resize", resize);

    function draw() {
        const time = clock.elapsed - preview.firstSplashMs;
        const animationEnd = clock.animationEnd - preview.firstSplashMs;
        first.mesh.visible = showLogo && time < 0;
        lights.mesh.visible = time >= 0 && time < animationEnd;
        logo.mesh.visible = showLogo && lights.mesh.visible;
        const alpha =
            1 -
            Math.floor(255 * Math.max(0, Math.min(1, (animationEnd - time) / (spotlights.configuredFadeMs / 2)))) / 255;
        fade.visible = alpha > 0;
        fade.alpha = alpha;
        if (!lights.mesh.visible) return;
        const target = clock.frame;
        if (target === frame) return;
        if (target < frame) {
            motion.rewind();
            frame = -1;
        }
        while (frame < target) {
            frame++;
            motion.advance(
                frame === 0
                    ? spotlights.firstStepSeconds * 1000
                    : Math.round(frame * frameMs) - Math.round((frame - 1) * frameMs),
            );
        }
        for (let i = 0; i < count; i++) {
            const q = motion.quads[i];
            writeQuad(lights.vertices, i, q.x, screen.height - q.y - q.size, q.size, q.size, q.r, q.g, q.b, q.alpha);
        }
        lights.buffer.update();
    }

    app.ticker.add((ticker) => {
        if (clock.advance(ticker.deltaMS)) restart();
        draw();
    });
    function restart() {
        clock.reset();
        frame = -1;
        motion = createMotion(assets.quadrant, assets.spawns, (Date.now() / 1000) | 0);
        lights.source.resource = motion.light;
        lights.source.update();
        if (!app.ticker.started) {
            draw();
            app.render();
        }
    }
    draw();
    resize();
    app.start();
    return {
        restart,
        fadeOut() {
            if (!clock.fadeOut()) return false;
            app.start();
            return true;
        },
        togglePlayback() {
            if (app.ticker.started) app.stop();
            else app.start();
            return app.ticker.started;
        },
        stepFrames(count: number) {
            app.stop();
            clock.step(count);
            draw();
            app.render();
        },
        setPortrait(value: boolean) {
            portrait = value;
            resize();
        },
        setFit(value: boolean) {
            fitToViewport = value;
            host.classList.toggle("native-size", !value);
            resize();
        },
        setLogoVisible(value: boolean) {
            if (showLogo === value) return;
            showLogo = value;
            draw();
            app.render();
        },
        setSpeed(value: number) {
            clock.speed = value;
        },
        setReplayDelay: clock.setReplayDelay,
        setDuration: clock.setDuration,
    };
}
