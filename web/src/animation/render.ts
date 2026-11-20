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
    type Ticker,
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

const wgsl = `
    struct GlobalUniforms {
        uProjectionMatrix: mat3x3<f32>,
        uWorldTransformMatrix: mat3x3<f32>,
        uWorldColorAlpha: vec4f,
        uResolution: vec2f,
    }
    struct LocalUniforms {
        uTransformMatrix: mat3x3<f32>,
        uColor: vec4f,
        uRound: f32,
    }
    struct Settings { uHasAlpha: f32, uLightMask: f32 }
    struct Varyings {
        @builtin(position) position: vec4f,
        @location(0) uv: vec2f,
        @location(1) rgba: vec4f,
    }
    @group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
    @group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
    @group(2) @binding(0) var uPixels: texture_2d<f32>;
    @group(2) @binding(1) var uSampler: sampler;
    @group(2) @binding(2) var<uniform> settings: Settings;

    @vertex fn mainVert(@location(0) aPosition: vec2f, @location(1) aUV: vec2f, @location(2) aRGBA: vec4f) -> Varyings {
        let p = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix
            * localUniforms.uTransformMatrix * vec3f(aPosition, 1.0);
        return Varyings(vec4f(p.xy, 0.0, 1.0), aUV, aRGBA);
    }

    @fragment fn mainFrag(input: Varyings) -> @location(0) vec4f {
        let la = textureSample(uPixels, uSampler, input.uv).rg;
        let a = mix(1.0, la.g, settings.uHasAlpha);
        return vec4f(la.r * a * input.rgba.rgb, mix(a, la.r, settings.uLightMask) * input.rgba.a);
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
        gpu: {
            vertex: { source: wgsl, entryPoint: "mainVert" },
            fragment: { source: wgsl, entryPoint: "mainFrag" },
        },
        resources: {
            uPixels: source,
            uSampler: source.style,
            settings: new UniformGroup({
                uHasAlpha: { value: Number(hasAlpha), type: "f32" },
                uLightMask: { value: Number(kind === "light"), type: "f32" },
            }),
        },
    });
    const mesh = new Mesh({ geometry, shader, blendMode: "normal" });
    return { mesh, geometry, shader, vertices, buffer, source };
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

async function initRenderer(canvas: HTMLCanvasElement, webgpu: boolean, allowFallback = false) {
    const app = new Application();
    await app.init({
        canvas,
        preference: webgpu ? (allowFallback ? ["webgpu", "webgl"] : ["webgpu"]) : ["webgl"],
        failIfMajorPerformanceCaveat: false,
        autoStart: false,
        background: 0x000000,
    });
    if (app.renderer.name === "webgl") {
        const gl = canvas.getContext("webgl2");
        if (!gl) {
            app.destroy();
            throw new Error("WebGL 2 is required for the WebGL backend");
        }
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // The 494-byte splash rows are tightly packed.
    }
    return app;
}

export async function mountBoot(canvas: HTMLCanvasElement, host: HTMLElement, portrait: boolean, webgpu: boolean) {
    const assets = await loadBootAssets();
    const count = spotlights.small.count + spotlights.large.count;
    const lightSize = 2 * spotlights.light.quadrantSize;
    let motion = createMotion(assets.quadrant, assets.spawns, (Date.now() / 1000) | 0);

    function makeView(app: Application) {
        const root = app.stage.addChild(new Container());
        root.pivot.set(screen.width / 2, screen.height / 2);
        const first = makePass(assets.firstImage, firstSplash.width, firstSplash.height, 1, "splash");
        const { x, y, width, height } = spotlights.logo;
        const logo = makePass(assets.logoImage, width, height, 1, "logo");
        const lights = makePass(motion.light, lightSize, lightSize, count, "light");
        writeQuad(first.vertices, 0, firstSplash.x, firstSplash.y, firstSplash.width, firstSplash.height, 1, 1, 1, 1);
        writeQuad(logo.vertices, 0, x, y, width, height, 1, 1, 1, 1);
        const fade = new Sprite(Texture.WHITE);
        fade.tint = 0x000000;
        fade.setSize(screen.width, screen.height);
        root.addChild(first.mesh, lights.mesh, logo.mesh, fade);
        return {
            app,
            root,
            first,
            logo,
            lights,
            fade,
            destroy() {
                app.destroy(false, { children: true });
                for (const { geometry, shader, source } of [first, logo, lights]) {
                    geometry.destroy(true);
                    shader.destroy();
                    source.destroy();
                }
            },
        };
    }

    let view = makeView(await initRenderer(canvas, webgpu, true));
    const clock = createPlaybackClock();
    let frame = -1;
    let fitToViewport = true;
    let showLogo = true;

    function resizeView({ app, root }: typeof view) {
        const canvas = app.canvas;
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

    const resize = () => resizeView(view);

    const glass = new ResizeObserver(resize);
    glass.observe(host);
    window.addEventListener("resize", resize);

    function draw({ first, logo, lights, fade } = view, uploadFrame = false) {
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
        if (target === frame && !uploadFrame) return;
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

    function tick(ticker: Ticker) {
        if (clock.advance(ticker.deltaMS)) restart();
        draw();
    }
    function restart() {
        const { app, lights } = view;
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
    view.app.ticker.add(tick);
    view.app.start();
    return {
        get backend() {
            return view.app.renderer.name;
        },
        async setBackend(webgpu: boolean) {
            if (view.app.renderer.name === (webgpu ? "webgpu" : "webgl")) return;
            // A canvas cannot change context type. Render the new view before replacing the old one.
            const canvas = view.app.canvas.cloneNode() as HTMLCanvasElement;
            const next = makeView(await initRenderer(canvas, webgpu));
            try {
                draw(next, true);
                resizeView(next);
            } catch (error) {
                next.destroy();
                throw error;
            }
            const previous = view;
            const playing = previous.app.ticker.started;
            previous.app.canvas.replaceWith(canvas);
            view = next;
            previous.destroy();
            next.app.ticker.add(tick);
            if (playing) next.app.start();
        },
        restart,
        fadeOut() {
            if (!clock.fadeOut()) return false;
            view.app.start();
            return true;
        },
        togglePlayback() {
            const { app } = view;
            if (app.ticker.started) app.stop();
            else app.start();
            return app.ticker.started;
        },
        stepFrames(count: number) {
            const { app } = view;
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
            view.app.render();
        },
        setSpeed(value: number) {
            clock.speed = value;
        },
        setReplayDelay: clock.setReplayDelay,
        setDuration: clock.setDuration,
    };
}
