import { describe, expect, it } from "vitest";
import {
	buildSkinMask,
	getFaceAt,
	getSkinFaceRegions,
	getSkinRegions,
	repackSkinModelPixels,
	SKIN_SIZE,
} from "@/lib/skinEditor";

describe("skin editor UV helpers", () => {
	it("builds complete classic and slim layer masks", () => {
		const classicBase = buildSkinMask(getSkinRegions("default", "base"));
		const classicOverlay = buildSkinMask(getSkinRegions("default", "overlay"));
		const slimBase = buildSkinMask(getSkinRegions("slim", "base"));
		const slimOverlay = buildSkinMask(getSkinRegions("slim", "overlay"));

		expect(classicBase.reduce((sum, value) => sum + value, 0)).toBe(1632);
		expect(classicOverlay.reduce((sum, value) => sum + value, 0)).toBe(1632);
		expect(slimBase.reduce((sum, value) => sum + value, 0)).toBe(1568);
		expect(slimOverlay.reduce((sum, value) => sum + value, 0)).toBe(1568);
	});

	it("maps atlas pixels to localized face metadata", () => {
		const faces = getSkinFaceRegions("default", "base");
		expect(getFaceAt(faces, 8, 8)).toMatchObject({
			face: "front",
			layer: "base",
			part: "head",
		});
		expect(getFaceAt(faces, 45, 21)).toMatchObject({
			face: "front",
			layer: "base",
			part: "rightArm",
		});
		expect(getFaceAt(faces, 63, 63)).toBeNull();
	});

	it("repacks arm faces and clears slim-only excluded columns", () => {
		const pixels = new Uint8ClampedArray(SKIN_SIZE * SKIN_SIZE * 4);
		const packed = new Uint32Array(pixels.buffer);
		packed[8 * SKIN_SIZE + 8] = 0xff00ff00;
		for (const face of getSkinFaceRegions("default", "base")) {
			if (face.part !== "rightArm" && face.part !== "leftArm") continue;
			for (let y = face.y; y < face.y + face.height; y += 1) {
				for (let x = face.x; x < face.x + face.width; x += 1) {
					packed[y * SKIN_SIZE + x] = 0xff0000ff;
				}
			}
		}

		repackSkinModelPixels(pixels, "default", "slim");

		expect(packed[8 * SKIN_SIZE + 8]).toBe(0xff00ff00);
		expect(packed[20 * SKIN_SIZE + 44]).toBe(0xff0000ff);
		expect(packed[16 * SKIN_SIZE + 54]).toBe(0);
		expect(packed[20 * SKIN_SIZE + 54]).toBe(0);
		expect(packed[52 * SKIN_SIZE + 46]).toBe(0);
	});
});
