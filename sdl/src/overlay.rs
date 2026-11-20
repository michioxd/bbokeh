use std::{mem::offset_of, time::Duration};

use imgui::{BackendFlags, ConfigFlags, DrawCmd, DrawData, DrawVert, Key, TextureId, Ui};
use sdl2::{
    event::{Event, WindowEvent},
    keyboard::{Mod, Scancode},
    mouse::{MouseButton, MouseWheelDirection},
    pixels::PixelFormatEnum,
    rect::Rect,
    render::{BlendMode, Canvas, RenderGeometryTextureParams, Texture, TextureCreator},
    video::{Window, WindowContext},
};

const FONT: TextureId = TextureId::new(1);

pub(super) struct Overlay {
    context: imgui::Context,
    reset_input: bool,
    clipboard_ready: bool,
}

impl Overlay {
    pub(super) fn new() -> Self {
        let mut context = imgui::Context::create();
        context.set_ini_filename(None);
        let io = context.io_mut();
        io.config_flags.insert(ConfigFlags::NAV_ENABLE_KEYBOARD);
        io.backend_flags.insert(BackendFlags::RENDERER_HAS_VTX_OFFSET);
        Self {
            context,
            reset_input: false,
            clipboard_ready: false,
        }
    }

    pub(super) fn font_texture<'a>(
        &mut self,
        creator: &'a TextureCreator<WindowContext>,
    ) -> Result<Texture<'a>, String> {
        let fonts = self.context.fonts();
        let atlas = fonts.build_rgba32_texture();
        let mut texture = creator
            .create_texture_static(PixelFormatEnum::RGBA32, atlas.width, atlas.height)
            .map_err(|e| e.to_string())?;
        texture
            .update(None, atlas.data, atlas.width as usize * 4)
            .map_err(|e| e.to_string())?;
        texture.set_blend_mode(BlendMode::Blend);
        fonts.tex_id = FONT;
        fonts.clear_tex_data();
        Ok(texture)
    }

    pub(super) fn clear_input(&mut self) {
        self.reset_input = true;
        focus(self.context.io_mut(), false);
    }

    pub(super) fn handle_event(&mut self, event: &Event) {
        let io = self.context.io_mut();
        match *event {
            Event::MouseMotion { x, y, .. } => io.add_mouse_pos_event([x as f32, y as f32]),
            Event::MouseButtonDown { mouse_btn, x, y, .. }
            | Event::MouseButtonUp { mouse_btn, x, y, .. } => {
                let button = match mouse_btn {
                    MouseButton::Left => imgui::MouseButton::Left,
                    MouseButton::Right => imgui::MouseButton::Right,
                    MouseButton::Middle => imgui::MouseButton::Middle,
                    MouseButton::X1 => imgui::MouseButton::Extra1,
                    MouseButton::X2 => imgui::MouseButton::Extra2,
                    _ => return,
                };
                io.add_mouse_pos_event([x as f32, y as f32]);
                io.add_mouse_button_event(button, matches!(event, Event::MouseButtonDown { .. }));
            }
            Event::MouseWheel { precise_x, precise_y, direction, mouse_x, mouse_y, .. } => {
                let sign = if direction == MouseWheelDirection::Flipped { -1.0 } else { 1.0 };
                io.add_mouse_pos_event([mouse_x as f32, mouse_y as f32]);
                io.add_mouse_wheel_event([-precise_x * sign, precise_y * sign]);
            }
            Event::TextInput { ref text, .. } => {
                for ch in text.chars() {
                    io.add_input_character(ch);
                }
            }
            Event::KeyDown { scancode, keymod, repeat: false, .. }
            | Event::KeyUp { scancode, keymod, .. } => {
                for (key, mask) in [
                    (Key::ModCtrl, Mod::LCTRLMOD | Mod::RCTRLMOD),
                    (Key::ModShift, Mod::LSHIFTMOD | Mod::RSHIFTMOD),
                    (Key::ModAlt, Mod::LALTMOD | Mod::RALTMOD),
                    (Key::ModSuper, Mod::LGUIMOD | Mod::RGUIMOD),
                ] {
                    io.add_key_event(key, keymod.intersects(mask));
                }
                if let Some(key) = scancode.and_then(imgui_key) {
                    io.add_key_event(key, matches!(event, Event::KeyDown { .. }));
                }
            }
            Event::Window { win_event: WindowEvent::Leave, .. } => {
                io.add_mouse_pos_event([-f32::MAX; 2]);
            }
            Event::Window { win_event: WindowEvent::FocusLost, .. } => focus(io, false),
            Event::Window { win_event: WindowEvent::FocusGained, .. } => focus(io, true),
            _ => {}
        }
    }

    pub(super) fn draw(
        &mut self,
        canvas: &mut Canvas<Window>,
        font: &Texture<'_>,
        delta: Duration,
        controls: impl FnOnce(&Ui),
    ) -> Result<(), String> {
        let (width, height) = canvas.window().size();
        let (pixel_width, pixel_height) = canvas.output_size()?;
        if width == 0 || height == 0 || pixel_width == 0 || pixel_height == 0 {
            return Ok(());
        }
        let first_frame = !self.clipboard_ready;
        if first_frame {
            let clipboard = canvas.window().subsystem().clipboard();
            self.context.set_clipboard_backend(Clipboard(clipboard));
            self.clipboard_ready = true;
        }
        let io = self.context.io_mut();
        io.display_size = [width as f32, height as f32];
        io.display_framebuffer_scale = [
            pixel_width as f32 / width as f32,
            pixel_height as f32 / height as f32,
        ];
        io.update_delta_time(delta);
        let sync_mouse = first_frame || self.reset_input;
        if self.reset_input {
            self.reset_input = false;
            // Drain queued input from before hiding without delivering it to controls.
            focus(io, false);
            let trickle = io.config_input_trickle_event_queue;
            io.config_input_trickle_event_queue = false;
            self.context.new_frame().end_frame_early();
            self.context.io_mut().config_input_trickle_event_queue = trickle;
        }
        if sync_mouse && canvas.window().has_mouse_focus() {
            let (mut x, mut y) = (0, 0);
            // SAFETY: SDL is active and both output pointers are live, distinct integers.
            unsafe { sdl2::sys::SDL_GetMouseState(&mut x, &mut y) };
            self.context.io_mut().add_mouse_pos_event([x as f32, y as f32]);
        }
        controls(self.context.new_frame());
        let data = self.context.render();
        if data.draw_lists_count() == 0 {
            return Ok(());
        }
        let old_scale = canvas.scale();
        let full_window = Rect::new(0, 0, pixel_width, pixel_height);

        canvas.set_scale(1.0, 1.0)?;
        // SDL stores clips/viewports in pixels. Read at unity to avoid rounding them
        // through the previous scale when restoring the animation renderer's state.
        let old_clip = canvas.clip_rect();
        let old_viewport = canvas.viewport();
        let reset_viewport = old_viewport != full_window;
        if reset_viewport {
            canvas.set_viewport(None);
        }
        let result = paint(canvas, font, data, full_window);
        canvas.set_scale(1.0, 1.0)?;
        if reset_viewport {
            canvas.set_viewport(old_viewport);
        }
        canvas.set_clip_rect(old_clip);
        canvas.set_scale(old_scale.0, old_scale.1)?;
        result
    }
}

