mod animation;
mod overlay;

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use animation::{Animation, HEIGHT, LIGHT_SIZE, LOGO_POS, LOGO_SIZE, SPLASH_POS, SPLASH_SIZE, WIDTH};
use imgui::{Condition, Ui};
use overlay::Overlay;
use sdl2::{
    EventPump,
    event::{Event, WindowEvent},
    keyboard::Keycode,
    pixels::{Color, PixelFormatEnum},
    rect::{FRect, Rect},
    render::{self, BlendMode, ScaleMode, Texture, TextureCreator, WindowCanvas},
    video::{FullscreenType, Window, WindowContext},
};

fn seed() -> u32 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as u32
}

struct Settings {
    driver: usize,
    portrait: bool,
    fit: bool,
    logo: bool,
    speed: f64,
    forever: bool,
    duration: f64,
    delay: f64,
    fullscreen: bool,
}

impl Settings {
    fn new(animation: &Animation) -> Self {
        let [duration, delay] = animation.default_timing();
        Self {
            driver: 0,
            portrait: false,
            fit: true,
            logo: true,
            speed: 1.0,
            forever: true,
            duration,
            delay,
            fullscreen: false,
        }
    }

    fn replay_delay(&self) -> Option<f64> {
        (!self.forever).then_some(self.delay * 1000.0)
    }
}

struct Textures<'a> {
    splash: Texture<'a>,
    logo: Texture<'a>,
    light: Texture<'a>,
    font: Texture<'a>,
    generation: u64,
}

impl<'a> Textures<'a> {
    fn new(
        creator: &'a TextureCreator<WindowContext>,
        overlay: &mut Overlay,
        animation: &Animation,
    ) -> Result<Self, String> {
        let create = |[w, h]: [u32; 2], pixels: &[u8], scale, blend| {
            let mut texture = creator.create_texture_static(PixelFormatEnum::RGBA32, w, h)
                .map_err(|err| err.to_string())?;
            texture.update(None, pixels, w as usize * 4).map_err(|err| err.to_string())?;
            texture.set_scale_mode(scale);
            texture.set_blend_mode(blend);
            Ok::<_, String>(texture)
        };
        Ok(Self {
            splash: create(SPLASH_SIZE, &animation.splash_rgba, ScaleMode::Nearest, BlendMode::None)?,
            logo: create(LOGO_SIZE, &animation.logo_rgba, ScaleMode::Linear, BlendMode::Blend)?,
            light: create([LIGHT_SIZE; 2], &animation.light_rgba, ScaleMode::Linear, BlendMode::Blend)?,
            font: overlay.font_texture(creator)?,
            generation: animation.generation,
        })
    }

    fn draw(&mut self, canvas: &mut WindowCanvas, animation: &Animation, settings: &Settings) -> Result<(), String> {
        canvas.set_draw_color(Color::BLACK);
        canvas.clear();
        let (out_w, out_h) = canvas.output_size()?;
        if out_w == 0 || out_h == 0 {
            return Ok(());
        }
        let [w, h] = if settings.portrait { [HEIGHT, WIDTH] } else { [WIDTH, HEIGHT] }.map(|v| v as f32);
        let [out_w, out_h] = [out_w as f32, out_h as f32];
        let scale = if settings.fit || settings.fullscreen { (out_w / w).min(out_h / h) } else { 1.0 };
        let [left, top] = [(out_w - w * scale) * 0.5, (out_h - h * scale) * 0.5];
        let clip = Rect::new(left.round() as i32, top.round() as i32, (w * scale).round().max(1.0) as u32, (h * scale).round().max(1.0) as u32);
        canvas.set_clip_rect(clip);
        let draw = |canvas: &mut WindowCanvas, texture: &Texture<'_>, [x, y]: [f32; 2], [w, h]: [f32; 2]| {
            let (x, y) = if settings.portrait {
                (HEIGHT as f32 - y - (w + h) * 0.5, x + (w - h) * 0.5)
            } else {
                (x, y)
            };
            let dst = FRect::new(left + x * scale, top + y * scale, w * scale, h * scale);
            if settings.portrait {
                canvas.copy_ex_f(texture, None, dst, 90.0, None, false, false)
            } else {
                canvas.copy_f(texture, None, dst)
            }
        };
        if animation.is_splash() && settings.logo {
            draw(canvas, &self.splash, SPLASH_POS, SPLASH_SIZE.map(|v| v as f32))?;
        }
        if animation.is_spotlights() {
            if self.generation != animation.generation {
                self.light.update(None, &animation.light_rgba, LIGHT_SIZE as usize * 4)
                    .map_err(|err| err.to_string())?;
                self.generation = animation.generation;
            }
            for quad in &animation.quads {
                if quad.alpha <= 0.0 || quad.size <= 0.0 { continue; }
                let [r, g, b] = quad.rgb.map(|v| (v * 255.0).round() as u8);
                self.light.set_color_mod(r, g, b);
                self.light.set_alpha_mod((quad.alpha * 255.0).round() as u8);
                draw(canvas, &self.light, [quad.x, quad.y], [quad.size; 2])?;
            }
            if settings.logo {
                draw(canvas, &self.logo, LOGO_POS, LOGO_SIZE.map(|v| v as f32))?;
            }
        }
        let fade = animation.fade();
        if fade != 0 {
            canvas.set_blend_mode(BlendMode::Blend);
            canvas.set_draw_color(Color::RGBA(0, 0, 0, fade));
            canvas.fill_rect(clip)?;
        }
        canvas.set_clip_rect(None);
        Ok(())
    }
}

