import { Navigate, type RouteObject, useLocation } from "react-router-dom";
import { AppShell } from "@/components/shell/AppShell";
import { lazyWithPreload } from "@/lib/lazyWithPreload";
import { accountPaths } from "@/routes/routePaths";

const AccountOverviewPage = lazyWithPreload(
	() => import("@/pages/account/AccountOverviewPage"),
);
const MinecraftProfilesPage = lazyWithPreload(
	() => import("@/pages/account/MinecraftProfilesPage"),
);
const AccountSettingsPage = lazyWithPreload(
	() => import("@/pages/account/AccountSettingsPage"),
);
const AccountAuditPage = lazyWithPreload(
	() => import("@/pages/account/AccountAuditPage"),
);
const TextureWardrobePage = lazyWithPreload(
	() => import("@/pages/account/TextureWardrobePage"),
);
const SkinEditorPage = lazyWithPreload(
	() => import("@/pages/account/SkinEditorPage"),
);

export function Pcl2ClosetRedirect() {
	const location = useLocation();
	return (
		<Navigate
			replace
			to={`${accountPaths.wardrobe}${location.search}${location.hash}`}
		/>
	);
}

export const accountRoutes = [
	{
		element: <AppShell scope="account" />,
		children: [
			{ path: accountPaths.home, element: <AccountOverviewPage /> },
			{ path: accountPaths.profiles, element: <MinecraftProfilesPage /> },
			{ path: accountPaths.wardrobe, element: <TextureWardrobePage /> },
			{ path: accountPaths.wardrobeEditor, element: <SkinEditorPage /> },
			{
				path: accountPaths.wardrobePcl2Compat,
				element: <Pcl2ClosetRedirect />,
			},
			{ path: accountPaths.audit, element: <AccountAuditPage /> },
			{ path: accountPaths.settings, element: <AccountSettingsPage /> },
			{
				path: accountPaths.settingsSecurityCompat,
				element: <AccountSettingsPage />,
			},
		],
	},
] satisfies RouteObject[];
