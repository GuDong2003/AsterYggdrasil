import { useCallback, useEffect, useRef, useState } from "react";
import {
	IdleAnimation,
	type SkinLoadOptions,
	SkinViewer,
	WalkingAnimation,
} from "skinview3d";
import {
	BoxGeometry,
	Group,
	Mesh,
	MeshBasicMaterial,
	type Object3D,
} from "three";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { MinecraftTextureModel } from "@/types/api";

export type PreviewMotion = "idle" | "walk";

export type MinecraftPose = {
	headPitch?: number;
	headYaw?: number;
	leftArmPitch?: number;
	leftLegPitch?: number;
	rightArmPitch?: number;
	rightLegPitch?: number;
};

export type MinecraftPreviewFaceHighlight = {
	face: "top" | "bottom" | "right" | "front" | "left" | "back";
	layer: "base" | "overlay";
	part: "head" | "body" | "rightArm" | "leftArm" | "rightLeg" | "leftLeg";
};

type FaceHighlightResources = {
	geometries: BoxGeometry[];
	group: Group;
	materials: MeshBasicMaterial[];
	parent: Object3D;
};

export type MinecraftPreviewProps = {
	capeUrl?: string | null;
	className?: string;
	compactHeader?: boolean;
	emptyDescription?: string;
	emptyTitle?: string;
	failedDescription?: string;
	failedTitle?: string;
	frameClassName?: string;
	idleLabel?: string;
	initialMotion?: PreviewMotion;
	highlight?: MinecraftPreviewFaceHighlight | null;
	label: string;
	model?: MinecraftTextureModel;
	noSkinLabel?: string;
	pauseAutoRotateLabel?: string;
	playerName?: string | null;
	pose?: MinecraftPose;
	resumeAutoRotateLabel?: string;
	showAutoRotateControl?: boolean;
	showMotionControls?: boolean;
	skinUrl?: string | null;
	walkLabel?: string;
};

