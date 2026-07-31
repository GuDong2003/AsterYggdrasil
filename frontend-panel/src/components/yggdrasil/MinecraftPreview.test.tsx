import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MinecraftPreview } from "@/components/yggdrasil/MinecraftPreview";

const skinViewerMock = vi.hoisted(() => ({
	instances: [] as Array<{
		autoRotate: boolean;
		playerObject: {
			skin: Record<
				string,
				{
					innerLayer: {
						children: Array<{ children?: unknown[]; name?: string }>;
					};
				}
			>;
		};
	}>,
}));

vi.mock("skinview3d", async () => {
	const { BoxGeometry, Mesh, MeshBasicMaterial } = await import("three");
	const createPart = () => ({
		innerLayer: new Mesh(new BoxGeometry(8, 8, 8), new MeshBasicMaterial()),
		outerLayer: new Mesh(new BoxGeometry(9, 9, 9), new MeshBasicMaterial()),
	});

	class AnimationMock {
		speed = 1;
	}

	class SkinViewerMock {
		autoRotate = false;
		autoRotateSpeed = 1;
		animation: AnimationMock | null = null;
		disposed = false;
		controls = {
			enablePan: true,
			enableRotate: true,
			enableZoom: true,
			rotateSpeed: 1,
		};
		playerObject = {
			skin: {
				head: createPart(),
				body: createPart(),
				rightArm: createPart(),
				leftArm: createPart(),
				rightLeg: createPart(),
				leftLeg: createPart(),
			},
		};

		constructor() {
			skinViewerMock.instances.push(this);
		}

		dispose() {
			this.disposed = true;
		}

		loadCape() {
			return Promise.resolve();
		}

		loadSkin() {
			return Promise.resolve();
		}

		render() {}
		setSize() {}
	}

	return {
		IdleAnimation: AnimationMock,
		SkinViewer: SkinViewerMock,
		WalkingAnimation: AnimationMock,
	};
});

describe("MinecraftPreview", () => {
	it("pauses and resumes automatic rotation from the preview footer", async () => {
		render(
			<MinecraftPreview
				label="Preview"
				skinUrl="/skin.png"
				showAutoRotateControl
				pauseAutoRotateLabel="Pause rotation"
				resumeAutoRotateLabel="Resume rotation"
			/>,
		);

		const viewer = skinViewerMock.instances.at(-1);
		expect(viewer?.autoRotate).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "Pause rotation" }));
		await waitFor(() => expect(viewer?.autoRotate).toBe(false));

		fireEvent.click(screen.getByRole("button", { name: "Resume rotation" }));
		await waitFor(() => expect(viewer?.autoRotate).toBe(true));
	});

	it("draws only the two border strokes around the hovered face", async () => {
		render(
			<MinecraftPreview
				label="Preview"
				skinUrl="/skin.png"
				highlight={{ face: "front", layer: "base", part: "head" }}
			/>,
		);

		const viewer = skinViewerMock.instances.at(-1);
		await waitFor(() => {
			const layer = viewer?.playerObject.skin.head.innerLayer;
			const highlight = layer?.children.find(
				(child) => child.name === "skin-editor-face-highlight",
			);
			expect(highlight?.children).toHaveLength(8);
		});
	});
});
