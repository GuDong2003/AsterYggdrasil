import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Pcl2ClosetRedirect } from "@/routes/accountRoutes";
import { accountPaths, accountWardrobeEditorPath } from "@/routes/routePaths";

function LocationProbe() {
	const location = useLocation();
	return (
		<div data-testid="location">
			{location.pathname}
			{location.search}
			{location.hash}
		</div>
	);
}

describe("account routes", () => {
	it("builds a wardrobe skin editor path for the selected texture", () => {
		expect(accountWardrobeEditorPath(42)).toBe("/account/wardrobe/editor/42");
	});

	it("redirects the PCL2 closet path to the wardrobe route", async () => {
		render(
			<MemoryRouter initialEntries={["/user/closet?from=pcl2#skin"]}>
				<Routes>
					<Route
						path={accountPaths.wardrobePcl2Compat}
						element={<Pcl2ClosetRedirect />}
					/>
					<Route path={accountPaths.wardrobe} element={<LocationProbe />} />
				</Routes>
			</MemoryRouter>,
		);

		expect(await screen.findByTestId("location")).toHaveTextContent(
			"/account/wardrobe?from=pcl2#skin",
		);
	});
});
