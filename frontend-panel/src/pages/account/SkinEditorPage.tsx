import {
	type ChangeEvent,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useBlocker, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type MinecraftPose,
	MinecraftPreview,
} from "@/components/yggdrasil/MinecraftPreview";
import { usePageTitle } from "@/hooks/usePageTitle";
import {
	buildSkinMask,
	EDITOR_CANVAS_SIZE,
	getFaceAt,
	getSkinFaceRegions,
	getSkinRegions,
	imageDataEquals,
	normalizeSkinImage,
	repackSkinCanvasModel,
	SKIN_SIZE,
	type SkinEditorLayer,
	type SkinEditorTool,
	type SkinFaceRegion,
	skinCanvasToBlob,
} from "@/lib/skinEditor";
import { cn } from "@/lib/utils";
import { accountPaths, accountWardrobeEditorPath } from "@/routes/routePaths";
import { formatUnknownError } from "@/services/http";
import { yggdrasilService } from "@/services/yggdrasilService";
import type {
	MinecraftTextureModel,
	MinecraftWardrobeTextureMetadata,
} from "@/types/api";

type EditorSnapshot = {
	image: ImageData;
	model: MinecraftTextureModel;
};

type NavigatorRect = {
	height: number;
	left: number;
	top: number;
	width: number;
};

const HISTORY_LIMIT = 100;
const TOOL_ICONS: Record<SkinEditorTool, IconName> = {
	brush: "PaintBrush",
	eraser: "Eraser",
	picker: "Eyedropper",
	bucket: "PaintBucket",
};

const POSE_CONTROLS: Array<{
	key: keyof MinecraftPose;
	max: number;
	min: number;
}> = [
	{ key: "headPitch", min: -1, max: 1 },
	{ key: "headYaw", min: -1, max: 1 },
	{ key: "rightArmPitch", min: -1.5, max: 1.5 },
	{ key: "leftArmPitch", min: -1.5, max: 1.5 },
	{ key: "rightLegPitch", min: -1.2, max: 1.2 },
	{ key: "leftLegPitch", min: -1.2, max: 1.2 },
];

function loadImage(source: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.decoding = "async";
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("skin_image_decode_failed"));
		image.src = source;
	});
}

function colorToRgb(color: string): [number, number, number] {
	return [
		Number.parseInt(color.slice(1, 3), 16),
		Number.parseInt(color.slice(3, 5), 16),
		Number.parseInt(color.slice(5, 7), 16),
	];
}

function rgbToColor(red: number, green: number, blue: number) {
	return `#${[red, green, blue]
		.map((channel) => channel.toString(16).padStart(2, "0"))
		.join("")}`;
}

function safeFileName(value: string) {
	const normalized = value
		.trim()
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/\s+/g, " ");
	return normalized || "minecraft-skin";
}