struct Preview {
    animation: Animation,
    settings: Settings,
    show_overlay: bool,
    driver_names: Vec<&'static str>,
    driver_error: Option<String>,
}

impl Preview {
    fn controls(&mut self, ui: &Ui, driver: &str) {
        let Self { animation, settings, driver_names, driver_error, .. } = self;
        ui.window("Playback and rendering")
            .position([12.0, 12.0], Condition::FirstUseEver)
            .size([380.0, 345.0], Condition::FirstUseEver)
            .bg_alpha(0.93)
            .build(|| {
                ui.text("Esc to hide settings");
                if ui.button("Restart") { animation.restart(seed()); }
                ui.same_line();
                if ui.button(if animation.playing { "Pause" } else { "Play" }) {
                    animation.playing = !animation.playing;
                }
                ui.same_line();
                if ui.button("Fade out") { animation.fade_out(); }
                for (label, step) in [("<<", -10), ("<", -1), (">", 1), (">>", 10)] {
                    if step != -10 { ui.same_line(); }
                    if ui.button(label) { animation.step(step); }
                }
                ui.separator();
                let mut orientation = usize::from(settings.portrait);
                if ui.combo_simple_string("Orientation", &mut orientation, &["Landscape", "Portrait"]) {
                    settings.portrait = orientation == 1;
                }
                ui.checkbox("Fit to window", &mut settings.fit);
                ui.same_line();
                ui.checkbox("Show logo", &mut settings.logo);
                ui.same_line();
                ui.checkbox("Fullscreen", &mut settings.fullscreen);
                ui.combo_simple_string("SDL2 driver", &mut settings.driver, driver_names);
                ui.text(driver);
                if let Some(error) = driver_error.as_deref() { ui.text_wrapped(error); }
                if ui.slider_config("Speed", 0.1, 10.0).display_format("%.1fx").build(&mut settings.speed) {
                    settings.speed = (settings.speed * 10.0).round() / 10.0;
                    animation.set_speed(settings.speed);
                }
                if ui.checkbox("Loop forever", &mut settings.forever) {
                    animation.set_replay_delay(settings.replay_delay());
                }
                let disabled = ui.begin_disabled(settings.forever);
                if edit_seconds(ui, "Spotlight duration (s)", &mut settings.duration) {
                    animation.set_duration(settings.duration * 1000.0);
                }
                if edit_seconds(ui, "Replay delay (s)", &mut settings.delay) {
                    animation.set_replay_delay(settings.replay_delay());
                }
                disabled.end();
                if ui.button("Reset settings") {
                    *settings = Settings::new(animation);
                    *driver_error = None;
                    animation.set_speed(settings.speed);
                    animation.set_duration(settings.duration * 1000.0);
                    animation.set_replay_delay(settings.replay_delay());
                }
            });
    }
}

fn edit_seconds(ui: &Ui, label: &str, seconds: &mut f64) -> bool {
    ui.set_next_item_width((ui.content_region_avail()[0] - ui.calc_text_size(label)[0] - 12.0).max(80.0));
    let mut value = *seconds;
    if ui.input_scalar(label, &mut value).step(0.1).display_format("%.1f").build()
        && value >= 0.0 && (value * 1000.0).is_finite()
    {
        *seconds = value;
        return true;
    }
    false
}

