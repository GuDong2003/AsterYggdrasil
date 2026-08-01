import { inferModelType } from "skinview-utils";
import type { MinecraftTextureModel } from "@/types/api";

export const SKIN_SIZE = 64;
export const EDITOR_CANVAS_SIZE = 1024;

export type SkinImageDimensions = {
	legacy: boolean;
	scale: number;
	size: number;
};

export type SkinEditorLayer = "base" | "overlay";
export type SkinEditorTool = "brush" | "eraser" | "picker" | "bucket";
export type SkinEditorHistoryEntry =
	| {
			image: ImageData;
			kind: "snapshot";
			model: MinecraftTextureModel;
			stateId: number;
	  }
	| {
			colors: Uint32Array;
			indices: Uint32Array;
			kind: "pixels";
			model: MinecraftTextureModel;
			size: number;
			stateId: number;
	  };

export type SkinEditorHistoryRestoreOperations = {
	restoreSnapshot: (image: ImageData) => void;
	snapshot: () => ImageData;
	swapPixels: (
		indices: Uint32Array,
		colors: Uint32Array,
		size: number,
	) => Uint32Array;
};

export type SkinEditorHistoryRestoreResult = {
	dirty: boolean;
	inverse: SkinEditorHistoryEntry;
	model: MinecraftTextureModel;
	stateId: number;
};
export type SkinPart =
	| "head"
	| "body"
	| "rightArm"
	| "leftArm"
	| "rightLeg"
	| "leftLeg";
export type SkinFace = "top" | "bottom" | "right" | "front" | "left" | "back";
export type SkinRect = readonly [
	x: number,
	y: number,
	width: number,
	height: number,
];

export type SkinFaceRegion = {
	face: SkinFace;
	height: number;
	layer: SkinEditorLayer;
	part: SkinPart;
	width: number;
	x: number;
	y: number;
};

type SkinBox = {
	depth: number;
	height: number;
	part: SkinPart;
	u: number;
	v: number;
	width: number;
};

function skinBoxes(
	model: MinecraftTextureModel,
	layer: SkinEditorLayer,
): SkinBox[] {
	const armWidth = model === "slim" ? 3 : 4;
	if (layer === "base") {
		return [
			{ part: "head", u: 0, v: 0, width: 8, height: 8, depth: 8 },
			{ part: "body", u: 16, v: 16, width: 8, height: 12, depth: 4 },
			{
				part: "rightLeg",
				u: 0,
				v: 16,
				width: 4,
				height: 12,
				depth: 4,
			},
			{
				part: "leftLeg",
				u: 16,
				v: 48,
				width: 4,
				height: 12,
				depth: 4,
			},
			{
				part: "rightArm",
				u: 40,
				v: 16,
				width: armWidth,
				height: 12,
				depth: 4,
			},
			{
				part: "leftArm",
				u: 32,
				v: 48,
				width: armWidth,
				height: 12,
				depth: 4,
			},
		];
	}
	return [
		{ part: "head", u: 32, v: 0, width: 8, height: 8, depth: 8 },
		{ part: "body", u: 16, v: 32, width: 8, height: 12, depth: 4 },
		{
			part: "rightLeg",
			u: 0,
			v: 32,
			width: 4,
			height: 12,
			depth: 4,
		},
		{
			part: "leftLeg",
			u: 0,
			v: 48,
			width: 4,
			height: 12,
			depth: 4,
		},
		{
			part: "rightArm",
			u: 40,
			v: 32,
			width: armWidth,
			height: 12,
			depth: 4,
		},
		{
			part: "leftArm",
			u: 48,
			v: 48,
			width: armWidth,
			height: 12,
			depth: 4,
		},
	];
}

function boxFaces(box: SkinBox, layer: SkinEditorLayer): SkinFaceRegion[] {
	const { depth, height, part, u, v, width } = box;
	const regions: Array<[SkinFace, number, number, number, number]> = [
		["top", u + depth, v, width, depth],
		["bottom", u + depth + width, v, width, depth],
		["right", u, v + depth, depth, height],
		["front", u + depth, v + depth, width, height],
		["left", u + depth + width, v + depth, depth, height],
		["back", u + depth + width + depth, v + depth, width, height],
	];
	return regions.map(([face, x, y, faceWidth, faceHeight]) => ({
		face,
		height: faceHeight,
		layer,
		part,
		width: faceWidth,
		x,
		y,
	}));
}

export function getSkinFaceRegions(
	model: MinecraftTextureModel,
	layer: SkinEditorLayer,
	skinSize = SKIN_SIZE,
): SkinFaceRegion[] {
	const scale = skinScale(skinSize);
	return skinBoxes(model, layer)
		.flatMap((box) => boxFaces(box, layer))
		.map((region) => ({
			...region,
			height: region.height * scale,
			width: region.width * scale,
			x: region.x * scale,
			y: region.y * scale,
		}));
}