struct Clipboard(sdl2::clipboard::ClipboardUtil);

impl imgui::ClipboardBackend for Clipboard {
    fn get(&mut self) -> Option<String> {
        self.0.clipboard_text().ok()
    }

    fn set(&mut self, value: &str) {
        if !value.contains('\0') {
            let _ = self.0.set_clipboard_text(value);
        }
    }
}

fn focus(io: &mut imgui::Io, focused: bool) {
    use imgui::internal::RawCast;
    // SAFETY: This is the live IO of the active, exclusively owned context.
    unsafe { imgui::sys::ImGuiIO_AddFocusEvent(io.raw_mut(), focused) };
}

fn paint(
    canvas: &mut Canvas<Window>,
    font: &Texture<'_>,
    data: &DrawData,
    bounds: Rect,
) -> Result<(), String> {
    // The single ImGui viewport has a zero origin, so SDL can scale its window-space vertices directly.
    debug_assert_eq!(data.display_pos, [0.0, 0.0]);
    let [sx, sy] = data.framebuffer_scale;
    for list in data.draw_lists() {
        for cmd in list.commands() {
            let (count, params) = match cmd {
                DrawCmd::Elements { count, cmd_params } => (count, cmd_params),
                DrawCmd::ResetRenderState => continue,
                DrawCmd::RawCallback { .. } => return Err("ImGui draw callbacks are unsupported".into()),
            };
            if count == 0 {
                continue;
            }
            if params.texture_id != FONT {
                return Err("ImGui draw command uses a texture other than the font atlas".into());
            }
            let Some(clip) = pixel_clip(params.clip_rect, [sx, sy], bounds) else { continue };
            // SDL multiplies clip inputs by its current scale; install physical clips at unity.
            canvas.set_scale(1.0, 1.0)?;
            canvas.set_clip_rect(clip);
            canvas.set_scale(sx, sy)?;
            let vertices = &list.vtx_buffer()[params.vtx_offset..];
            let indices = &list.idx_buffer()[params.idx_offset..params.idx_offset + count];
            // SAFETY: repr(C) DrawVert has initialized [f32; 2] position/UV and [u8; 4]
            // RGBA fields at these offsets. All three streams share the same live slice and
            // stride; the command's index slice is relative to its vertex offset.
            unsafe {
                canvas.render_geometry_raw(
                    vertices,
                    offset_of!(DrawVert, pos),
                    vertices,
                    offset_of!(DrawVert, col),
                    Some(RenderGeometryTextureParams {
                        texture: font,
                        tex_coords: vertices,
                        tex_coord_offset: offset_of!(DrawVert, uv),
                    }),
                    indices,
                )?;
            }
        }
    }
    Ok(())
}