fn make_canvas(window: Window, driver: usize) -> Result<WindowCanvas, String> {
    let mut builder = window.into_canvas();
    if driver != 0 { builder = builder.index((driver - 1) as u32); }
    builder.build().map_err(|err| err.to_string())
}

fn run() -> Result<(), String> {
    let sdl = sdl2::init()?;
    let video = sdl.video()?;
    let window = video.window("bbokeh", WIDTH, HEIGHT)
        .position_centered().resizable().allow_highdpi().build().map_err(|err| err.to_string())?;
    let animation = Animation::new(seed())?;
    let settings = Settings::new(&animation);
    let mut preview = Preview {
        animation,
        settings,
        show_overlay: false,
        driver_names: std::iter::once("Automatic").chain(render::drivers().map(|driver| driver.name)).collect(),
        driver_error: None,
    };
    let mut overlay = Overlay::new();
    video.text_input().stop();
    let mut events = sdl.event_pump()?;
    let mut active_driver = 0;
    loop {
        let requested = preview.settings.driver;
        let mut canvas = match make_canvas(window.clone(), requested) {
            Ok(canvas) => {
                active_driver = requested;
                canvas
            }
            Err(err) if requested != active_driver => {
                preview.driver_error = Some(format!("{} unavailable: {err}", preview.driver_names[requested]));
                preview.settings.driver = active_driver;
                make_canvas(window.clone(), active_driver)?
            }
            Err(err) => return Err(err),
        };
        if !run_renderer(&mut canvas, &mut events, &mut preview, &mut overlay)? { return Ok(()); }
    }
}

fn run_renderer(
    canvas: &mut WindowCanvas,
    events: &mut EventPump,
    preview: &mut Preview,
    overlay: &mut Overlay,
) -> Result<bool, String> {
    let creator = canvas.texture_creator();
    let mut textures = Textures::new(&creator, overlay, &preview.animation)?;
    let driver = canvas.info().name;
    let selection = preview.settings.driver;
    let mut last = Instant::now();
    loop {
        let now = Instant::now();
        let delta = (now - last).min(Duration::from_millis(100));
        last = now;
        for event in events.poll_iter() {
            match event {
                Event::Quit { .. }
                | Event::Window { win_event: WindowEvent::Close, .. } => return Ok(false),
                Event::KeyDown { keycode: Some(Keycode::Space), repeat: false, .. }
                    if !preview.show_overlay =>
                {
                    preview.show_overlay = true;
                    canvas.window().subsystem().text_input().start();
                }
                Event::KeyDown { keycode: Some(Keycode::Escape), repeat: false, .. } => {
                    if preview.show_overlay {
                        preview.show_overlay = false;
                        canvas.window().subsystem().text_input().stop();
                        overlay.clear_input();
                    } else {
                        preview.settings.fullscreen = false;
                    }
                }
                Event::RenderDeviceReset { .. } => {
                    textures = Textures::new(&creator, overlay, &preview.animation)?;
                }
                _ if preview.show_overlay => overlay.handle_event(&event),
                _ => {}
            }
        }
        preview.animation.advance(delta.as_secs_f64() * 1000.0, seed);
        textures.draw(canvas, &preview.animation, &preview.settings)?;
        if preview.show_overlay {
            overlay.draw(canvas, &textures.font, delta, |ui| preview.controls(ui, driver))?;
        }
        canvas.present();
        let fullscreen = if preview.settings.fullscreen {
            FullscreenType::Desktop
        } else {
            FullscreenType::Off
        };
        if canvas.window().fullscreen_state() != fullscreen
            && let Err(err) = canvas.window_mut().set_fullscreen(fullscreen)
        {
            preview.settings.fullscreen = canvas.window().fullscreen_state() != FullscreenType::Off;
            preview.driver_error = Some(format!("Could not change fullscreen: {err}"));
        }
        if preview.settings.driver != selection {
            preview.driver_error = None;
            return Ok(true);
        }
        std::thread::sleep(Duration::from_nanos(16_666_667).saturating_sub(now.elapsed()));
    }
}

fn main() -> Result<(), String> {
    run()
}
