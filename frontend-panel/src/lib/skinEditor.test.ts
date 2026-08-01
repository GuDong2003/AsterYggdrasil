import { describe, expect, it, vi } from "vitest";
import {
	analyzeSkinImageDimensions,
	buildSkinMask,
	detectSkinModel,
	floodFillSkinPixels,
	getFaceAt,
	getSkinFaceRegions,
	getSkinRegions,
	normalizeSkinImage,
	repackSkinModelPixels,
	restoreSkinHistoryEntry,
	SKIN_SIZE,
	type SkinEditorHistoryEntry,
	swapPackedPixelColors,
} from "@/lib/skinEditor";

type PixelSource = {
	height: number;
	pixels: Uint8ClampedArray;
	width: number;
};

class PixelCanvas implements PixelSource {
	private canvasHeight = 0;
	private canvasWidth = 0;
	pixels = new Uint8ClampedArray();
	readonly context = new PixelCanvasContext(this);

	get height() {
		return this.canvasHeight;
	}

	set height(value: number) {
		this.canvasHeight = value;
		this.resizePixels();
	}

	get width() {
		return this.canvasWidth;
	}

	set width(value: number) {
		this.canvasWidth = value;
		this.resizePixels();
	}

	getContext() {
		return this.context;
	}

	private resizePixels() {
		this.pixels = new Uint8ClampedArray(
			this.canvasWidth * this.canvasHeight * 4,
		);
	}
}

class PixelCanvasContext {
	imageSmoothingEnabled = true;
	private scaleX = 1;
	private readonly savedScales: number[] = [];

	constructor(readonly canvas: PixelCanvas) {}

	clearRect(x: number, y: number, width: number, height: number) {
		for (let offsetY = 0; offsetY < height; offsetY += 1) {
			for (let offsetX = 0; offsetX < width; offsetX += 1) {
				setPixel(
					this.canvas.pixels,
					this.canvas.width,
					x + offsetX,
					y + offsetY,
					[0, 0, 0, 0],
				);
			}
		}
	}

	drawImage(source: PixelSource, ...coordinates: number[]) {
		const [
			sourceX,
			sourceY,
			sourceWidth,
			sourceHeight,
			destinationX,
			destinationY,
			destinationWidth,
			destinationHeight,
		] =
			coordinates.length === 4
				? [
						0,
						0,
						source.width,
						source.height,
						coordinates[0],
						coordinates[1],
						coordinates[2],
						coordinates[3],
					]
				: coordinates;
		const sourcePixels = new Uint8ClampedArray(source.pixels);
		const targetWidth = Math.abs(destinationWidth);
		const targetHeight = Math.abs(destinationHeight);
		const logicalLeft =
			destinationWidth < 0 ? destinationX + destinationWidth : destinationX;
		for (let offsetY = 0; offsetY < targetHeight; offsetY += 1) {
			for (let offsetX = 0; offsetX < targetWidth; offsetX += 1) {
				const sampledX =
					sourceX + Math.floor((offsetX * sourceWidth) / targetWidth);
				const sampledY =
					sourceY + Math.floor((offsetY * sourceHeight) / targetHeight);
				const logicalX = logicalLeft + offsetX;
				const targetX = this.scaleX === -1 ? -logicalX - 1 : logicalX;
				const sourceOffset = (sampledY * source.width + sampledX) * 4;
				setPixel(
					this.canvas.pixels,
					this.canvas.width,
					targetX,
					destinationY + offsetY,
					[
						sourcePixels[sourceOffset],
						sourcePixels[sourceOffset + 1],
						sourcePixels[sourceOffset + 2],
						sourcePixels[sourceOffset + 3],
					],
				);
			}
		}
	}

	getImageData(x: number, y: number, width: number, height: number) {
		const data = new Uint8ClampedArray(width * height * 4);
		for (let offsetY = 0; offsetY < height; offsetY += 1) {
			for (let offsetX = 0; offsetX < width; offsetX += 1) {
				const sourceOffset =
					((y + offsetY) * this.canvas.width + x + offsetX) * 4;
				const targetOffset = (offsetY * width + offsetX) * 4;
				data.set(
					this.canvas.pixels.subarray(sourceOffset, sourceOffset + 4),
					targetOffset,
				);
			}
		}
		return { data, height, width } as ImageData;
	}

	restore() {
		this.scaleX = this.savedScales.pop() ?? 1;
	}

	save() {
		this.savedScales.push(this.scaleX);
	}

	scale(x: number) {
		this.scaleX *= x;
	}
}

function pixelSource(
	width: number,
	height: number,
	color: readonly [number, number, number, number],
): PixelSource {
	const pixels = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			setPixel(pixels, width, x, y, color);
		}
	}
	return { height, pixels, width };
}