export default function SkinEditorPage() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const params = useParams<{ textureId: string }>();
	const textureId = Number(params.textureId);
	const validTextureId = Number.isSafeInteger(textureId) && textureId > 0;
	const fullCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const editorCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const navigatorCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const baseThumbnailRef = useRef<HTMLCanvasElement | null>(null);
	const overlayThumbnailRef = useRef<HTMLCanvasElement | null>(null);
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const importInputRef = useRef<HTMLInputElement | null>(null);
	const historyRef = useRef<EditorSnapshot[]>([]);
	const redoRef = useRef<EditorSnapshot[]>([]);
	const originalRef = useRef<EditorSnapshot | null>(null);
	const drawingRef = useRef(false);
	const strokeChangedRef = useRef(false);
	const lastPixelRef = useRef<[number, number] | null>(null);
	const previewUrlRef = useRef<string | null>(null);
	const allowNavigationRef = useRef(false);

	const [texture, setTexture] =
		useState<MinecraftWardrobeTextureMetadata | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [savingMode, setSavingMode] = useState<"replace" | "copy" | null>(null);
	const [replaceDialogOpen, setReplaceDialogOpen] = useState(false);
	const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
	const [tool, setTool] = useState<SkinEditorTool>("brush");
	const [layer, setLayer] = useState<SkinEditorLayer>("base");
	const [model, setModel] = useState<MinecraftTextureModel>("default");
	const [brushColor, setBrushColor] = useState("#ef4444");
	const [brushSize, setBrushSize] = useState(1);
	const [gridVisible, setGridVisible] = useState(true);
	const [overlayVisible, setOverlayVisible] = useState(true);
	const [zoom, setZoom] = useState(1);
	const [revision, setRevision] = useState(0);
	const [historyRevision, setHistoryRevision] = useState(0);
	const [dirty, setDirty] = useState(false);
	const [hoveredPixel, setHoveredPixel] = useState<[number, number] | null>(
		null,
	);
	const [hoveredFace, setHoveredFace] = useState<SkinFaceRegion | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [pose, setPose] = useState<MinecraftPose>({});
	const [navigatorRect, setNavigatorRect] = useState<NavigatorRect>({
		height: 100,
		left: 0,
		top: 0,
		width: 100,
	});

	usePageTitle(
		texture
			? t("skinEditor.pageTitleWithName", { name: texture.name })
			: t("skinEditor.pageTitle"),
	);

	const baseMask = useMemo(
		() => buildSkinMask(getSkinRegions(model, "base")),
		[model],
	);
	const overlayMask = useMemo(
		() => buildSkinMask(getSkinRegions(model, "overlay")),
		[model],
	);
	const activeMask = layer === "base" ? baseMask : overlayMask;
	const faceRegions = useMemo(
		() => getSkinFaceRegions(model, layer),
		[model, layer],
	);

	const blocker = useBlocker(
		useCallback(() => dirty && !allowNavigationRef.current, [dirty]),
	);

	useEffect(() => {
		if (blocker.state === "blocked") {
			setLeaveDialogOpen(true);
		}
	}, [blocker.state]);

	useEffect(() => {
		if (!dirty) return;
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
		};
		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [dirty]);

	const getFullContext = useCallback(() => {
		const context = fullCanvasRef.current?.getContext("2d", {
			willReadFrequently: true,
		});
		if (!context) throw new Error("canvas_context_unavailable");
		return context;
	}, []);

	const currentSnapshot = useCallback(
		(nextModel = model): EditorSnapshot => ({
			image: getFullContext().getImageData(0, 0, SKIN_SIZE, SKIN_SIZE),
			model: nextModel,
		}),
		[getFullContext, model],
	);

	const updateDirtyState = useCallback(
		(nextModel = model) => {
			const original = originalRef.current;
			if (!original) {
				setDirty(false);
				return;
			}
			const current = getFullContext().getImageData(0, 0, SKIN_SIZE, SKIN_SIZE);
			setDirty(
				nextModel !== original.model ||
					!imageDataEquals(current, original.image),
			);
		},
		[getFullContext, model],
	);

	const updateNavigatorRect = useCallback(() => {
		const viewport = viewportRef.current;
		const canvas = editorCanvasRef.current;
		if (!viewport || !canvas) return;
		const canvasWidth = canvas.getBoundingClientRect().width;
		const canvasHeight = canvas.getBoundingClientRect().height;
		if (canvasWidth <= 0 || canvasHeight <= 0) return;
		setNavigatorRect({
			height: Math.min(100, (viewport.clientHeight / canvasHeight) * 100),
			left: (viewport.scrollLeft / canvasWidth) * 100,
			top: (viewport.scrollTop / canvasHeight) * 100,
			width: Math.min(100, (viewport.clientWidth / canvasWidth) * 100),
		});
	}, []);

	const drawThumbnail = useCallback(
		(canvas: HTMLCanvasElement | null, mask?: Uint8Array) => {
			if (!canvas || !fullCanvasRef.current) return;
			const context = canvas.getContext("2d");
			if (!context) return;
			context.imageSmoothingEnabled = false;
			context.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
			if (!mask) {
				context.drawImage(fullCanvasRef.current, 0, 0);
				return;
			}
			const source = getFullContext().getImageData(0, 0, SKIN_SIZE, SKIN_SIZE);
			const output = context.createImageData(SKIN_SIZE, SKIN_SIZE);
			for (let index = 0; index < mask.length; index += 1) {
				if (!mask[index]) continue;
				const offset = index * 4;
				output.data[offset] = source.data[offset];
				output.data[offset + 1] = source.data[offset + 1];
				output.data[offset + 2] = source.data[offset + 2];
				output.data[offset + 3] = source.data[offset + 3];
			}
			context.putImageData(output, 0, 0);
		},
		[getFullContext],
	);

	const renderEditor = useCallback(
		(brushPreview?: [number, number]) => {
			const canvas = editorCanvasRef.current;
			if (!canvas || !fullCanvasRef.current) return;
			const context = canvas.getContext("2d");
			if (!context) return;
			const full = getFullContext().getImageData(0, 0, SKIN_SIZE, SKIN_SIZE);
			const cell = EDITOR_CANVAS_SIZE / SKIN_SIZE;
			context.clearRect(0, 0, EDITOR_CANVAS_SIZE, EDITOR_CANVAS_SIZE);
			context.fillStyle = "#15191f";
			context.fillRect(0, 0, EDITOR_CANVAS_SIZE, EDITOR_CANVAS_SIZE);

			for (let y = 0; y < SKIN_SIZE; y += 1) {
				for (let x = 0; x < SKIN_SIZE; x += 1) {
					const index = y * SKIN_SIZE + x;
					const used = baseMask[index] || overlayMask[index];
					if (!used || (!overlayVisible && overlayMask[index])) continue;
					const offset = index * 4;
					const alpha = full.data[offset + 3];
					if (alpha === 0) {
						context.fillStyle = (x + y) % 2 === 0 ? "#343a43" : "#2a2f37";
					} else if (activeMask[index]) {
						context.fillStyle = `rgba(${full.data[offset]},${full.data[offset + 1]},${full.data[offset + 2]},${alpha / 255})`;
					} else {
						context.fillStyle = `rgba(${Math.round(full.data[offset] * 0.32)},${Math.round(full.data[offset + 1] * 0.32)},${Math.round(full.data[offset + 2] * 0.32)},${Math.max(0.24, (alpha / 255) * 0.5)})`;
					}
					context.fillRect(x * cell, y * cell, cell, cell);
				}
			}

			context.fillStyle = "rgba(16, 185, 129, 0.08)";
			for (let index = 0; index < activeMask.length; index += 1) {
				if (!activeMask[index]) continue;
				if (!overlayVisible && overlayMask[index]) continue;
				context.fillRect(
					(index % SKIN_SIZE) * cell,
					Math.floor(index / SKIN_SIZE) * cell,
					cell,
					cell,
				);
			}

			if (gridVisible) {
				context.strokeStyle = "rgba(255, 255, 255, 0.08)";
				context.lineWidth = 1;
				for (let index = 0; index <= SKIN_SIZE; index += 1) {
					const position = index * cell;
					context.beginPath();
					context.moveTo(position, 0);
					context.lineTo(position, EDITOR_CANVAS_SIZE);
					context.stroke();
					context.beginPath();
					context.moveTo(0, position);
					context.lineTo(EDITOR_CANVAS_SIZE, position);
					context.stroke();
				}
			}
			context.strokeStyle = "rgba(255, 255, 255, 0.2)";
			context.lineWidth = 2;
			for (let index = 0; index <= SKIN_SIZE; index += 8) {
				const position = index * cell;
				context.beginPath();
				context.moveTo(position, 0);
				context.lineTo(position, EDITOR_CANVAS_SIZE);
				context.stroke();
				context.beginPath();
				context.moveTo(0, position);
				context.lineTo(EDITOR_CANVAS_SIZE, position);
				context.stroke();
			}
			context.strokeStyle = "rgba(52, 211, 153, 0.52)";
			context.lineWidth = 2;
			for (const face of faceRegions) {
				context.strokeRect(
					face.x * cell + 1,
					face.y * cell + 1,
					face.width * cell - 2,
					face.height * cell - 2,
				);
			}
			const hoveredRegion = brushPreview
				? getFaceAt(faceRegions, brushPreview[0], brushPreview[1])
				: null;
			if (hoveredRegion) {
				const x = hoveredRegion.x * cell;
				const y = hoveredRegion.y * cell;
				const width = hoveredRegion.width * cell;
				const height = hoveredRegion.height * cell;
				context.strokeStyle = "rgba(5, 5, 5, 0.94)";
				context.lineWidth = 6;
				context.strokeRect(x + 2, y + 2, width - 4, height - 4);
				context.strokeStyle = "rgba(255, 255, 255, 0.96)";
				context.lineWidth = 3;
				context.strokeRect(x + 2, y + 2, width - 4, height - 4);
			}
			if (brushPreview && (tool === "brush" || tool === "eraser")) {
				const [pixelX, pixelY] = brushPreview;
				context.fillStyle = "rgba(250, 204, 21, 0.34)";
				for (
					let offsetY = -Math.floor(brushSize / 2);
					offsetY < Math.ceil(brushSize / 2);
					offsetY += 1
				) {
					for (
						let offsetX = -Math.floor(brushSize / 2);
						offsetX < Math.ceil(brushSize / 2);
						offsetX += 1
					) {
						const x = pixelX + offsetX;
						const y = pixelY + offsetY;
						if (
							x < 0 ||
							x >= SKIN_SIZE ||
							y < 0 ||
							y >= SKIN_SIZE ||
							!activeMask[y * SKIN_SIZE + x]
						) {
							continue;
						}
						context.fillRect(x * cell, y * cell, cell, cell);
					}
				}
			}
		},
		[
			activeMask,
			baseMask,
			brushSize,
			faceRegions,
			getFullContext,
			gridVisible,
			overlayMask,
			overlayVisible,
			tool,
		],
	);

	useEffect(() => {
		if (!validTextureId) {
			setLoadError(t("skinEditor.error.invalidTexture"));
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		void (async () => {
			setLoading(true);
			setLoadError(null);
			try {
				const metadata = await yggdrasilService.getWardrobeTexture(textureId);
				if (metadata.texture_type !== "skin") {
					throw new Error("skin_editor_cape_unsupported");
				}
				const response = await fetch(metadata.url, {
					cache: "no-store",
					credentials: "same-origin",
					signal: controller.signal,
				});
				if (!response.ok) {
					throw new Error(`skin_download_failed:${response.status}`);
				}
				const blob = await response.blob();
				const sourceUrl = URL.createObjectURL(blob);
				try {
					const image = await loadImage(sourceUrl);
					if (controller.signal.aborted) return;
					const normalized = normalizeSkinImage(image);
					if (
						metadata.texture_model === "slim" &&
						metadata.width === metadata.height * 2
					) {
						repackSkinCanvasModel(normalized, "default", "slim");
					}
					const context = getFullContext();
					context.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
					context.drawImage(normalized, 0, 0);
					const snapshot = {
						image: context.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE),
						model: metadata.texture_model,
					};
					originalRef.current = snapshot;
					allowNavigationRef.current = false;
					historyRef.current = [];
					redoRef.current = [];
					setTexture(metadata);
					setModel(metadata.texture_model);
					setDirty(false);
					setHistoryRevision((value) => value + 1);
					setRevision((value) => value + 1);
				} finally {
					URL.revokeObjectURL(sourceUrl);
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				const message =
					error instanceof Error &&
					error.message === "skin_editor_cape_unsupported"
						? t("skinEditor.error.skinOnly")
						: t("skinEditor.error.load", {
								error: formatUnknownError(error),
							});
				setLoadError(message);
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [getFullContext, t, textureId, validTextureId]);

	useEffect(() => {
		if (loading || loadError || !fullCanvasRef.current) return;
		const original = originalRef.current;
		if (!original) return;
		getFullContext().putImageData(original.image, 0, 0);
	}, [getFullContext, loadError, loading]);

	useEffect(() => {
		if (loading || loadError) return;
		if (editorCanvasRef.current) {
			editorCanvasRef.current.dataset.contentRevision = String(revision);
		}
		renderEditor(hoveredPixel ?? undefined);
		drawThumbnail(
			navigatorCanvasRef.current,
			overlayVisible ? undefined : baseMask,
		);
		drawThumbnail(baseThumbnailRef.current, baseMask);
		drawThumbnail(overlayThumbnailRef.current, overlayMask);
		updateNavigatorRect();
	}, [
		baseMask,
		drawThumbnail,
		hoveredPixel,
		loadError,
		loading,
		overlayMask,
		overlayVisible,
		renderEditor,
		revision,
		updateNavigatorRect,
	]);

	useEffect(() => {
		if (loading || loadError || !fullCanvasRef.current) return;
		let cancelled = false;
		const previewCanvas = document.createElement("canvas");
		previewCanvas.dataset.contentRevision = String(revision);
		previewCanvas.width = SKIN_SIZE;
		previewCanvas.height = SKIN_SIZE;
		const context = previewCanvas.getContext("2d");
		if (!context) return;
		if (overlayVisible) {
			context.drawImage(fullCanvasRef.current, 0, 0);
		} else {
			const source = getFullContext().getImageData(0, 0, SKIN_SIZE, SKIN_SIZE);
			const output = context.createImageData(SKIN_SIZE, SKIN_SIZE);
			for (let index = 0; index < baseMask.length; index += 1) {
				if (!baseMask[index]) continue;
				const offset = index * 4;
				output.data[offset] = source.data[offset];
				output.data[offset + 1] = source.data[offset + 1];
				output.data[offset + 2] = source.data[offset + 2];
				output.data[offset + 3] = source.data[offset + 3];
			}
			context.putImageData(output, 0, 0);
		}
		previewCanvas.toBlob((blob) => {
			if (!blob || cancelled) return;
			const nextUrl = URL.createObjectURL(blob);
			if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
			previewUrlRef.current = nextUrl;
			setPreviewUrl(nextUrl);
		}, "image/png");
		return () => {
			cancelled = true;
		};
	}, [baseMask, getFullContext, loadError, loading, overlayVisible, revision]);

	useEffect(
		() => () => {
			if (previewUrlRef.current) {
				URL.revokeObjectURL(previewUrlRef.current);
			}
		},
		[],
	);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.target instanceof HTMLInputElement ||
				event.target instanceof HTMLTextAreaElement
			) {
				return;
			}
			const modifier = event.metaKey || event.ctrlKey;
			if (modifier && event.key.toLowerCase() === "z") {
				event.preventDefault();
				if (event.shiftKey) redo();
				else undo();
				return;
			}
			if (modifier && event.key.toLowerCase() === "y") {
				event.preventDefault();
				redo();
				return;
			}
			if (event.key === "b") setTool("brush");
			if (event.key === "e") setTool("eraser");
			if (event.key === "i") setTool("picker");
			if (event.key === "g") setTool("bucket");
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	});

	function pushHistory() {
		historyRef.current.push(currentSnapshot());
		if (historyRef.current.length > HISTORY_LIMIT) {
			historyRef.current.shift();
		}
		redoRef.current = [];
		setHistoryRevision((value) => value + 1);
	}

	function commitMutation(nextModel = model) {
		updateDirtyState(nextModel);
		setRevision((value) => value + 1);
		setHistoryRevision((value) => value + 1);
	}

	function restoreSnapshot(snapshot: EditorSnapshot) {
		getFullContext().putImageData(snapshot.image, 0, 0);
		clearHoverState();
		setModel(snapshot.model);
		commitMutation(snapshot.model);
	}

	function undo() {
		const previous = historyRef.current.pop();
		if (!previous || loading || savingMode) return;
		redoRef.current.push(currentSnapshot());
		restoreSnapshot(previous);
	}

	function redo() {
		const next = redoRef.current.pop();
		if (!next || loading || savingMode) return;
		historyRef.current.push(currentSnapshot());
		restoreSnapshot(next);
	}

	function canvasPixel(event: { clientX: number; clientY: number }) {
		const rect = editorCanvasRef.current?.getBoundingClientRect();
		if (!rect) return null;
		if (
			event.clientX < rect.left ||
			event.clientX >= rect.right ||
			event.clientY < rect.top ||
			event.clientY >= rect.bottom
		) {
			return null;
		}
		return [
			Math.min(
				SKIN_SIZE - 1,
				Math.max(
					0,
					Math.floor(((event.clientX - rect.left) / rect.width) * SKIN_SIZE),
				),
			),
			Math.min(
				SKIN_SIZE - 1,
				Math.max(
					0,
					Math.floor(((event.clientY - rect.top) / rect.height) * SKIN_SIZE),
				),
			),
		] as [number, number];
	}

	function paintPixel(pixelX: number, pixelY: number) {
		const context = getFullContext();
		const [red, green, blue] = colorToRgb(brushColor);
		let changed = false;
		for (
			let offsetY = -Math.floor(brushSize / 2);
			offsetY < Math.ceil(brushSize / 2);
			offsetY += 1
		) {
			for (
				let offsetX = -Math.floor(brushSize / 2);
				offsetX < Math.ceil(brushSize / 2);
				offsetX += 1
			) {
				const x = pixelX + offsetX;
				const y = pixelY + offsetY;
				if (
					x < 0 ||
					x >= SKIN_SIZE ||
					y < 0 ||
					y >= SKIN_SIZE ||
					!activeMask[y * SKIN_SIZE + x]
				) {
					continue;
				}
				const current = context.getImageData(x, y, 1, 1).data;
				if (tool === "eraser") {
					if (current[3] === 0) continue;
					context.clearRect(x, y, 1, 1);
				} else {
					if (
						current[0] === red &&
						current[1] === green &&
						current[2] === blue &&
						current[3] === 255
					) {
						continue;
					}
					context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
					context.fillRect(x, y, 1, 1);
				}
				changed = true;
			}
		}
		strokeChangedRef.current ||= changed;
	}

	function paintLine(from: [number, number], to: [number, number]) {
		let [x0, y0] = from;
		const [x1, y1] = to;
		const deltaX = Math.abs(x1 - x0);
		const deltaY = Math.abs(y1 - y0);
		const stepX = x0 < x1 ? 1 : -1;
		const stepY = y0 < y1 ? 1 : -1;
		let error = deltaX - deltaY;
		while (true) {
			paintPixel(x0, y0);
			if (x0 === x1 && y0 === y1) break;
			const doubledError = error * 2;
			if (doubledError > -deltaY) {
				error -= deltaY;
				x0 += stepX;
			}
			if (doubledError < deltaX) {
				error += deltaX;
				y0 += stepY;
			}
		}
	}

	function floodFill(startX: number, startY: number) {
		const startIndex = startY * SKIN_SIZE + startX;
		if (!activeMask[startIndex]) return false;
		const context = getFullContext();
		const image = context.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE);
		const pixels = image.data;
		const offset = startIndex * 4;
		const target = [
			pixels[offset],
			pixels[offset + 1],
			pixels[offset + 2],
			pixels[offset + 3],
		];
		const [red, green, blue] = colorToRgb(brushColor);
		if (
			target[0] === red &&
			target[1] === green &&
			target[2] === blue &&
			target[3] === 255
		) {
			return false;
		}
		const visited = new Uint8Array(SKIN_SIZE * SKIN_SIZE);
		const queue: Array<[number, number]> = [[startX, startY]];
		while (queue.length > 0) {
			const [x, y] = queue.pop() ?? [0, 0];
			if (x < 0 || x >= SKIN_SIZE || y < 0 || y >= SKIN_SIZE) continue;
			const index = y * SKIN_SIZE + x;
			if (visited[index] || !activeMask[index]) continue;
			const pixelOffset = index * 4;
			if (
				pixels[pixelOffset] !== target[0] ||
				pixels[pixelOffset + 1] !== target[1] ||
				pixels[pixelOffset + 2] !== target[2] ||
				pixels[pixelOffset + 3] !== target[3]
			) {
				continue;
			}
			visited[index] = 1;
			pixels[pixelOffset] = red;
			pixels[pixelOffset + 1] = green;
			pixels[pixelOffset + 2] = blue;
			pixels[pixelOffset + 3] = 255;
			queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
		}
		context.putImageData(image, 0, 0);
		return true;
	}

	function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
		if (event.button !== 0 || loading || savingMode) return;
		const pixel = canvasPixel(event);
		if (!pixel) return;
		event.preventDefault();
		const [x, y] = pixel;
		if (!activeMask[y * SKIN_SIZE + x]) return;
		if (tool === "picker") {
			const data = getFullContext().getImageData(x, y, 1, 1).data;
			if (data[3] > 0) {
				setBrushColor(rgbToColor(data[0], data[1], data[2]));
				setTool("brush");
			}
			return;
		}
		pushHistory();
		if (tool === "bucket") {
			if (floodFill(x, y)) commitMutation();
			else {
				historyRef.current.pop();
				setHistoryRevision((value) => value + 1);
			}
			return;
		}
		drawingRef.current = true;
		strokeChangedRef.current = false;
		lastPixelRef.current = pixel;
		event.currentTarget.setPointerCapture(event.pointerId);
		paintPixel(x, y);
		renderEditor(pixel);
	}

	function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
		const pixel = canvasPixel(event);
		setHoveredPixel(pixel);
		setHoveredFace(pixel ? getFaceAt(faceRegions, pixel[0], pixel[1]) : null);
		if (!pixel) return;
		if (drawingRef.current && lastPixelRef.current) {
			event.preventDefault();
			paintLine(lastPixelRef.current, pixel);
			lastPixelRef.current = pixel;
		}
		renderEditor(pixel);
	}

	function finishStroke() {
		if (!drawingRef.current) return;
		drawingRef.current = false;
		lastPixelRef.current = null;
		if (strokeChangedRef.current) {
			commitMutation();
		} else {
			historyRef.current.pop();
			setHistoryRevision((value) => value + 1);
		}
		strokeChangedRef.current = false;
	}

	function clearHoverState() {
		setHoveredPixel(null);
		setHoveredFace(null);
	}

	function handlePointerLeave() {
		clearHoverState();
		if (!drawingRef.current) renderEditor();
	}

	function switchModel(nextModel: MinecraftTextureModel) {
		if (nextModel === model || loading || savingMode) return;
		pushHistory();
		repackSkinCanvasModel(
			fullCanvasRef.current as HTMLCanvasElement,
			model,
			nextModel,
		);
		clearHoverState();
		setModel(nextModel);
		commitMutation(nextModel);
	}

	async function importSkin(event: ChangeEvent<HTMLInputElement>) {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = "";
		if (!file) return;
		if (
			file.type !== "image/png" &&
			!file.name.toLowerCase().endsWith(".png")
		) {
			toast.error(t("skinEditor.error.pngOnly"));
			return;
		}
		const sourceUrl = URL.createObjectURL(file);
		try {
			const image = await loadImage(sourceUrl);
			const normalized = normalizeSkinImage(image);
			pushHistory();
			const context = getFullContext();
			context.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
			context.drawImage(normalized, 0, 0);
			commitMutation();
			toast.success(t("skinEditor.importSuccess"));
		} catch (error) {
			const dimensionError =
				error instanceof Error &&
				error.message.startsWith("invalid_skin_dimensions:");
			toast.error(
				dimensionError
					? t("skinEditor.error.dimensions")
					: t("skinEditor.error.import", {
							error: formatUnknownError(error),
						}),
			);
		} finally {
			URL.revokeObjectURL(sourceUrl);
		}
	}

	function clearSkin() {
		if (loading || savingMode) return;
		pushHistory();
		getFullContext().clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
		commitMutation();
	}

	function toggleOverlayVisibility() {
		const nextVisible = !overlayVisible;
		setOverlayVisible(nextVisible);
		if (!nextVisible && layer === "overlay") {
			clearHoverState();
			setLayer("base");
		}
	}

	async function downloadSkin() {
		if (!texture || !fullCanvasRef.current) return;
		try {
			const blob = await skinCanvasToBlob(fullCanvasRef.current);
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${safeFileName(texture.name)}.png`;
			anchor.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
		} catch (error) {
			toast.error(formatUnknownError(error));
		}
	}

	function markSaved(nextTexture: MinecraftWardrobeTextureMetadata) {
		const snapshot = currentSnapshot(model);
		originalRef.current = snapshot;
		historyRef.current = [];
		redoRef.current = [];
		setTexture(nextTexture);
		setDirty(false);
		setHistoryRevision((value) => value + 1);
	}

	async function replaceTexture() {
		if (!texture || !fullCanvasRef.current || !dirty) return;
		setSavingMode("replace");
		try {
			const blob = await skinCanvasToBlob(fullCanvasRef.current);
			const updated = await yggdrasilService.replaceWardrobeTextureContent({
				textureId: texture.id,
				file: new File([blob], `${safeFileName(texture.name)}.png`, {
					type: "image/png",
				}),
				model,
			});
			markSaved(updated);
			setReplaceDialogOpen(false);
			toast.success(t("skinEditor.replaceSuccess"));
		} catch (error) {
			toast.error(formatUnknownError(error));
		} finally {
			setSavingMode(null);
		}
	}

	async function saveAsCopy() {
		if (!texture || !fullCanvasRef.current || !dirty) return;
		setSavingMode("copy");
		try {
			const blob = await skinCanvasToBlob(fullCanvasRef.current);
			let copied = await yggdrasilService.uploadWardrobeTexture({
				textureType: "skin",
				file: new File([blob], `${safeFileName(texture.name)}.png`, {
					type: "image/png",
				}),
				model,
				name: t("skinEditor.copyName", { name: texture.name }),
				visibility: "private",
			});
			if (texture.tags.length > 0) {
				try {
					copied = await yggdrasilService.replaceWardrobeTextureTags(
						copied.id,
						{ tag_ids: texture.tags.map((tag) => tag.id) },
					);
				} catch {
					toast.warning(t("skinEditor.copyTagsWarning"));
				}
			}
			markSaved(copied);
			toast.success(t("skinEditor.copySuccess"));
			allowNavigationRef.current = true;
			navigate(accountWardrobeEditorPath(copied.id), { replace: true });
		} catch (error) {
			toast.error(formatUnknownError(error));
		} finally {
			setSavingMode(null);
		}
	}

	function changeZoom(nextZoom: number) {
		const viewport = viewportRef.current;
		const clamped = Math.min(4, Math.max(1, nextZoom));
		if (!viewport) {
			setZoom(clamped);
			return;
		}
		const centerX = viewport.scrollLeft + viewport.clientWidth / 2;
		const centerY = viewport.scrollTop + viewport.clientHeight / 2;
		const ratio = clamped / zoom;
		setZoom(clamped);
		requestAnimationFrame(() => {
			viewport.scrollLeft = Math.max(
				0,
				centerX * ratio - viewport.clientWidth / 2,
			);
			viewport.scrollTop = Math.max(
				0,
				centerY * ratio - viewport.clientHeight / 2,
			);
			updateNavigatorRect();
		});
	}

	function navigateFromMiniMap(event: ReactPointerEvent<HTMLDivElement>) {
		const viewport = viewportRef.current;
		const canvas = editorCanvasRef.current;
		const rect = event.currentTarget.getBoundingClientRect();
		if (!viewport || !canvas || rect.width <= 0 || rect.height <= 0) return;
		const canvasRect = canvas.getBoundingClientRect();
		const ratioX = (event.clientX - rect.left) / rect.width;
		const ratioY = (event.clientY - rect.top) / rect.height;
		viewport.scrollLeft = Math.max(
			0,
			ratioX * canvasRect.width - viewport.clientWidth / 2,
		);
		viewport.scrollTop = Math.max(
			0,
			ratioY * canvasRect.height - viewport.clientHeight / 2,
		);
		updateNavigatorRect();
	}

	function countTransparentBasePixels() {
		if (loading || loadError || !fullCanvasRef.current) return 0;
		const data = getFullContext().getImageData(0, 0, SKIN_SIZE, SKIN_SIZE).data;
		let count = 0;
		for (let index = 0; index < baseMask.length; index += 1) {
			if (baseMask[index] && data[index * 4 + 3] === 0) count += 1;
		}
		return count;
	}

	const transparentBasePixels = countTransparentBasePixels();

	if (loading) {
		return <SkinEditorLoading canvasRef={fullCanvasRef} />;
	}

	if (loadError || !texture) {
		return (
			<div className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-8 sm:px-6">
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6">
					<div className="flex items-start gap-3">
						<Icon name="Warning" className="mt-0.5 size-5 text-destructive" />
						<div>
							<h1 className="font-semibold">{t("skinEditor.error.title")}</h1>
							<p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
						</div>
					</div>
					<Button
						type="button"
						variant="outline"
						className="mt-5"
						onClick={() => navigate(accountPaths.wardrobe)}
					>
						<Icon name="ArrowLeft" className="size-4" />
						{t("skinEditor.backToWardrobe")}
					</Button>
				</div>
				<canvas
					ref={fullCanvasRef}
					width={SKIN_SIZE}
					height={SKIN_SIZE}
					hidden
				/>
			</div>
		);
	}

	const hoveredFaceLabel = hoveredFace
		? t("skinEditor.faceLabel", {
				face: t(`skinEditor.face.${hoveredFace.face}`),
				layer: t(`skinEditor.layer.${hoveredFace.layer}`),
				part: t(`skinEditor.part.${hoveredFace.part}`),
			})
		: t("skinEditor.hoverHint");
	const saveBusy = savingMode !== null;

	return (
		<div className="mx-auto grid min-h-[calc(100dvh-4rem)] w-full min-w-0 max-w-[110rem] grid-cols-[minmax(0,1fr)] gap-3 px-3 py-3 min-[860px]:h-[calc(100dvh-4rem)] min-[860px]:min-h-0 min-[860px]:grid-rows-[auto_minmax(0,1fr)] min-[860px]:overflow-hidden">
			<header className="min-w-0 rounded-lg border border-border/70 bg-card shadow-xs">
				<div className="flex flex-col gap-3 p-3 lg:flex-row lg:items-center lg:justify-between">
					<div className="flex min-w-0 items-center gap-3">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label={t("skinEditor.backToWardrobe")}
							onClick={() => navigate(accountPaths.wardrobe)}
						>
							<Icon name="ArrowLeft" className="size-4" />
						</Button>
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2">
								<h1 className="truncate text-lg font-semibold">
									{t("skinEditor.title")}
								</h1>
								<span className="rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
									64 × 64
								</span>
								{dirty ? (
									<span className="rounded-md bg-amber-500/12 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
										{t("skinEditor.unsaved")}
									</span>
								) : (
									<span className="rounded-md bg-emerald-500/12 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
										{t("skinEditor.saved")}
									</span>
								)}
							</div>
							<p className="truncate text-xs text-muted-foreground">
								{texture.name} · {model === "slim" ? "Alex" : "Steve"}
							</p>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<input
							ref={importInputRef}
							type="file"
							accept="image/png,.png"
							hidden
							onChange={importSkin}
						/>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={saveBusy}
							onClick={() => importInputRef.current?.click()}
						>
							<Icon name="Upload" className="size-4" />
							{t("skinEditor.import")}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={saveBusy}
							onClick={() => void downloadSkin()}
						>
							<Icon name="Download" className="size-4" />
							{t("skinEditor.download")}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={!dirty || saveBusy}
							onClick={() => void saveAsCopy()}
						>
							<Icon
								name={savingMode === "copy" ? "Spinner" : "Copy"}
								className={cn(
									"size-4",
									savingMode === "copy" && "animate-spin",
								)}
							/>
							{t("skinEditor.saveCopy")}
						</Button>
						<Button
							type="button"
							size="sm"
							disabled={!dirty || saveBusy}
							onClick={() => setReplaceDialogOpen(true)}
						>
							<Icon
								name={savingMode === "replace" ? "Spinner" : "FloppyDisk"}
								className={cn(
									"size-4",
									savingMode === "replace" && "animate-spin",
								)}
							/>
							{t("skinEditor.replaceOriginal")}
						</Button>
					</div>
				</div>
			</header>

			<div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] gap-3 min-[860px]:h-full min-[860px]:grid-cols-[11rem_minmax(0,1fr)_16rem] min-[860px]:items-stretch xl:grid-cols-[13rem_minmax(0,1fr)_18rem]">
				<aside className="flex min-h-0 min-w-0 flex-col overflow-y-auto rounded-lg border border-border/70 bg-card shadow-xs min-[860px]:h-full min-[860px]:max-h-full">
					<section className="grid shrink-0 gap-2 p-3 pb-2">
						<div className="flex items-center justify-between">
							<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{t("skinEditor.navigator")}
							</h2>
							<span
								className="font-mono text-xs font-semibold text-foreground"
								role="status"
								aria-label={t("skinEditor.coordinates")}
							>
								{hoveredPixel
									? `(${hoveredPixel[0]}, ${hoveredPixel[1]})`
									: "—"}
							</span>
						</div>
						<div
							className="relative aspect-square touch-none overflow-hidden rounded-md border border-border/70 bg-[#15191f] p-1"
							onPointerDown={navigateFromMiniMap}
							onPointerMove={(event) => {
								if (event.buttons === 1) navigateFromMiniMap(event);
							}}
						>
							<canvas
								ref={navigatorCanvasRef}
								width={SKIN_SIZE}
								height={SKIN_SIZE}
								className="size-full [image-rendering:pixelated]"
							/>
							<div
								className="pointer-events-none absolute border border-emerald-400 bg-emerald-400/10 shadow-[0_0_0_1px_rgba(0,0,0,0.7)]"
								style={{
									height: `${navigatorRect.height}%`,
									left: `${navigatorRect.left}%`,
									top: `${navigatorRect.top}%`,
									width: `${navigatorRect.width}%`,
								}}
							/>
						</div>
						<div className="grid grid-cols-[2rem_1fr_2rem] items-center gap-1">
							<Button
								type="button"
								size="icon"
								variant="outline"
								aria-label={t("skinEditor.zoomOut")}
								disabled={zoom <= 1}
								onClick={() => changeZoom(zoom - 0.25)}
							>
								<Icon name="Minus" className="size-3.5" />
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								disabled={zoom === 1}
								onClick={() => changeZoom(1)}
							>
								{Math.round(zoom * 100)}%
							</Button>
							<Button
								type="button"
								size="icon"
								variant="outline"
								aria-label={t("skinEditor.zoomIn")}
								disabled={zoom >= 4}
								onClick={() => changeZoom(zoom + 0.25)}
							>
								<Icon name="Plus" className="size-3.5" />
							</Button>
						</div>
						<div
							className="flex h-9 items-center justify-center border-t border-border/70 pt-2 text-center"
							aria-live="polite"
						>
							<span
								className={cn(
									"rounded px-2 py-1 text-[0.6875rem] font-semibold",
									hoveredFace
										? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
										: "text-muted-foreground",
								)}
							>
								{hoveredFaceLabel}
							</span>
						</div>
					</section>

					<section className="flex min-h-[13rem] flex-1 flex-col border-t border-border/70 p-3 pt-2">
						<div className="flex items-center justify-between">
							<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{t("skinEditor.layers")}
							</h2>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								aria-label={t("skinEditor.newBlank")}
								title={t("skinEditor.newBlank")}
								disabled={saveBusy}
								onClick={clearSkin}
							>
								<Icon name="FilePlus" className="size-4" />
							</Button>
						</div>
						<div className="mt-2 grid min-h-0 flex-1 grid-rows-2 gap-2">
							<LayerButton
								active={layer === "overlay"}
								canvasRef={overlayThumbnailRef}
								description={t("skinEditor.layer.overlayDescription")}
								hidden={!overlayVisible}
								label={t("skinEditor.layer.overlay")}
								onClick={() => {
									setOverlayVisible(true);
									clearHoverState();
									setLayer("overlay");
								}}
								onVisibilityChange={toggleOverlayVisibility}
								visibilityLabel={
									overlayVisible
										? t("skinEditor.hideOverlay")
										: t("skinEditor.showOverlay")
								}
								visible={overlayVisible}
							/>
							<LayerButton
								active={layer === "base"}
								canvasRef={baseThumbnailRef}
								description={t("skinEditor.layer.baseDescription")}
								label={t("skinEditor.layer.base")}
								onClick={() => {
									clearHoverState();
									setLayer("base");
								}}
							/>
						</div>
					</section>
				</aside>

				<main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card shadow-xs min-[860px]:h-full min-[860px]:max-h-full">
					<div className="flex flex-col gap-3 border-b border-border/70 bg-muted/30 p-3 lg:flex-row lg:items-center lg:justify-between">
						<div className="flex flex-wrap items-center gap-1">
							<label className="mr-1 flex h-9 items-center gap-2 rounded-md border border-border/70 bg-background px-2 text-xs font-medium">
								<span
									className="size-5 rounded border border-border"
									style={{ backgroundColor: brushColor }}
								/>
								<input
									type="color"
									value={brushColor}
									aria-label={t("skinEditor.color")}
									className="h-6 w-8 cursor-pointer border-0 bg-transparent p-0"
									onChange={(event) => setBrushColor(event.currentTarget.value)}
								/>
							</label>
							{(
								["brush", "eraser", "picker", "bucket"] as SkinEditorTool[]
							).map((candidate) => (
								<Button
									key={candidate}
									type="button"
									size="sm"
									variant={tool === candidate ? "default" : "ghost"}
									title={`${t(`skinEditor.tool.${candidate}`)} (${toolShortcut(candidate)})`}
									onClick={() => setTool(candidate)}
								>
									<Icon name={TOOL_ICONS[candidate]} className="size-4" />
									<span className="hidden 2xl:inline">
										{t(`skinEditor.tool.${candidate}`)}
									</span>
								</Button>
							))}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<label className="flex items-center gap-2 text-xs text-muted-foreground">
								{t("skinEditor.brushSize")}
								<input
									type="range"
									min="1"
									max="8"
									value={brushSize}
									disabled={tool === "picker" || tool === "bucket"}
									className="w-24 accent-emerald-500"
									onChange={(event) =>
										setBrushSize(Number(event.currentTarget.value))
									}
								/>
								<output className="w-4 text-right font-mono">
									{brushSize}
								</output>
							</label>
							<Button
								type="button"
								size="sm"
								variant={gridVisible ? "secondary" : "ghost"}
								onClick={() => setGridVisible((value) => !value)}
							>
								<Icon name="Grid" className="size-4" />
								{t("skinEditor.grid")}
							</Button>
							<div className="h-5 w-px bg-border" />
							<Button
								type="button"
								size="icon"
								variant="ghost"
								title={`${t("skinEditor.undo")} (⌘/Ctrl+Z)`}
								disabled={historyRef.current.length === 0 || saveBusy}
								onClick={undo}
								data-history-revision={historyRevision}
							>
								<Icon name="ArrowCounterClockwise" className="size-4" />
							</Button>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								title={`${t("skinEditor.redo")} (⌘/Ctrl+Shift+Z)`}
								disabled={redoRef.current.length === 0 || saveBusy}
								onClick={redo}
								data-history-revision={historyRevision}
							>
								<Icon name="ArrowClockwise" className="size-4" />
							</Button>
						</div>
					</div>
					<div
						ref={viewportRef}
						className="h-[min(68dvh,52rem)] min-h-[28rem] flex-none overflow-auto bg-[#0e1116] p-3 [scrollbar-color:var(--border)_#15191f] [scrollbar-width:thin] [&::-webkit-scrollbar]:size-2 [&::-webkit-scrollbar-corner]:bg-[#15191f] [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-solid [&::-webkit-scrollbar-thumb]:border-[#15191f] [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground [&::-webkit-scrollbar-track]:rounded [&::-webkit-scrollbar-track]:bg-[#15191f] min-[860px]:h-auto min-[860px]:min-h-0 min-[860px]:flex-1"
						onScroll={updateNavigatorRect}
					>
						<div
							className="mx-auto aspect-square origin-top-left"
							style={{
								width: `${zoom * 100}%`,
							}}
						>
							<canvas
								ref={editorCanvasRef}
								width={EDITOR_CANVAS_SIZE}
								height={EDITOR_CANVAS_SIZE}
								className={cn(
									"block size-full touch-none rounded-sm shadow-2xl [image-rendering:pixelated]",
									tool === "picker" && "cursor-crosshair",
									tool === "bucket" && "cursor-cell",
								)}
								onPointerDown={handlePointerDown}
								onPointerMove={handlePointerMove}
								onPointerUp={finishStroke}
								onPointerCancel={finishStroke}
								onPointerLeave={handlePointerLeave}
								onWheel={(event) => {
									if (!event.ctrlKey && !event.metaKey) return;
									event.preventDefault();
									changeZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
								}}
							/>
						</div>
					</div>
				</main>

				<aside className="flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden min-[860px]:h-full min-[860px]:max-h-full">
					<MinecraftPreview
						className="flex min-h-0 flex-1 flex-col"
						highlight={hoveredFace}
						label={t("skinEditor.preview")}
						playerName={texture.name}
						skinUrl={previewUrl}
						model={model}
						pose={pose}
						showMotionControls={false}
						showAutoRotateControl
						pauseAutoRotateLabel={t("skinEditor.pauseAutoRotate")}
						resumeAutoRotateLabel={t("skinEditor.resumeAutoRotate")}
						frameClassName="h-auto min-h-32 flex-1"
						failedTitle={t("skinEditor.previewFailed")}
						failedDescription={t("skinEditor.previewFailedDescription")}
					/>
					<section className="grid shrink-0 gap-2 rounded-lg border border-border/70 bg-card p-2.5 shadow-xs">
						<h2 className="text-sm font-semibold">
							{t("skinEditor.model.title")}
						</h2>
						<div className="grid grid-cols-2 gap-1 rounded-lg border border-border/70 bg-muted/30 p-1">
							{(["default", "slim"] as const).map((candidate) => (
								<Button
									key={candidate}
									type="button"
									size="sm"
									variant={model === candidate ? "default" : "ghost"}
									disabled={saveBusy}
									onClick={() => switchModel(candidate)}
								>
									{candidate === "slim"
										? t("skinEditor.model.slim")
										: t("skinEditor.model.default")}
								</Button>
							))}
						</div>
						{transparentBasePixels > 0 ? (
							<div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/8 p-2.5 text-xs leading-5 text-amber-800 dark:text-amber-200">
								<Icon name="Warning" className="mt-0.5 size-4 shrink-0" />
								{t("skinEditor.transparentBaseWarning", {
									count: transparentBasePixels,
								})}
							</div>
						) : null}
					</section>

					<section className="grid shrink-0 gap-2 rounded-lg border border-border/70 bg-card p-2.5 shadow-xs">
						<div className="flex items-center justify-between">
							<h2 className="text-sm font-semibold">
								{t("skinEditor.pose.title")}
							</h2>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => setPose({})}
							>
								{t("skinEditor.pose.reset")}
							</Button>
						</div>
						<div className="grid gap-1.5">
							{POSE_CONTROLS.map((control) => (
								<label
									key={control.key}
									className="grid grid-cols-[5.5rem_1fr] items-center gap-1.5 text-xs text-muted-foreground"
								>
									<span>{t(`skinEditor.pose.${control.key}`)}</span>
									<input
										type="range"
										min={control.min}
										max={control.max}
										step="0.01"
										value={pose[control.key] ?? 0}
										className="w-full accent-emerald-500"
										onChange={(event) => {
											const nextValue = event.currentTarget.valueAsNumber;
											setPose((current) => ({
												...current,
												[control.key]: nextValue,
											}));
										}}
									/>
								</label>
							))}
						</div>
					</section>

					{texture.library_status !== "private" ? (
						<div className="flex shrink-0 gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 p-2.5 text-xs leading-5 text-amber-800 dark:text-amber-200">
							<Icon name="Warning" className="mt-0.5 size-4 shrink-0" />
							{t("skinEditor.libraryResetNotice")}
						</div>
					) : null}
				</aside>
			</div>

			<canvas ref={fullCanvasRef} width={SKIN_SIZE} height={SKIN_SIZE} hidden />

			<ConfirmDialog
				open={replaceDialogOpen}
				onOpenChange={setReplaceDialogOpen}
				title={t("skinEditor.replaceConfirm.title")}
				description={t("skinEditor.replaceConfirm.description", {
					name: texture.name,
				})}
				cancelLabel={t("common.cancel")}
				confirmLabel={t("skinEditor.replaceOriginal")}
				loading={savingMode === "replace"}
				onConfirm={() => void replaceTexture()}
			/>
			<ConfirmDialog
				open={leaveDialogOpen}
				onOpenChange={(open) => {
					setLeaveDialogOpen(open);
					if (!open && blocker.state === "blocked") blocker.reset();
				}}
				title={t("skinEditor.leaveConfirm.title")}
				description={t("skinEditor.leaveConfirm.description")}
				cancelLabel={t("skinEditor.leaveConfirm.stay")}
				confirmLabel={t("skinEditor.leaveConfirm.leave")}
				variant="destructive"
				onConfirm={() => {
					allowNavigationRef.current = true;
					setLeaveDialogOpen(false);
					if (blocker.state === "blocked") blocker.proceed();
				}}
			/>
		</div>
	);
}

function LayerButton({
	active,
	canvasRef,
	description,
	hidden = false,
	label,
	onClick,
	onVisibilityChange,
	visibilityLabel,
	visible = true,
}: {
	active: boolean;
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
	description: string;
	hidden?: boolean;
	label: string;
	onClick: () => void;
	onVisibilityChange?: () => void;
	visibilityLabel?: string;
	visible?: boolean;
}) {
	return (
		<div
			className={cn(
				"group relative min-h-0 overflow-hidden rounded-md border transition-colors",
				active
					? "border-emerald-500/55 bg-emerald-500/8"
					: "border-border/70 hover:bg-muted/50",
				hidden && "opacity-55",
			)}
		>
			<button
				type="button"
				className="flex size-full min-h-0 flex-col items-center justify-center gap-1.5 p-2 text-center"
				onClick={onClick}
			>
				<canvas
					ref={canvasRef}
					width={SKIN_SIZE}
					height={SKIN_SIZE}
					className="aspect-square h-[clamp(2.75rem,8dvh,6rem)] max-h-[55%] rounded border border-border/70 bg-[repeating-conic-gradient(#d1d5db_0_25%,#f3f4f6_0_50%)_50%/8px_8px] [image-rendering:pixelated] dark:bg-[repeating-conic-gradient(#374151_0_25%,#1f2937_0_50%)_50%/8px_8px]"
				/>
				<span className="min-w-0 max-w-full">
					<span className="block text-xs font-semibold">{label}</span>
					<span className="mt-0.5 block truncate text-[0.625rem] leading-4 text-muted-foreground">
						{description}
					</span>
				</span>
			</button>
			{onVisibilityChange && visibilityLabel ? (
				<Button
					type="button"
					size="icon"
					variant="secondary"
					className="absolute top-1.5 right-1.5 size-7 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[hidden=true]:opacity-100"
					aria-label={visibilityLabel}
					title={visibilityLabel}
					data-hidden={!visible}
					onClick={onVisibilityChange}
				>
					<Icon name={visible ? "Eye" : "EyeSlash"} className="size-3.5" />
				</Button>
			) : null}
		</div>
	);
}

function SkinEditorLoading({
	canvasRef,
}: {
	canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
	return (
		<div className="mx-auto grid min-h-[calc(100dvh-4rem)] w-full min-w-0 max-w-[110rem] grid-cols-[minmax(0,1fr)] gap-3 px-3 py-3 min-[860px]:h-[calc(100dvh-4rem)] min-[860px]:min-h-0 min-[860px]:grid-rows-[auto_minmax(0,1fr)] min-[860px]:overflow-hidden">
			<Skeleton className="h-20 rounded-lg" />
			<div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] gap-3 min-[860px]:h-full min-[860px]:grid-cols-[11rem_minmax(0,1fr)_16rem] min-[860px]:items-stretch xl:grid-cols-[13rem_minmax(0,1fr)_18rem]">
				<Skeleton className="rounded-lg" />
				<Skeleton className="rounded-lg" />
				<div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_9rem] gap-2">
					<Skeleton className="rounded-lg" />
					<Skeleton className="h-36 rounded-lg" />
				</div>
			</div>
			<canvas ref={canvasRef} width={SKIN_SIZE} height={SKIN_SIZE} hidden />
		</div>
	);
}

function toolShortcut(tool: SkinEditorTool) {
	if (tool === "brush") return "B";
	if (tool === "eraser") return "E";
	if (tool === "picker") return "I";
	return "G";
}
