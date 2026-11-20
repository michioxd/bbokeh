import config from "../../../firmware/playbook.json";
import splashUrl from "../../../firmware/logo-ipl.rle?url&no-inline";
import logoUrl from "../../../firmware/logo-spotlights-la.rle?url&no-inline";
import lightUrl from "../../../firmware/spotlight.rle?url&no-inline";
import spawnsUrl from "../../../firmware/spotlight-spawns.f32?url&no-inline";
import { decodeRle, readSpawnTable } from "./motion";

async function fetchAsset(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

export async function loadBootAssets() {
    const { firstSplash, spotlights } = config;
    const { logo, light } = spotlights;
    const [first, wordmark, quadrant, spawns] = await Promise.all([
        fetchAsset(splashUrl),
        fetchAsset(logoUrl),
        fetchAsset(lightUrl),
        fetchAsset(spawnsUrl),
    ]);
    const firstImage = new Uint8Array(firstSplash.width * firstSplash.height);
    firstImage.set(decodeRle(first, firstSplash.width * firstSplash.decodedRows));
    const logoSize = logo.width * logo.height;
    const luma = decodeRle(wordmark.subarray(0, logo.lumaBytes), logoSize);
    const alpha = decodeRle(wordmark.subarray(logo.lumaBytes), logoSize);
    const logoImage = new Uint8Array(logoSize * 2);
    for (let i = 0; i < logoSize; i++) {
        logoImage[2 * i] = luma[i];
        logoImage[2 * i + 1] = alpha[i];
    }
    return {
        firstImage,
        logoImage,
        quadrant: decodeRle(quadrant, light.quadrantSize ** 2),
        spawns: readSpawnTable(spawns),
    };
}