function readPixel(source: PixelSource, x: number, y: number) {
	const offset = (y * source.width + x) * 4;
	return Array.from(source.pixels.slice(offset, offset + 4));
}

function normalizeWithPixelCanvas(source: PixelSource) {
	const canvas = new PixelCanvas();
	vi.spyOn(document, "createElement").mockReturnValueOnce(
		canvas as unknown as HTMLCanvasElement,
	);
	return normalizeSkinImage(
		source as unknown as CanvasImageSource & { height: number; width: number },
	) as unknown as PixelCanvas;
}

function fakeSkinCanvas(size: number) {
	const pixels = new Uint8ClampedArray(size * size * 4);
	for (let offset = 0; offset < pixels.length; offset += 4) {
		pixels[offset] = 120;
		pixels[offset + 1] = 80;
		pixels[offset + 2] = 40;
		pixels[offset + 3] = 255;
	}
	const canvas = {
		height: size,
		width: size,
		getContext: () => ({
			getImageData: (x: number, y: number, width: number, height: number) => {
				const data = new Uint8ClampedArray(width * height * 4);
				for (let offsetY = 0; offsetY < height; offsetY += 1) {
					for (let offsetX = 0; offsetX < width; offsetX += 1) {
						const sourceOffset = ((y + offsetY) * size + x + offsetX) * 4;
						const targetOffset = (offsetY * width + offsetX) * 4;
						data.set(
							pixels.subarray(sourceOffset, sourceOffset + 4),
							targetOffset,
						);
					}
				}
				return { data, height, width } as ImageData;
			},
		}),
	} as unknown as HTMLCanvasElement;
	return { canvas, pixels };
}

function setPixel(
	pixels: Uint8ClampedArray,
	size: number,
	x: number,
	y: number,
	color: readonly [number, number, number, number],
) {
	pixels.set(color, (y * size + x) * 4);
}

function setRect(
	pixels: Uint8ClampedArray,
	size: number,
	x: number,
	y: number,
	width: number,
	height: number,
	color: readonly [number, number, number, number],
) {
	for (let offsetY = 0; offsetY < height; offsetY += 1) {
		for (let offsetX = 0; offsetX < width; offsetX += 1) {
			setPixel(pixels, size, x + offsetX, y + offsetY, color);
		}
	}
}

type HistoryState = {
	image: ImageData;
	model: SkinEditorHistoryEntry["model"];
	stateId: number;
};

function historyImage(
	size: number,
	color: readonly [number, number, number, number],
) {
	const data = new Uint8ClampedArray(size * size * 4);
	for (let offset = 0; offset < data.length; offset += 4) {
		data.set(color, offset);
	}
	return { data, height: size, width: size } as ImageData;
}

function cloneHistoryImage(image: ImageData) {
	return {
		data: new Uint8ClampedArray(image.data),
		height: image.height,
		width: image.width,
	} as ImageData;
}