export function getSkinRegions(
	model: MinecraftTextureModel,
	layer: SkinEditorLayer,
	skinSize = SKIN_SIZE,
): SkinRect[] {
	return getSkinFaceRegions(model, layer, skinSize).map(
		(region) => [region.x, region.y, region.width, region.height] as const,
	);
}

export function buildSkinMask(
	regions: readonly SkinRect[],
	skinSize = SKIN_SIZE,
): Uint8Array {
	skinScale(skinSize);
	const mask = new Uint8Array(skinSize * skinSize);
	for (const [x, y, width, height] of regions) {
		for (let offsetY = 0; offsetY < height; offsetY += 1) {
			for (let offsetX = 0; offsetX < width; offsetX += 1) {
				mask[(y + offsetY) * skinSize + x + offsetX] = 1;
			}
		}
	}
	return mask;
}

export function getFaceAt(
	regions: readonly SkinFaceRegion[],
	x: number,
	y: number,
): SkinFaceRegion | null {
	return (
		regions.find(
			(region) =>
				x >= region.x &&
				x < region.x + region.width &&
				y >= region.y &&
				y < region.y + region.height,
		) ?? null
	);
}

export function detectSkinModel(
	canvas: HTMLCanvasElement,
	sourceWasLegacy = false,
): MinecraftTextureModel {
	skinScale(canvas.width);
	if (canvas.width !== canvas.height) throw new Error("invalid_skin_canvas");
	return sourceWasLegacy ? "default" : inferModelType(canvas);
}

export function floodFillSkinPixels(
	pixels: Uint8ClampedArray,
	skinSize: number,
	mask: Uint8Array,
	startX: number,
	startY: number,
	replacement: readonly [number, number, number, number],
): boolean {
	skinScale(skinSize);
	if (
		pixels.byteLength !== skinSize * skinSize * 4 ||
		mask.byteLength !== skinSize * skinSize
	) {
		throw new Error("invalid_skin_buffer");
	}
	if (
		!Number.isSafeInteger(startX) ||
		!Number.isSafeInteger(startY) ||
		startX < 0 ||
		startX >= skinSize ||
		startY < 0 ||
		startY >= skinSize
	) {
		return false;
	}
	const startIndex = startY * skinSize + startX;
	if (!mask[startIndex]) return false;
	const offset = startIndex * 4;
	const target = [
		pixels[offset],
		pixels[offset + 1],
		pixels[offset + 2],
		pixels[offset + 3],
	] as const;
	if (target.every((channel, index) => channel === replacement[index])) {
		return false;
	}

	const queue = new Uint32Array(skinSize * skinSize);
	let head = 0;
	let tail = 0;
	const enqueue = (index: number) => {
		if (!mask[index]) return;
		const pixelOffset = index * 4;
		if (
			pixels[pixelOffset] !== target[0] ||
			pixels[pixelOffset + 1] !== target[1] ||
			pixels[pixelOffset + 2] !== target[2] ||
			pixels[pixelOffset + 3] !== target[3]
		) {
			return;
		}
		pixels[pixelOffset] = replacement[0];
		pixels[pixelOffset + 1] = replacement[1];
		pixels[pixelOffset + 2] = replacement[2];
		pixels[pixelOffset + 3] = replacement[3];
		queue[tail] = index;
		tail += 1;
	};
	enqueue(startIndex);
	while (head < tail) {
		const index = queue[head];
		head += 1;
		const x = index % skinSize;
		const y = Math.floor(index / skinSize);
		if (x > 0) enqueue(index - 1);
		if (x + 1 < skinSize) enqueue(index + 1);
		if (y > 0) enqueue(index - skinSize);
		if (y + 1 < skinSize) enqueue(index + skinSize);
	}
	return tail > 0;
}

export function swapPackedPixelColors(
	pixels: Uint8ClampedArray,
	colors: Uint32Array,
): Uint32Array {
	if (pixels.byteLength !== colors.length * 4) {
		throw new Error("invalid_skin_history");
	}
	const previous = new Uint32Array(colors.length);
	for (let index = 0; index < colors.length; index += 1) {
		const offset = index * 4;
		previous[index] =
			(pixels[offset] |
				(pixels[offset + 1] << 8) |
				(pixels[offset + 2] << 16) |
				(pixels[offset + 3] << 24)) >>>
			0;
		const color = colors[index];
		pixels[offset] = color & 0xff;
		pixels[offset + 1] = (color >>> 8) & 0xff;
		pixels[offset + 2] = (color >>> 16) & 0xff;
		pixels[offset + 3] = (color >>> 24) & 0xff;
	}
	return previous;
}

