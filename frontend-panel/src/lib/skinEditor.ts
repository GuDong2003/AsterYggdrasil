import type { MinecraftTextureModel } from "@/types/api";

export const SKIN_SIZE = 64;
export const EDITOR_CANVAS_SIZE = 1024;

export type SkinEditorLayer = "base" | "overlay";
export type SkinEditorTool = "brush" | "eraser" | "picker" | "bucket";
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

const SLIM_EXCLUDED_REGIONS: SkinRect[] = [
	[54, 16, 2, 4],
	[54, 20, 2, 12],
	[46, 48, 2, 4],
	[46, 52, 2, 12],
	[54, 32, 2, 4],
	[54, 36, 2, 12],
	[62, 48, 2, 4],
	[62, 52, 2, 12],
];

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
): SkinFaceRegion[] {
	return skinBoxes(model, layer).flatMap((box) => boxFaces(box, layer));
}

export function getSkinRegions(
	model: MinecraftTextureModel,
	layer: SkinEditorLayer,
): SkinRect[] {
	return getSkinFaceRegions(model, layer).map(
		(region) => [region.x, region.y, region.width, region.height] as const,
	);
}

export function buildSkinMask(regions: readonly SkinRect[]): Uint8Array {
	const mask = new Uint8Array(SKIN_SIZE * SKIN_SIZE);
	for (const [x, y, width, height] of regions) {
		for (let offsetY = 0; offsetY < height; offsetY += 1) {
			for (let offsetX = 0; offsetX < width; offsetX += 1) {
				mask[(y + offsetY) * SKIN_SIZE + x + offsetX] = 1;
			}
		}
	}
	return mask;
}

export function getSlimExcludedMask(): Uint8Array {
	return buildSkinMask(SLIM_EXCLUDED_REGIONS);
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

function convertLegacySkin(context: CanvasRenderingContext2D) {
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
			sourceX,
			sourceY,
			width,
			height,
			-destinationX,
			destinationY,
			-width,
			height,
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

export function normalizeSkinImage(
	image: CanvasImageSource & { height: number; width: number },
): HTMLCanvasElement {
	const width = image.width;
	const height = image.height;
	const modern = width === height && width % SKIN_SIZE === 0;
	const legacy =
		width === height * 2 &&
		width % SKIN_SIZE === 0 &&
		height % (SKIN_SIZE / 2) === 0;
	if (!modern && !legacy) {
		throw new Error(`invalid_skin_dimensions:${width}x${height}`);
	}

	const canvas = document.createElement("canvas");
	canvas.width = SKIN_SIZE;
	canvas.height = SKIN_SIZE;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("canvas_context_unavailable");
	context.imageSmoothingEnabled = false;
	context.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
	context.drawImage(
		image,
		0,
		0,
		width,
		height,
		0,
		0,
		SKIN_SIZE,
		legacy ? SKIN_SIZE / 2 : SKIN_SIZE,
	);

	const sourceHeight = legacy ? SKIN_SIZE / 2 : SKIN_SIZE;
	const source = context.getImageData(0, 0, SKIN_SIZE, sourceHeight);
	if (legacy) {
		convertLegacySkin(context);
		if (!hasTransparency(source)) {
			clearRegions(context, getSkinRegions("default", "overlay"));
		}
	} else if (!hasTransparency(source)) {
		clearRegions(context, getSkinRegions("default", "overlay"));
	}
	return canvas;
}

function copyFace(
	source: Uint32Array,
	destination: Uint32Array,
	sourceRect: SkinRect,
	destinationRect: SkinRect,
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
			destination[(destinationY + y) * SKIN_SIZE + destinationX + x] =
				source[sampleY * SKIN_SIZE + sampleX];
		}
	}
}

export function repackSkinModelPixels(
	data: Uint8ClampedArray,
	fromModel: MinecraftTextureModel,
	toModel: MinecraftTextureModel,
) {
	if (fromModel === toModel) return;
	if (data.byteLength !== SKIN_SIZE * SKIN_SIZE * 4) {
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
				destination[(y + offsetY) * SKIN_SIZE + x + offsetX] = 0;
			}
		}
	};
	for (const rect of [
		[40, 16, 16, 16],
		[40, 32, 16, 16],
		[32, 48, 16, 16],
		[48, 48, 16, 16],
	] as const satisfies readonly SkinRect[]) {
		clear(rect);
	}

	for (const layer of ["base", "overlay"] as const) {
		const fromRegions = getSkinFaceRegions(fromModel, layer).filter(
			(region) => region.part === "rightArm" || region.part === "leftArm",
		);
		const toRegions = getSkinFaceRegions(toModel, layer).filter(
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
			);
		}
	}
	if (toModel === "slim") {
		for (const rect of SLIM_EXCLUDED_REGIONS) clear(rect);
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
	const imageData = context.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE);
	repackSkinModelPixels(imageData.data, fromModel, toModel);
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