export function MinecraftPreview({
	capeUrl,
	className,
	compactHeader = false,
	emptyDescription = "PNG skins render here with rotation and idle animation.",
	emptyTitle = "Upload a skin to preview",
	failedDescription = "The texture URL could not be loaded by the 3D viewer.",
	failedTitle = "Preview failed",
	frameClassName,
	idleLabel = "Idle",
	initialMotion = "idle",
	highlight = null,
	label,
	model = "default",
	noSkinLabel = "No skin texture",
	pauseAutoRotateLabel = "Pause auto rotation",
	playerName,
	pose,
	resumeAutoRotateLabel = "Resume auto rotation",
	showAutoRotateControl = false,
	showMotionControls = true,
	skinUrl,
	walkLabel = "Walk",
}: MinecraftPreviewProps) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const frameRef = useRef<HTMLDivElement | null>(null);
	const viewerRef = useRef<SkinViewer | null>(null);
	const highlightRef = useRef<MinecraftPreviewFaceHighlight | null>(highlight);
	const highlightResourcesRef = useRef<FaceHighlightResources | null>(null);
	const skinKey = skinUrl ? `${model}:${skinUrl}` : null;
	const [failedSkinKey, setFailedSkinKey] = useState<string | null>(null);
	const [motion, setMotion] = useState<PreviewMotion>(initialMotion);
	const [autoRotatePaused, setAutoRotatePaused] = useState(false);
	const failed = skinKey !== null && failedSkinKey === skinKey;
	const hasTexture = Boolean(skinUrl || capeUrl);

	const clearFaceHighlight = useCallback((viewer = viewerRef.current) => {
		const resources = highlightResourcesRef.current;
		if (!resources) return;
		resources.parent.remove(resources.group);
		for (const geometry of resources.geometries) geometry.dispose();
		for (const material of resources.materials) material.dispose();
		highlightResourcesRef.current = null;
		viewer?.render();
	}, []);

	const applyFaceHighlight = useCallback(
		(viewer = viewerRef.current) => {
			if (!viewer) return;
			clearFaceHighlight(viewer);
			const target = highlightRef.current;
			if (!target) return;

			const part = viewer.playerObject.skin[target.part];
			const layer =
				target.layer === "overlay" ? part.outerLayer : part.innerLayer;
			if (
				!(layer instanceof Mesh) ||
				!(layer.geometry instanceof BoxGeometry)
			) {
				return;
			}

			const { width, height, depth } = layer.geometry.parameters;
			const scale = layer.scale;
			const group = new Group();
			group.name = "skin-editor-face-highlight";
			group.renderOrder = 20;
			const geometries: BoxGeometry[] = [];
			const outerMaterial = new MeshBasicMaterial({
				color: 0x050505,
				depthWrite: false,
				opacity: 0.95,
				transparent: true,
			});
			const innerMaterial = new MeshBasicMaterial({
				color: 0xffffff,
				depthWrite: false,
				opacity: 1,
				transparent: true,
			});
			const materials = [outerMaterial, innerMaterial];

			const addBox = (
				material: MeshBasicMaterial,
				renderOrder: number,
				sizeX: number,
				sizeY: number,
				sizeZ: number,
				x: number,
				y: number,
				z: number,
			) => {
				const geometry = new BoxGeometry(
					Math.max(sizeX, 0.001),
					Math.max(sizeY, 0.001),
					Math.max(sizeZ, 0.001),
				);
				const mesh = new Mesh(geometry, material);
				mesh.position.set(x, y, z);
				mesh.renderOrder = renderOrder;
				group.add(mesh);
				geometries.push(geometry);
			};

			const drawEdges = (
				material: MeshBasicMaterial,
				thicknessWorld: number,
				renderOrder: number,
			) => {
				const thicknessX = thicknessWorld / Math.max(Math.abs(scale.x), 0.001);
				const thicknessY = thicknessWorld / Math.max(Math.abs(scale.y), 0.001);
				const thicknessZ = thicknessWorld / Math.max(Math.abs(scale.z), 0.001);
				if (target.face === "right" || target.face === "left") {
					const sign = target.face === "right" ? -1 : 1;
					const x = sign * (width / 2 + thicknessX);
					addBox(
						material,
						renderOrder,
						thicknessX,
						thicknessY,
						depth,
						x,
						height / 2,
						0,
					);
					addBox(
						material,
						renderOrder,
						thicknessX,
						thicknessY,
						depth,
						x,
						-height / 2,
						0,
					);
					addBox(
						material,
						renderOrder,
						thicknessX,
						height,
						thicknessZ,
						x,
						0,
						depth / 2,
					);
					addBox(
						material,
						renderOrder,
						thicknessX,
						height,
						thicknessZ,
						x,
						0,
						-depth / 2,
					);
					return;
				}
				if (target.face === "top" || target.face === "bottom") {
					const sign = target.face === "top" ? 1 : -1;
					const y = sign * (height / 2 + thicknessY);
					addBox(
						material,
						renderOrder,
						width,
						thicknessY,
						thicknessZ,
						0,
						y,
						depth / 2,
					);
					addBox(
						material,
						renderOrder,
						width,
						thicknessY,
						thicknessZ,
						0,
						y,
						-depth / 2,
					);
					addBox(
						material,
						renderOrder,
						thicknessX,
						thicknessY,
						depth,
						width / 2,
						y,
						0,
					);
					addBox(
						material,
						renderOrder,
						thicknessX,
						thicknessY,
						depth,
						-width / 2,
						y,
						0,
					);
					return;
				}
				const sign = target.face === "front" ? 1 : -1;
				const z = sign * (depth / 2 + thicknessZ);
				addBox(
					material,
					renderOrder,
					width,
					thicknessY,
					thicknessZ,
					0,
					height / 2,
					z,
				);
				addBox(
					material,
					renderOrder,
					width,
					thicknessY,
					thicknessZ,
					0,
					-height / 2,
					z,
				);
				addBox(
					material,
					renderOrder,
					thicknessX,
					height,
					thicknessZ,
					width / 2,
					0,
					z,
				);
				addBox(
					material,
					renderOrder,
					thicknessX,
					height,
					thicknessZ,
					-width / 2,
					0,
					z,
				);
			};

			drawEdges(outerMaterial, 0.24, 22);
			drawEdges(innerMaterial, 0.1, 23);
			layer.add(group);
			highlightResourcesRef.current = {
				geometries,
				group,
				materials,
				parent: layer,
			};
			viewer.render();
		},
		[clearFaceHighlight],
	);

	useEffect(() => {
		if (!canvasRef.current || !frameRef.current) return;

		let disposed = false;
		const frame = frameRef.current;
		const canvas = canvasRef.current;
		const rect = frame.getBoundingClientRect();
		const viewer = new SkinViewer({
			canvas,
			width: Math.max(280, Math.round(rect.width)),
			height: Math.max(360, Math.round(rect.height)),
			fov: 42,
			zoom: 0.82,
			enableControls: true,
		});
		viewer.autoRotate = true;
		viewer.autoRotateSpeed = 0.45;
		viewer.controls.enablePan = false;
		viewer.controls.enableZoom = false;
		viewer.controls.rotateSpeed = 0.55;
		viewerRef.current = viewer;

		const observer = new ResizeObserver(([entry]) => {
			if (!entry || disposed || viewer.disposed) return;
			const { width, height } = entry.contentRect;
			viewer.setSize(Math.max(240, Math.round(width)), Math.round(height));
		});
		observer.observe(frame);

		return () => {
			disposed = true;
			observer.disconnect();
			clearFaceHighlight(viewer);
			viewer.dispose();
			viewerRef.current = null;
		};
	}, [clearFaceHighlight]);

	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer) return;
		viewer.autoRotate = !autoRotatePaused;
	}, [autoRotatePaused]);

	useEffect(() => {
		highlightRef.current = highlight;
		applyFaceHighlight();
	}, [applyFaceHighlight, highlight]);

	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer || pose) return;
		const animation =
			motion === "walk" ? new WalkingAnimation() : new IdleAnimation();
		animation.speed = motion === "walk" ? 0.78 : 0.9;
		viewer.animation = animation;
	}, [motion, pose]);

	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer || !pose) return;
		viewer.animation = null;
		const skin = viewer.playerObject.skin;
		skin.head.rotation.x = pose.headPitch ?? 0;
		skin.head.rotation.y = pose.headYaw ?? 0;
		skin.rightArm.rotation.x = pose.rightArmPitch ?? 0;
		skin.leftArm.rotation.x = pose.leftArmPitch ?? 0;
		skin.rightLeg.rotation.x = pose.rightLegPitch ?? 0;
		skin.leftLeg.rotation.x = pose.leftLegPitch ?? 0;
	}, [pose]);

	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer) return;
		let cancelled = false;
		const loadingSkinKey = skinKey;

		const options: SkinLoadOptions = {
			model: model === "slim" ? "slim" : "default",
			ears: "load-only",
		};

		if (!skinUrl) {
			viewer.loadSkin(null);
			return;
		}

		void viewer.loadSkin(skinUrl, options).then(
			() => {
				if (cancelled) return;
				setFailedSkinKey((current) =>
					current === loadingSkinKey ? null : current,
				);
				applyFaceHighlight(viewer);
			},
			() => {
				if (cancelled || loadingSkinKey === null) return;
				setFailedSkinKey(loadingSkinKey);
				viewer.loadSkin(null);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [applyFaceHighlight, skinUrl, model, skinKey]);

	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer) return;

		if (!capeUrl) {
			viewer.loadCape(null);
			return;
		}
		void viewer.loadCape(capeUrl).catch(() => {
			viewer.loadCape(null);
		});
	}, [capeUrl]);

	return (
		<div
			className={cn(
				"w-full overflow-hidden rounded-lg border border-border/70 bg-card shadow-xs",
				className,
			)}
		>
			<div
				className={cn(
					"flex min-h-12 gap-3 border-b border-border/70 px-4 py-3",
					compactHeader
						? "flex-row items-center justify-between"
						: "flex-col sm:flex-row sm:items-center sm:justify-between",
				)}
			>
				<div className="min-w-0">
					<div className="truncate text-sm font-semibold">{label}</div>
					<div className="truncate text-xs text-muted-foreground">
						{playerName || noSkinLabel}
					</div>
				</div>
				{showMotionControls ? (
					<div className="flex w-fit shrink-0 rounded-lg border border-border/70 bg-muted/30 p-1">
						<Button
							type="button"
							size="sm"
							variant={motion === "idle" ? "default" : "ghost"}
							onClick={() => setMotion("idle")}
						>
							{idleLabel}
						</Button>
						<Button
							type="button"
							size="sm"
							variant={motion === "walk" ? "default" : "ghost"}
							onClick={() => setMotion("walk")}
						>
							{walkLabel}
						</Button>
					</div>
				) : null}
			</div>
			<div
				ref={frameRef}
				className={cn(
					"relative h-[26rem] bg-[radial-gradient(circle_at_50%_18%,oklch(0.92_0.024_151_/_0.75),transparent_42%),linear-gradient(180deg,oklch(0.96_0.004_255),oklch(0.9_0.01_255))] dark:bg-[radial-gradient(circle_at_50%_18%,oklch(0.32_0.06_151_/_0.5),transparent_42%),linear-gradient(180deg,oklch(0.2_0.02_255),oklch(0.17_0.018_255))]",
					frameClassName,
				)}
			>
				<canvas ref={canvasRef} className="block size-full" />
				{hasTexture && !failed ? null : (
					<div className="absolute inset-0 grid place-items-center p-6 text-center">
						<div className="rounded-lg border border-border/70 bg-background/82 px-4 py-3 shadow-lg backdrop-blur">
							<div className="text-sm font-semibold">
								{failed ? failedTitle : emptyTitle}
							</div>
							<p className="mt-1 max-w-52 text-xs leading-5 text-muted-foreground">
								{failed ? failedDescription : emptyDescription}
							</p>
						</div>
					</div>
				)}
			</div>
			{showAutoRotateControl ? (
				<div className="flex justify-center border-t border-border/70 bg-muted/20 p-2">
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="w-full"
						disabled={!hasTexture || failed}
						onClick={() => setAutoRotatePaused((value) => !value)}
					>
						<Icon
							name={autoRotatePaused ? "Play" : "Pause"}
							className="size-4"
						/>
						{autoRotatePaused ? resumeAutoRotateLabel : pauseAutoRotateLabel}
					</Button>
				</div>
			) : null}
		</div>
	);
}