export function restoreSkinHistoryEntry(
	entry: SkinEditorHistoryEntry,
	current: {
		model: MinecraftTextureModel;
		savedStateId: number;
		size: number;
		stateId: number;
	},
	operations: SkinEditorHistoryRestoreOperations,
): SkinEditorHistoryRestoreResult {
	skinScale(current.size);
	let inverse: SkinEditorHistoryEntry;
	if (entry.kind === "snapshot") {
		skinScale(entry.image.width);
		if (entry.image.width !== entry.image.height) {
			throw new Error("invalid_skin_history");
		}
		const currentImage = operations.snapshot();
		if (
			currentImage.width !== current.size ||
			currentImage.height !== current.size
		) {
			throw new Error("invalid_skin_history");
		}
		inverse = {
			image: currentImage,
			kind: "snapshot",
			model: current.model,
			stateId: current.stateId,
		};
		operations.restoreSnapshot(entry.image);
	} else {
		if (entry.size !== current.size) {
			throw new Error("invalid_skin_history");
		}
		inverse = {
			colors: operations.swapPixels(entry.indices, entry.colors, entry.size),
			indices: entry.indices,
			kind: "pixels",
			model: current.model,
			size: entry.size,
			stateId: current.stateId,
		};
	}
	return {
		dirty: entry.stateId !== current.savedStateId,
		inverse,
		model: entry.model,
		stateId: entry.stateId,
	};
}

function clearRegions(
	context: CanvasRenderingContext2D,
	regions: readonly SkinRect[],
) {
	for (const [x, y, width, height] of regions) {
		context.clearRect(x, y, width, height);
	}
}

function hasTransparency(imageData: ImageData): boolean {
	for (let index = 3; index < imageData.data.length; index += 4) {
		if (imageData.data[index] !== 255) return true;
	}
	return false;
}

function skinScale(skinSize: number): number {
	const scale = skinSize / SKIN_SIZE;
	if (!Number.isSafeInteger(scale) || scale < 1) {
		throw new Error(`invalid_skin_size:${skinSize}`);
	}
	return scale;
}

function scaleRects(rects: readonly SkinRect[], skinSize: number): SkinRect[] {
	const scale = skinScale(skinSize);
	return rects.map(
		([x, y, width, height]) =>
			[x * scale, y * scale, width * scale, height * scale] as const,
	);
}

function convertLegacySkin(context: CanvasRenderingContext2D, scale: number) {
	// Adapted from skinview-utils' MIT-licensed 1.7 -> 1.8 conversion.
	// See THIRD_PARTY_NOTICES.md.
	// copied limb faces are mirrored and placed into the separate left limb UVs.
	context.save();
	context.scale(-1, 1);
	const copy = (
		sourceX: number,
		sourceY: number,
		width: number,
		height: number,
		destinationX: number,
		destinationY: number,
	) => {
		context.drawImage(
			context.canvas,
			sourceX * scale,
			sourceY * scale,
			width * scale,
			height * scale,
			-destinationX * scale,
			destinationY * scale,
			-width * scale,
			height * scale,
		);
	};
	copy(4, 16, 4, 4, 20, 48);
	copy(8, 16, 4, 4, 24, 48);
	copy(0, 20, 4, 12, 24, 52);
	copy(4, 20, 4, 12, 20, 52);
	copy(8, 20, 4, 12, 16, 52);
	copy(12, 20, 4, 12, 28, 52);
	copy(44, 16, 4, 4, 36, 48);
	copy(48, 16, 4, 4, 40, 48);
	copy(40, 20, 4, 12, 40, 52);
	copy(44, 20, 4, 12, 36, 52);
	copy(48, 20, 4, 12, 32, 52);
	copy(52, 20, 4, 12, 44, 52);
	context.restore();
}

export function analyzeSkinImageDimensions(
	width: number,
	height: number,
	maxPixels = Number.POSITIVE_INFINITY,
): SkinImageDimensions {
	const modern = width === height && width % SKIN_SIZE === 0;
	const legacy =
		width === height * 2 &&
		width % SKIN_SIZE === 0 &&
		height % (SKIN_SIZE / 2) === 0;
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width <= 0 ||
		height <= 0 ||
		(!modern && !legacy)
	) {
		throw new Error(`invalid_skin_dimensions:${width}x${height}`);
	}
	if (width * width > maxPixels) {
		throw new Error(`skin_pixel_limit_exceeded:${width}x${height}`);
	}
	return {
		legacy,
		scale: width / SKIN_SIZE,
		size: width,
	};
}

