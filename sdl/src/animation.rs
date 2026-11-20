use serde::Deserialize;

pub(super) const WIDTH: u32 = 1024;
pub(super) const HEIGHT: u32 = 600;
pub(super) const SPLASH_SIZE: [u32; 2] = [494, 64];
pub(super) const LOGO_SIZE: [u32; 2] = [512, 64];
pub(super) const LIGHT_SIZE: u32 = 256;
pub(super) const SPLASH_POS: [f32; 2] = [265.0, 268.0];
pub(super) const LOGO_POS: [f32; 2] = [253.0, 266.0];
const LIGHTS: usize = 12;
const SPAWNS: usize = 298;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    screen: Screen,
    first_splash: Image,
    spotlights: Spotlights,
    preview: Preview,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Screen {
    width: u32,
    height: u32,
    refresh_hz: f64,
    swap_interval: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Image {
    file: String,
    width: u32,
    height: u32,
    x: f32,
    y: f32,
    decoded_rows: Option<u32>,
    luma_bytes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spotlights {
    logo: Image,
    light: LightImage,
    spawn_table: String,
    palette: [[u8; 3]; 10],
    palette_cycle_seconds: f64,
    first_step_seconds: f64,
    small: Group,
    large: Group,
    configured_fade_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LightImage {
    file: String,
    quadrant_size: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    count: usize,
    lifetime_seconds: f64,
    fade_fraction: f32,
    #[serde(default)]
    start_delay_seconds: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    first_splash_ms: f64,
    handoff_ms: f64,
    replay_delay_ms: f64,
}

struct Random(u32);

impl Random {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(16807);
        (self.0 & 0x7f_ffff) as f32 / 0x80_0000 as f32
    }
}

fn decode_rle<const N: usize>(
    bytes: &[u8],
    pixels: &mut [[u8; N]],
    mut write_pixel: impl FnMut(&mut [u8; N], u8),
) -> Result<(), String> {
    let runs = bytes.chunks_exact(2);
    if !runs.remainder().is_empty() {
        return Err("invalid RLE pair".into());
    }
    let mut offset = 0;
    for run in runs {
        let end = offset + usize::from(run[1]);
        for pixel in pixels.get_mut(offset..end).ok_or("RLE overflow")? {
            write_pixel(pixel, run[0]);
        }
        offset = end;
    }
    if offset != pixels.len() {
        return Err("RLE underflow".into());
    }
    Ok(())
}

fn fill_light_texture(rgba: &mut [u8], quadrant: &[u8], seed: u32) -> u32 {
    let mut random = Random(seed);
    let side = LIGHT_SIZE as usize;
    let half = side / 2;
    for (i, &luma) in quadrant.iter().enumerate() {
        let (y, x) = (i / half, i % half);
        let p = f32::from(luma) / 255.0;
        let lo = (2.25 * p).min(1.0);
        let hi = (2.5 * p).min(1.0);
        let value = (255.0 * (p * (lo + (hi - lo) * random.next()))) as u8;
        for row in [y, side - 1 - y] {
            rgba[4 * (row * side + half - 1 - x) + 3] = value;
            rgba[4 * (row * side + half + x) + 3] = value;
        }
    }
    // The firmware uses the same random stream for texture pixels and spawn delays.
    random.0
}

#[derive(Clone, Copy, Default)]
pub(super) struct Quad {
    pub x: f32,
    pub y: f32,
    pub size: f32,
    pub rgb: [f32; 3],
    pub alpha: f32,
}

#[derive(Clone, Copy, Default)]
struct Light {
    delay: f32,
    remaining: f32,
    x: f32,
    y: f32,
    size: f32,
    vx: f32,
    vy: f32,
    phase: f32,
    peak: f32,
}

struct Motion {
    random: Random,
    spawns: [f32; SPAWNS],
    cursor: usize,
    color_seconds: f32,
    lights: [Light; LIGHTS],
}

impl Motion {
    fn rewind(&mut self, small: &Group, large: &Group, seed: u32) {
        self.random = Random(seed);
        self.cursor = 0;
        self.color_seconds = 0.0;
        self.lights = std::array::from_fn(|i| Light {
            delay: if i < small.count {
                (small.lifetime_seconds * f64::from(self.random.next())) as f32
            } else {
                ((i - small.count) as f64 * large.start_delay_seconds) as f32
            },
            ..Light::default()
        });
    }

    fn advance(&mut self, config: &Spotlights, quads: &mut [Quad; LIGHTS], ms: f64) {
        fn smooth(t: f32) -> f32 {
            (t * t) * (3.0 - 2.0 * t)
        }

        let dt = ms as f32 * 0.001;
        self.color_seconds += dt;
        if f64::from(self.color_seconds) >= config.palette_cycle_seconds {
            self.color_seconds = 0.0;
        }
        let cycle = (f64::from(self.color_seconds) / config.palette_cycle_seconds) as f32;
        for (i, (state, quad)) in self.lights.iter_mut().zip(quads).enumerate() {
            let big = i >= config.small.count;
            let group = if big { &config.large } else { &config.small };
            state.delay = (state.delay - dt).max(0.0);
            if state.delay <= 0.0 && state.remaining <= 0.0 {
                let mut spawn = |big| {
                    let x = self.spawns[self.cursor];
                    let y = self.spawns[self.cursor + 1];
                    self.cursor = (self.cursor + 2) % SPAWNS;
                    let [a, b, c, d, e] = std::array::from_fn(|_| self.random.next());
                    if big {
                        state.x = (WIDTH as f32 * x - 350.0) * 0.6;
                        state.y = HEIGHT as f32 * y - 350.0;
                        state.size = 700.0 + 300.0 * b;
                        state.vx = 6.0 * c - 3.0;
                        state.vy = 6.0 * d - 3.0;
                        state.phase = 0.1 + 0.1 * e;
                    } else {
                        state.x = (WIDTH as f32 * x - 100.0) * 0.8;
                        state.y = HEIGHT as f32 * y - 100.0;
                        state.size = 200.0 + 400.0 * a;
                        state.vx = (4.0 + 5.0 * b) + 10.0 * (1.0 + state.size / -600.0);
                        state.vy = 6.0 * c - 3.0;
                        state.phase = 0.1 * e;
                    }
                    state.peak = 0.24 + 0.12000002 * if big { a } else { d };
                };
                // Large lights consume a small spawn before their own spawn.
                spawn(false);
                if big {
                    spawn(true);
                }
                state.remaining = group.lifetime_seconds as f32;
                continue;
            }
            state.remaining -= dt;
            state.x += dt * state.vx;
            state.y += dt * state.vy;
            if state.size == 0.0 {
                continue;
            }
            let ramp = (group.lifetime_seconds * f64::from(group.fade_fraction)) as f32;
            let enter = (group.lifetime_seconds - f64::from(state.remaining)) as f32 / ramp;
            let alpha = state.peak * if enter < 1.0 {
                smooth(enter)
            } else if state.remaining < ramp {
                smooth(state.remaining / ramp)
            } else {
                1.0
            };
            let frac = (cycle + state.phase).fract();
            let index = (frac / 0.1) as usize % config.palette.len();
            let weight = (frac - index as f32 * 0.1) / 0.1;
            let w = if (0.0..=1.0).contains(&weight) { weight } else { 1.0 };
            let from = config.palette[index];
            let to = config.palette[(index + 1) % config.palette.len()];
            *quad = Quad {
                x: state.x,
                y: (f64::from(HEIGHT) - f64::from(state.y) - f64::from(state.size)) as f32,
                size: state.size,
                rgb: std::array::from_fn(|j| {
                    (1.0 - w) * (f32::from(from[j]) / 255.0) + w * (f32::from(to[j]) / 255.0)
                }),
                alpha,
            };
        }
    }
}

pub(super) struct Animation {
    pub splash_rgba: Vec<u8>,
    pub logo_rgba: Vec<u8>,
    pub light_rgba: Vec<u8>,
    pub generation: u64,
    pub playing: bool,
    pub quads: [Quad; LIGHTS],
    config: Config,
    quadrant: Vec<u8>,
    motion: Motion,
    seed: u32,
    motion_seed: u32,
    frame: i64,
    elapsed: f64,
    waiting: f64,
    speed: f64,
    scheduled_end: f64,
    animation_end: f64,
    replay_delay: Option<f64>,
    manual_fade: bool,
}

impl Animation {
    pub(super) fn new(seed: u32) -> Result<Self, String> {
        const SPLASH: &[u8] = include_bytes!("../../firmware/logo-ipl.rle");
        const LOGO: &[u8] = include_bytes!("../../firmware/logo-spotlights-la.rle");
        const LIGHT: &[u8] = include_bytes!("../../firmware/spotlight.rle");
        const TABLE: &[u8; SPAWNS * 4] = include_bytes!("../../firmware/spotlight-spawns.f32");

        let config: Config = serde_json::from_str(include_str!("../../firmware/playbook.json"))
            .map_err(|err| format!("invalid PlayBook config: {err}"))?;
        let first = &config.first_splash;
        let spots = &config.spotlights;
        let logo = &spots.logo;
        if (config.screen.width, config.screen.height) != (WIDTH, HEIGHT)
            || [first.width, first.height] != SPLASH_SIZE
            || [logo.width, logo.height] != LOGO_SIZE
            || [first.x, first.y] != SPLASH_POS
            || [logo.x, logo.y] != LOGO_POS
            || spots.light.quadrant_size != LIGHT_SIZE / 2
            || spots.small.count.checked_add(spots.large.count) != Some(LIGHTS)
            || first.file != "logo-ipl.rle"
            || logo.file != "logo-spotlights-la.rle"
            || spots.light.file != "spotlight.rle"
            || spots.spawn_table != "spotlight-spawns.f32"
        {
            return Err("PlayBook config does not match embedded asset layout".into());
        }
        let rows = first.decoded_rows.filter(|&rows| rows <= first.height).ok_or("invalid splash row count")?;
        let luma_bytes = logo.luma_bytes.filter(|&n| n <= LOGO.len()).ok_or("invalid logo luma length")?;
        let mut splash_rgba = vec![0; (first.width * first.height * 4) as usize];
        let (splash, _) = splash_rgba.as_chunks_mut::<4>();
        let (rows, padding) = splash.split_at_mut((first.width * rows) as usize);
        decode_rle(SPLASH, rows, |pixel, v| *pixel = [v, v, v, 255])?;
        padding.fill([0, 0, 0, 255]);

        let mut logo_rgba = vec![0; (logo.width * logo.height * 4) as usize];
        let (pixels, _) = logo_rgba.as_chunks_mut::<4>();
        let (logo_luma, logo_alpha) = LOGO.split_at(luma_bytes);
        decode_rle(logo_luma, pixels, |pixel, v| *pixel = [v, v, v, 0])?;
        decode_rle(logo_alpha, pixels, |pixel, a| pixel[3] = a)?;

        let mut quadrant = vec![0; spots.light.quadrant_size.pow(2) as usize];
        let (pixels, _) = quadrant.as_chunks_mut::<1>();
        decode_rle(LIGHT, pixels, |pixel, v| pixel[0] = v)?;
        let mut light_rgba = vec![255; (LIGHT_SIZE * LIGHT_SIZE * 4) as usize];
        let motion_seed = fill_light_texture(&mut light_rgba, &quadrant, seed);

        let mut spawns = [0.0; SPAWNS];
        for (coordinate, bytes) in spawns.iter_mut().zip(TABLE.chunks_exact(4)) {
            *coordinate = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            if !(0.0..=1.0).contains(coordinate) {
                return Err("invalid spawn coordinate".into());
            }
        }
        let mut motion = Motion {
            random: Random(motion_seed),
            spawns,
            cursor: 0,
            color_seconds: 0.0,
            lights: [Light::default(); LIGHTS],
        };
        motion.rewind(&spots.small, &spots.large, motion_seed);
        let scheduled_end = config.preview.first_splash_ms + config.preview.handoff_ms + spots.configured_fade_ms / 2.0;
        Ok(Self {
            splash_rgba,
            logo_rgba,
            light_rgba,
            generation: 0,
            playing: true,
            quads: [Quad::default(); LIGHTS],
            config,
            quadrant,
            motion,
            seed,
            motion_seed,
            frame: -1,
            elapsed: 0.0,
            waiting: 0.0,
            speed: 1.0,
            scheduled_end,
            animation_end: f64::INFINITY,
            replay_delay: None,
            manual_fade: false,
        })
    }

    pub(super) fn is_splash(&self) -> bool {
        self.elapsed < self.config.preview.first_splash_ms
    }

    pub(super) fn is_spotlights(&self) -> bool {
        !self.is_splash() && self.elapsed < self.animation_end
    }

    fn fade_ms(&self) -> f64 {
        self.config.spotlights.configured_fade_ms / 2.0
    }

    pub(super) fn fade(&self) -> u8 {
        255 - (255.0 * ((self.animation_end - self.elapsed) / self.fade_ms()).clamp(0.0, 1.0)) as u8
    }

    pub(super) fn advance(&mut self, delta_ms: f64, seed: impl FnOnce() -> u32) {
        if !self.playing || !delta_ms.is_finite() || delta_ms < 0.0 {
            return;
        }
        let until_end = (self.animation_end - self.elapsed) / self.speed;
        self.elapsed = self.animation_end.min(self.elapsed + delta_ms * self.speed);
        if let Some(delay) = self.replay_delay {
            if self.elapsed >= self.animation_end {
                self.waiting += (delta_ms - until_end).max(0.0);
                if self.waiting >= delay {
                    self.restart(seed());
                    return;
                }
            }
        }
        self.sync_motion();
    }

    pub(super) fn restart(&mut self, seed: u32) {
        if seed != self.seed {
            self.motion_seed = fill_light_texture(&mut self.light_rgba, &self.quadrant, seed);
        }
        self.seed = seed;
        self.generation = self.generation.wrapping_add(1);
        self.elapsed = 0.0;
        self.waiting = 0.0;
        self.manual_fade = false;
        self.animation_end = if self.replay_delay.is_some() { self.scheduled_end } else { f64::INFINITY };
        self.rewind_motion();
    }

    pub(super) fn step(&mut self, frames: i64) {
        self.playing = false;
        let mut frame = self.clock_frame();
        if self.elapsed == self.animation_end && self.elapsed > self.frame_time(frame) {
            frame += 1;
        }
        let time = self.frame_time(frame.saturating_add(frames)).clamp(0.0, self.animation_end);
        if time != self.elapsed {
            self.elapsed = time;
            self.waiting = 0.0;
        }
        self.sync_motion();
    }

    pub(super) fn fade_out(&mut self) {
        if !self.manual_fade && self.elapsed < self.animation_end - self.fade_ms() {
            self.manual_fade = true;
            self.animation_end = self.elapsed + self.fade_ms();
            self.playing = true;
        }
    }

    pub(super) fn set_speed(&mut self, speed: f64) {
        if speed.is_finite() && speed > 0.0 {
            self.speed = speed;
        }
    }

    pub(super) fn default_timing(&self) -> [f64; 2] {
        let preview = &self.config.preview;
        [preview.handoff_ms / 1000.0, preview.replay_delay_ms / 1000.0]
    }

    pub(super) fn set_duration(&mut self, ms: f64) {
        if !ms.is_finite() || ms < 0.0 {
            return;
        }
        self.scheduled_end = self.config.preview.first_splash_ms + ms + self.fade_ms();
        if !self.manual_fade && self.replay_delay.is_some() && self.elapsed <= self.animation_end - self.fade_ms() {
            self.animation_end = self.scheduled_end.max(self.elapsed + self.fade_ms());
        }
    }

    pub(super) fn set_replay_delay(&mut self, delay: Option<f64>) {
        if delay.is_some_and(|ms| !ms.is_finite() || ms < 0.0) {
            return;
        }
        if delay.is_none() {
            if !self.manual_fade {
                self.animation_end = f64::INFINITY;
            }
            self.waiting = 0.0;
        } else if !self.manual_fade && self.replay_delay.is_none() {
            self.animation_end = self.scheduled_end.max(self.elapsed + self.fade_ms());
        }
        self.replay_delay = delay;
    }

    fn clock_frame(&self) -> i64 {
        let screen = &self.config.screen;
        (((self.elapsed.floor() - self.config.preview.first_splash_ms) * screen.refresh_hz)
            / (1000.0 * screen.swap_interval)).floor() as i64
    }

    fn frame_time(&self, frame: i64) -> f64 {
        let screen = &self.config.screen;
        self.config.preview.first_splash_ms
            + (frame as f64 * (1000.0 * screen.swap_interval) / screen.refresh_hz).ceil()
    }

    fn rewind_motion(&mut self) {
        let spots = &self.config.spotlights;
        self.motion.rewind(&spots.small, &spots.large, self.motion_seed);
        self.frame = -1;
        self.quads.fill(Quad::default());
    }

    fn sync_motion(&mut self) {
        let target = self.clock_frame().max(-1);
        if target < self.frame {
            self.rewind_motion();
        }
        if !self.is_spotlights() {
            return;
        }
        let spots = &self.config.spotlights;
        let screen = &self.config.screen;
        let frame_ms = 1000.0 * screen.swap_interval / screen.refresh_hz;
        while self.frame < target {
            self.frame += 1;
            let delta = if self.frame == 0 {
                spots.first_step_seconds * 1000.0
            } else {
                (self.frame as f64 * frame_ms).round() - ((self.frame - 1) as f64 * frame_ms).round()
            };
            self.motion.advance(spots, &mut self.quads, delta);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_motion_rewinds_and_replays_on_wall_time() {
        const SEED: u32 = 1395216409;
        let mut animation = Animation::new(SEED).unwrap();
        let generation = animation.generation;
        assert_eq!(animation.default_timing(), [90.0, 2.0]);
        assert_eq!(animation.animation_end, f64::INFINITY);
        assert!(animation.is_splash());
        animation.advance(1190.0, || panic!("not replaying"));
        animation.step(1);
        assert!(animation.is_spotlights());
        assert_eq!(animation.frame, 0);
        animation.step(30);
        let quad = animation.quads[7];
        // Browser motion checkpoint, converted to the renderer's top-left origin.
        assert!((quad.x - -89.13741302).abs() < 0.005);
        assert!((quad.size - 768.18081).abs() < 0.005);
        assert!((quad.y - (600.0 - 86.58476257 - 768.18081)).abs() < 0.005);
        assert!((quad.alpha - 0.07604145).abs() < 0.000003);
        assert!((quad.rgb[1] * quad.alpha - 0.05186606).abs() < 0.000003);

        animation.advance(5000.0, || panic!("paused"));
        assert_eq!(animation.frame, 30);
        animation.step(-31);
        assert!(animation.is_splash());
        animation.step(31);
        assert_eq!(animation.generation, generation);
        assert_eq!(animation.quads[7].x, quad.x);
        assert_eq!(animation.quads[7].alpha, quad.alpha);

        animation.set_replay_delay(Some(2000.0));
        animation.set_duration(3000.0);
        assert_eq!(animation.animation_end, 4700.0);
        animation.set_speed(10.0);
        animation.fade_out();
        animation.advance(25.0, || panic!("fading"));
        assert_eq!(animation.fade(), 128);
        animation.advance(2024.0, || panic!("still waiting"));
        assert_eq!(animation.fade(), 255);
        animation.advance(1.0, || SEED);
        assert!(animation.is_splash());
        assert_eq!(animation.generation, generation + 1);
        assert_eq!(animation.animation_end, 4700.0);
        assert_eq!(animation.fade(), 0);
    }
}
