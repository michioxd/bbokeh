import config from "./playbook.json";
import { decodeRle, readSpawnTable } from "./motion";

async function fetchAsset(name: string) {
    const response = await fetch(`${import.meta.env.BASE_URL}firmware/${name}`);
    if (!response.ok) throw new Error(`Could not load ${name}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

export async function loadBootAssets() {
    const { firstSplash, spotlights } = config;
    const { logo, light } = spotlights;
    const [first, wordmark, quadrant, spawns] = await Promise.all([
        fetchAsset(firstSplash.file),
        fetchAsset(logo.file),
        fetchAsset(light.file),
        fetchAsset(spotlights.spawnTable),
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