export function normalizeSkinImage(
	image: CanvasImageSource & { height: number; width: number },
	maxPixels = Number.POSITIVE_INFINITY,
): HTMLCanvasElement {
	const width = image.width;
	const height = image.height;
	const dimensions = analyzeSkinImageDimensions(width, height, maxPixels);

	const canvas = document.createElement("canvas");
	canvas.width = dimensions.size;
	canvas.height = dimensions.size;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("canvas_context_unavailable");
	context.imageSmoothingEnabled = false;
	context.clearRect(0, 0, dimensions.size, dimensions.size);
	context.drawImage(image, 0, 0, width, height);

	if (dimensions.legacy) {
		const source = context.getImageData(0, 0, width, height);
		convertLegacySkin(context, dimensions.scale);
		if (!hasTransparency(source)) {
			clearRegions(
				context,
				getSkinRegions("default", "overlay", dimensions.size),
			);
		}
	}
	return canvas;
}

function copyFace(
	source: Uint32Array,
	destination: Uint32Array,
	sourceRect: SkinRect,
	destinationRect: SkinRect,
	skinSize: number,
) {
	const [sourceX, sourceY, sourceWidth, sourceHeight] = sourceRect;
	const [destinationX, destinationY, destinationWidth, destinationHeight] =
		destinationRect;
	for (let y = 0; y < destinationHeight; y += 1) {
		const sampleY =
			sourceY +
			Math.min(
				sourceHeight - 1,
				Math.floor((y * sourceHeight) / destinationHeight),
			);
		for (let x = 0; x < destinationWidth; x += 1) {
			const sampleX =
				sourceX +
				Math.min(
					sourceWidth - 1,
					Math.floor((x * sourceWidth) / destinationWidth),
				);
			destination[(destinationY + y) * skinSize + destinationX + x] =
				source[sampleY * skinSize + sampleX];
		}
	}
}

export function repackSkinModelPixels(
	data: Uint8ClampedArray,
	fromModel: MinecraftTextureModel,
	toModel: MinecraftTextureModel,
	skinSize = SKIN_SIZE,
) {
	if (fromModel === toModel) return;
	skinScale(skinSize);
	if (data.byteLength !== skinSize * skinSize * 4) {
		throw new Error("invalid_skin_buffer");
	}
	const destination = new Uint32Array(
		data.buffer,
		data.byteOffset,
		data.byteLength / 4,
	);
	const source = new Uint32Array(destination);
	const clear = (rect: SkinRect) => {
		const [x, y, width, height] = rect;
		for (let offsetY = 0; offsetY < height; offsetY += 1) {
			for (let offsetX = 0; offsetX < width; offsetX += 1) {
				destination[(y + offsetY) * skinSize + x + offsetX] = 0;
			}
		}
	};
	for (const rect of [
		[40, 16, 16, 16],
		[40, 32, 16, 16],
		[32, 48, 16, 16],
		[48, 48, 16, 16],
	] as const satisfies readonly SkinRect[]) {
		clear(scaleRects([rect], skinSize)[0]);
	}

	for (const layer of ["base", "overlay"] as const) {
		const fromRegions = getSkinFaceRegions(fromModel, layer, skinSize).filter(
			(region) => region.part === "rightArm" || region.part === "leftArm",
		);
		const toRegions = getSkinFaceRegions(toModel, layer, skinSize).filter(
			(region) => region.part === "rightArm" || region.part === "leftArm",
		);
		for (let index = 0; index < fromRegions.length; index += 1) {
			const from = fromRegions[index];
			const to = toRegions[index];
			copyFace(
				source,
				destination,
				[from.x, from.y, from.width, from.height],
				[to.x, to.y, to.width, to.height],
				skinSize,
			);
		}
	}
}

export function repackSkinCanvasModel(
	canvas: HTMLCanvasElement,
	fromModel: MinecraftTextureModel,
	toModel: MinecraftTextureModel,
) {
	if (fromModel === toModel) return;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("canvas_context_unavailable");
	if (canvas.width !== canvas.height) throw new Error("invalid_skin_canvas");
	const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
	repackSkinModelPixels(imageData.data, fromModel, toModel, canvas.width);
	context.putImageData(imageData, 0, 0);
}

export function skinCanvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) resolve(blob);
			else reject(new Error("skin_png_encode_failed"));
		}, "image/png");
	});
}

export function imageDataEquals(left: ImageData, right: ImageData): boolean {
	if (left.data.length !== right.data.length) return false;
	for (let index = 0; index < left.data.length; index += 1) {
		if (left.data[index] !== right.data[index]) return false;
	}
	return true;
}
