# bbokeh

Recreates the BlackBerry PlayBook boot animation in your browser, using original graphics from BlackBerry Tablet OS 2.1.0.1917.

## Run locally

Install [Bun](https://bun.sh/) and use a browser with WebGL 2 support.

```sh
cd web
bun install
bun run dev
```

## Deploy to GitHub Pages

In the repository, select **Settings > Pages > Source > GitHub Actions**. Push to `main` or run **Deploy to GitHub Pages** from the Actions tab. The workflow uses the latest Bun and GitHub Pages' configured base path, normally `https://<owner>.github.io/bbokeh/`. Missing URLs serve the app through `404.html` with a 404 status.

## How it works

1. The firmware's `splash_script` starts `winchester-bootreason`, which asks the display driver (`displayHAL-winchester.so`) to show the initial logo. The 494x64 image is centered at `(265, 268)` on the 1024x600 screen.
2. The startup script then launches `playbook_spotlights`, which draws seven small and five large moving lights behind a separate 512x64 PlayBook wordmark at `(253, 266)`. The lights fade, respawn, and change color in a 180-second cycle. The native refresh rate and swap interval give a nominal 30 fps. The other renderer, `splashscreen_winchester`, is not used in this boot sequence.
3. On the tablet, Navigator signals when to fade out. The renderer splits the configured 1000 ms fade between the animation and Navigator; the 90/300-second normal/upgrade timeouts are not fixed animation lengths. The browser models the visuals, not the tablet's boot timing.

bbokeh decodes the original graphics, recreates the motion in TypeScript, and draws each frame with PixiJS and WebGL 2. The preview uses the original bilinear sampling and makes the dark parts of each spotlight transparent to avoid rectangular edges where lights overlap.

## Get the firmware

1. Get your PlayBook autoloader.
2. In [Sachesi](https://github.com/xsacha/Sachesi), choose **Extract > Extract Signed** and select the autoloader `.exe`. Keep `<autoloader_file_name>@OS@IFS.signed`; the radio file is not needed.
3. Check the OS file with `sha256sum`. For the PlayBook 2.1.0.1917 R1315 image used here, the SHA-256 is `ec5b6ce4e689f5ede5d0af425c271731382fa943a4ffaceff2db6a8e47fdc896`.

## Reproduce the bundled assets

Use Debian (WSL works), [bb10mt](https://github.com/bb10root/bb10mt) 0.5.9.999, and [qnxprobe](https://github.com/abrignoni/qnxprobe). You do not need to run the autoloader or mount the firmware.

1. In a scratch directory, symlink the verified OS file as `os.signed` and run `bb10mt unpack -c os.signed`. This version writes beside the link and may exit with status 1 even when it produces `os.lst` and all six images. On Debian it needs `libfuse.so.2`, `libusb-1.0`, and `liblzo2`.
2. Run `python3 qnxprobe.py os.1.rcfs --extract base.zip` to extract the QNX6 filesystem. `os.5.ufs` is not needed.
3. Carve the startup image from `os.4.ifs` and unpack it:

   ```sh
   dd if=os.4.ifs of=ifs-startup.img iflag=skip_bytes,count_bytes skip=$((0x808)) count=$((0x3150c0)) status=none
   python3 qnxprobe.py ifs-startup.img --extract ifs.zip
   ```

4. Extract `lba0/usr/lib/graphics/omap4430/displayHAL-winchester.so` from `ifs.zip` (`H`) and `lba0/usr/bin/playbook_spotlights` from `base.zip` (`S`). Copy the byte ranges below to [`web/public/firmware/`](web/public/firmware/). Range ends are exclusive.

| Output | Source byte ranges | SHA-256 |
| --- | --- | --- |
| `logo-ipl.rle` | `H[0x41978:0x4381a]` | `8b5c94a97dde546a4a797f2e7ebf173309e3f56d87cafc6d692e5e7785f39cbd` |
| `logo-spotlights-la.rle` | `S[0xca04:0xef90]` followed by `S[0x77c4:0xca04]` | `8e0082ce2baf2cb393817680577ac9aa2895b1617de129f231d621d7626f17e6` |
| `spotlight.rle` | `S[0x1508c:0x19bea]` | `58ce21799135d6f9e80170f1cbf24cc61fd27c53910e4add94a71762c7a67469` |
| `spotlight-spawns.f32` | `S[0x7304:0x77ac]` (149 little-endian position pairs) | `f55bcad1ee08a1c98094ca575f267dbd85c1ed1d7bfbab413304a70aebc8e076` |

## Verification

From `web/`, run `bun playback.test.ts` to check replay timing and compare the derived light texture and selected motion frames with the original ARM renderer. REA identified the two renderers. GNU ARM objdump and a Unicorn trace of `0x2b58`, `0x2a34`, and `0x22dc` verified texture uploads and draw order, not physical display timing.

The analyzed `playbook_spotlights` binary has SHA-256 `dc59336d7d1fa5ac1360c3be26f7c638449b2f287d05a07cae075ba1cdd5d7d5`. The analysis exported REA evidence alongside the firmware to `bbokeh-analysis/rea-evidence.json` (active renderer: `ev_37413630f0e03cf68af31288ae2ff6cbb08f3e850941cddc629edc0e0df2057c`; unused renderer: `ev_991da199f7318e5f8d76ccaffe39aa75abc6dc2326c8f13390e2c0ceb8f3cce6`).

## License

[MIT License](LICENSE)