fn pixel_clip(clip: [f32; 4], [sx, sy]: [f32; 2], bounds: Rect) -> Option<Rect> {
    let [left, top, right, bottom] = clip;
    let x0 = (left * sx).floor().max(0.0) as i32;
    let y0 = (top * sy).floor().max(0.0) as i32;
    let x1 = (right * sx).ceil().min(bounds.width() as f32) as i32;
    let y1 = (bottom * sy).ceil().min(bounds.height() as f32) as i32;
    (right > left && bottom > top && x1 > x0 && y1 > y0)
        .then(|| Rect::new(x0, y0, (x1 - x0) as u32, (y1 - y0) as u32))
}

fn imgui_key(code: Scancode) -> Option<Key> {
    use Scancode as S;
    // Text comes through SDL TextInput; only named navigation/editing keys need mapping.
    Some(match code {
        S::Tab => Key::Tab,
        S::Left => Key::LeftArrow,
        S::Right => Key::RightArrow,
        S::Up => Key::UpArrow,
        S::Down => Key::DownArrow,
        S::PageUp => Key::PageUp,
        S::PageDown => Key::PageDown,
        S::Home => Key::Home,
        S::End => Key::End,
        S::Insert => Key::Insert,
        S::Delete => Key::Delete,
        S::Backspace => Key::Backspace,
        S::Space => Key::Space,
        S::Return => Key::Enter,
        S::KpEnter => Key::KeypadEnter,
        S::Escape => Key::Escape,
        S::LCtrl => Key::LeftCtrl,
        S::RCtrl => Key::RightCtrl,
        S::LShift => Key::LeftShift,
        S::RShift => Key::RightShift,
        S::LAlt => Key::LeftAlt,
        S::RAlt => Key::RightAlt,
        S::LGui => Key::LeftSuper,
        S::RGui => Key::RightSuper,
        S::A => Key::A,
        S::C => Key::C,
        S::V => Key::V,
        S::X => Key::X,
        S::Y => Key::Y,
        S::Z => Key::Z,
        _ => return None,
    })
}

#[cfg(test)]
#[test]
fn clips_fractional_dpi_to_the_output() {
    let bounds = Rect::new(0, 0, 150, 80);
    assert_eq!(
        pixel_clip([-5.0, 2.5, 105.0, 3.1], [1.5, 2.0], bounds),
        Some(Rect::new(0, 5, 150, 2))
    );
    assert_eq!(pixel_clip([100.0, 0.0, 120.0, 20.0], [1.5, 2.0], bounds), None);
}