function applyHistoryEntry(
	state: HistoryState,
	entry: SkinEditorHistoryEntry,
	savedStateId: number,
) {
	const restored = restoreSkinHistoryEntry(
		entry,
		{
			model: state.model,
			savedStateId,
			size: state.image.width,
			stateId: state.stateId,
		},
		{
			restoreSnapshot: (image) => {
				state.image = cloneHistoryImage(image);
			},
			snapshot: () => cloneHistoryImage(state.image),
			swapPixels: (indices, colors, size) => {
				expect(state.image.width).toBe(size);
				const previous = new Uint32Array(indices.length);
				for (let index = 0; index < indices.length; index += 1) {
					const offset = indices[index] * 4;
					previous[index] = swapPackedPixelColors(
						state.image.data.subarray(offset, offset + 4),
						colors.subarray(index, index + 1),
					)[0];
				}
				return previous;
			},
		},
	);
	state.model = restored.model;
	state.stateId = restored.stateId;
	return restored;
}

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

	it("scales UV regions and masks with the source resolution", () => {
		for (const size of [128, 256]) {
			const scale = size / SKIN_SIZE;
			const regions = getSkinRegions("default", "base", size);
			const mask = buildSkinMask(regions, size);
			expect(mask).toHaveLength(size * size);
			expect(mask.reduce((sum, value) => sum + value, 0)).toBe(
				1632 * scale * scale,
			);
		}

		const faces = getSkinFaceRegions("default", "base", 128);
		expect(getFaceAt(faces, 16, 16)).toMatchObject({
			face: "front",
			part: "head",
		});
	});

	it("accepts integer skin scales and enforces the normalized pixel limit", () => {
		expect(analyzeSkinImageDimensions(64, 64)).toEqual({
			legacy: false,
			scale: 1,
			size: 64,
		});
		expect(analyzeSkinImageDimensions(128, 64)).toEqual({
			legacy: true,
			scale: 2,
			size: 128,
		});
		expect(analyzeSkinImageDimensions(192, 192)).toEqual({
			legacy: false,
			scale: 3,
			size: 192,
		});
		expect(analyzeSkinImageDimensions(4096, 4096, 4096 * 4096)).toEqual({
			legacy: false,
			scale: 64,
			size: 4096,
		});

		expect(() => analyzeSkinImageDimensions(96, 96)).toThrow(
			"invalid_skin_dimensions:96x96",
		);
		expect(() => analyzeSkinImageDimensions(4096, 2048, 4096 * 2048)).toThrow(
			"skin_pixel_limit_exceeded:4096x2048",
		);
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

	it("repacks high-resolution arm pixels without changing other parts", () => {
		const size = 128;
		const pixels = new Uint8ClampedArray(size * size * 4);
		const packed = new Uint32Array(pixels.buffer);
		packed[16 * size + 16] = 0xff00ff00;
		for (const face of getSkinFaceRegions("default", "base", size)) {
			if (face.part !== "rightArm" && face.part !== "leftArm") continue;
			for (let y = face.y; y < face.y + face.height; y += 1) {
				for (let x = face.x; x < face.x + face.width; x += 1) {
					packed[y * size + x] = 0xff0000ff;
				}
			}
		}

		repackSkinModelPixels(pixels, "default", "slim", size);

		expect(packed[16 * size + 16]).toBe(0xff00ff00);
		expect(packed[40 * size + 88]).toBe(0xff0000ff);
		expect(packed[32 * size + 108]).toBe(0);
		expect(packed[40 * size + 108]).toBe(0);
		expect(packed[104 * size + 92]).toBe(0);
	});

	it("preserves opaque overlay pixels on modern skins", () => {
		const source = pixelSource(64, 64, [12, 34, 56, 255]);
		setPixel(source.pixels, 64, 40, 8, [220, 30, 40, 255]);

		const normalized = normalizeWithPixelCanvas(source);

		expect(normalized.width).toBe(64);
		expect(normalized.height).toBe(64);
		expect(readPixel(normalized, 40, 8)).toEqual([220, 30, 40, 255]);
	});

	it("mirrors legacy limbs and only clears overlays for opaque legacy skins", () => {
		const opaque = pixelSource(64, 32, [12, 34, 56, 255]);
		setPixel(opaque.pixels, 64, 4, 20, [220, 30, 40, 255]);
		setPixel(opaque.pixels, 64, 7, 20, [40, 80, 220, 255]);
		setPixel(opaque.pixels, 64, 40, 8, [200, 180, 20, 255]);

		const normalizedOpaque = normalizeWithPixelCanvas(opaque);
		expect(normalizedOpaque.height).toBe(64);
		expect(readPixel(normalizedOpaque, 23, 52)).toEqual([220, 30, 40, 255]);
		expect(readPixel(normalizedOpaque, 20, 52)).toEqual([40, 80, 220, 255]);
		expect(readPixel(normalizedOpaque, 40, 8)).toEqual([0, 0, 0, 0]);

		const transparent = pixelSource(64, 32, [12, 34, 56, 255]);
		setPixel(transparent.pixels, 64, 0, 0, [0, 0, 0, 0]);
		setPixel(transparent.pixels, 64, 40, 8, [200, 180, 20, 255]);
		const normalizedTransparent = normalizeWithPixelCanvas(transparent);
		expect(readPixel(normalizedTransparent, 40, 8)).toEqual([
			200, 180, 20, 255,
		]);
	});

	it("detects classic, slim, high-resolution, and legacy models", () => {
		const classic = fakeSkinCanvas(64);
		expect(detectSkinModel(classic.canvas)).toBe("default");

		const slim = fakeSkinCanvas(64);
		setPixel(slim.pixels, 64, 50, 16, [0, 0, 0, 0]);
		expect(detectSkinModel(slim.canvas)).toBe("slim");

		const highResolutionSlim = fakeSkinCanvas(128);
		setPixel(highResolutionSlim.pixels, 128, 100, 32, [0, 0, 0, 0]);
		expect(detectSkinModel(highResolutionSlim.canvas)).toBe("slim");

		const legacy = fakeSkinCanvas(64);
		legacy.canvas.getContext = () => {
			throw new Error("legacy model detection should not inspect padding");
		};
		expect(detectSkinModel(legacy.canvas, true)).toBe("default");
	});

	it("recognizes black and white slim template padding", () => {
		for (const color of [
			[0, 0, 0, 255],
			[255, 255, 255, 255],
		] as const) {
			const template = fakeSkinCanvas(64);
			for (const [x, y, width, height] of [
				[50, 16, 2, 4],
				[54, 20, 2, 12],
				[42, 48, 2, 4],
				[46, 52, 2, 12],
			] as const) {
				setRect(template.pixels, 64, x, y, width, height, color);
			}
			expect(detectSkinModel(template.canvas)).toBe("slim");
		}
	});

	it("flood fills only connected matching pixels inside the active mask", () => {
		const pixels = new Uint8ClampedArray(SKIN_SIZE * SKIN_SIZE * 4);
		const mask = new Uint8Array(SKIN_SIZE * SKIN_SIZE).fill(1);
		for (let y = 0; y < SKIN_SIZE; y += 1) {
			for (let x = 0; x < SKIN_SIZE; x += 1) {
				setPixel(pixels, SKIN_SIZE, x, y, [10, 20, 30, 255]);
			}
			setPixel(pixels, SKIN_SIZE, 2, y, [90, 80, 70, 255]);
		}

		expect(
			floodFillSkinPixels(pixels, SKIN_SIZE, mask, 0, 0, [1, 2, 3, 255]),
		).toBe(true);
		expect(Array.from(pixels.slice(0, 4))).toEqual([1, 2, 3, 255]);
		expect(Array.from(pixels.slice(2 * 4, 3 * 4))).toEqual([90, 80, 70, 255]);
		expect(Array.from(pixels.slice(3 * 4, 4 * 4))).toEqual([10, 20, 30, 255]);
	});

	it("swaps packed history colors reversibly for undo and redo", () => {
		const pixels = Uint8ClampedArray.from([10, 20, 30, 255, 40, 50, 60, 128]);
		const original = new Uint8ClampedArray(pixels);
		const replacement = Uint32Array.from([0xff030201, 0x80665a4e]);

		const undoColors = swapPackedPixelColors(pixels, replacement);
		expect(Array.from(pixels)).toEqual([1, 2, 3, 255, 78, 90, 102, 128]);

		const redoColors = swapPackedPixelColors(pixels, undoColors);
		expect(pixels).toEqual(original);
		expect(redoColors).toEqual(replacement);
	});

	it("restores snapshot history across resolutions and models", () => {
		const savedStateId = 3;
		const original = historyImage(64, [10, 20, 30, 255]);
		setPixel(original.data, 64, 8, 8, [1, 2, 3, 255]);
		const edited = historyImage(128, [40, 50, 60, 255]);
		setPixel(edited.data, 128, 16, 16, [4, 5, 6, 255]);
		const state: HistoryState = {
			image: edited,
			model: "slim",
			stateId: 8,
		};
		const undoEntry: SkinEditorHistoryEntry = {
			image: original,
			kind: "snapshot",
			model: "default",
			stateId: savedStateId,
		};

		const undone = applyHistoryEntry(state, undoEntry, savedStateId);
		expect(state.image.width).toBe(64);
		expect(
			readPixel({ height: 64, pixels: state.image.data, width: 64 }, 8, 8),
		).toEqual([1, 2, 3, 255]);
		expect(state.model).toBe("default");
		expect(state.stateId).toBe(savedStateId);
		expect(undone.dirty).toBe(false);

		const redone = applyHistoryEntry(state, undone.inverse, savedStateId);
		expect(state.image.width).toBe(128);
		expect(
			readPixel({ height: 128, pixels: state.image.data, width: 128 }, 16, 16),
		).toEqual([4, 5, 6, 255]);
		expect(state.model).toBe("slim");
		expect(state.stateId).toBe(8);
		expect(redone.dirty).toBe(true);
	});

	it("restores sparse pixel history and produces a reversible inverse", () => {
		const image = historyImage(128, [0, 0, 0, 0]);
		const indices = Uint32Array.from([0, 128 * 64 + 91]);
		setPixel(image.data, 128, 0, 0, [1, 2, 3, 255]);
		setPixel(image.data, 128, 91, 64, [4, 5, 6, 128]);
		const state: HistoryState = { image, model: "slim", stateId: 9 };
		const undoEntry: SkinEditorHistoryEntry = {
			colors: Uint32Array.from([0xff1e140a, 0x80463c32]),
			indices,
			kind: "pixels",
			model: "slim",
			size: 128,
			stateId: 8,
		};

		const undone = applyHistoryEntry(state, undoEntry, 7);
		expect(Array.from(state.image.data.slice(0, 4))).toEqual([10, 20, 30, 255]);
		const secondOffset = indices[1] * 4;
		expect(
			Array.from(state.image.data.slice(secondOffset, secondOffset + 4)),
		).toEqual([50, 60, 70, 128]);
		expect(state.stateId).toBe(8);
		expect(undone.dirty).toBe(true);

		const redone = applyHistoryEntry(state, undone.inverse, 7);
		expect(Array.from(state.image.data.slice(0, 4))).toEqual([1, 2, 3, 255]);
		expect(
			Array.from(state.image.data.slice(secondOffset, secondOffset + 4)),
		).toEqual([4, 5, 6, 128]);
		expect(state.stateId).toBe(9);
		expect(redone.inverse).toEqual(undoEntry);
	});
});
