import { withQuery } from "@/lib/query";
import type {
	ExternalAuthFinishLoginResponse,
	ExternalAuthLinkInfo,
	ExternalAuthLinkPage,
	ExternalAuthLinkQuery,
	ExternalAuthMinecraftBindingProviderPage,
	ExternalAuthMinecraftBindingProviderQuery,
	ExternalAuthPublicProvider,
	ExternalAuthPublicProviderByKindPage,
	ExternalAuthPublicProviderByKindQuery,
	ExternalAuthPublicProviderPage,
	ExternalAuthPublicProviderQuery,
	ExternalAuthStartLoginRequest,
	ExternalAuthStartLoginResponse,
	OperationPath,
	OperationQuery,
	OperationRequestBody,
} from "@/types/api";
import { api } from "./http";

type AuthExternalAuthFinishLoginQuery =
	OperationQuery<"auth_external_auth_finish_login">;
type AuthExternalAuthProviderPath =
	OperationPath<"auth_external_auth_start_login">;
type AuthExternalAuthMinecraftBindingProviderPath =
	OperationPath<"auth_external_auth_start_minecraft_binding">;
type AuthExternalAuthKindPath =
	OperationPath<"auth_external_auth_list_providers_by_kind">;

export type MinecraftDeviceCodeStartResponse =
	ExternalAuthStartLoginResponse & {
		device_code?: string | null;
		user_code?: string | null;
		verification_uri?: string | null;
		expires_in?: number | null;
		interval?: number | null;
	};

export type MinecraftDeviceCodeCheckResponse = {
	status: "completed" | "pending";
	profile?: {
		uuid: string;
		name: string;
	} | null;
	profile_created?: boolean | null;
	identity_linked?: boolean | null;
};

type MinecraftDeviceCodeCheckRequest = {
	device_code: string;
};

type CachedRequestOptions = {
	force?: boolean;
	signal?: AbortSignal;
};

let cachedPublicProviders: ExternalAuthPublicProvider[] | null = null;
let pendingPublicProvidersRequest: Promise<
	ExternalAuthPublicProvider[]
> | null = null;
let publicProvidersCacheSerial = 0;

let cachedLinks: ExternalAuthLinkInfo[] | null = null;
let pendingLinksRequest: Promise<ExternalAuthLinkInfo[]> | null = null;
let linksCacheSerial = 0;

function clonePublicProviders(providers: ExternalAuthPublicProvider[]) {
	return providers.map((provider) => ({ ...provider }));
}

function cloneLinks(links: ExternalAuthLinkInfo[]) {
	return links.map((link) => ({ ...link }));
}

function isAbortSignal(options: AbortSignal | CachedRequestOptions) {
	return "aborted" in options && "addEventListener" in options;
}

function normalizeOptions(
	options?: AbortSignal | CachedRequestOptions,
): CachedRequestOptions {
	if (!options) return {};
	if (isAbortSignal(options)) {
		return { signal: options };
	}
	return options;
}

function primePublicProvidersCache(providers: ExternalAuthPublicProvider[]) {
	cachedPublicProviders = clonePublicProviders(providers);
}

function primeLinksCache(links: ExternalAuthLinkInfo[]) {
	cachedLinks = cloneLinks(links);
}

export function invalidateExternalAuthProvidersCache() {
	cachedPublicProviders = null;
	pendingPublicProvidersRequest = null;
	publicProvidersCacheSerial += 1;
}

export function invalidateExternalAuthLinksCache() {
	cachedLinks = null;
	pendingLinksRequest = null;
	linksCacheSerial += 1;
}

function removeCachedLink(id: number) {
	pendingLinksRequest = null;
	linksCacheSerial += 1;
	if (cachedLinks === null) return;
	cachedLinks = cachedLinks.filter((link) => link.id !== id);
}

function listPublic(options?: AbortSignal | CachedRequestOptions) {
	const { force = false, signal } = normalizeOptions(options);
	if (!force && !signal && cachedPublicProviders !== null) {
		return Promise.resolve(clonePublicProviders(cachedPublicProviders));
	}
	if (!force && !signal && pendingPublicProvidersRequest !== null) {
		return pendingPublicProvidersRequest.then(clonePublicProviders);
	}

	const requestSerial = ++publicProvidersCacheSerial;
	const request = api
		.get<ExternalAuthPublicProviderPage>(
			withQuery("/auth/external-auth/providers", { limit: 20 }),
			{ signal },
		)
		.then((page) => {
			const providers = page.items;
			if (!signal && requestSerial === publicProvidersCacheSerial) {
				primePublicProvidersCache(providers);
			}
			return clonePublicProviders(providers);
		})
		.finally(() => {
			if (pendingPublicProvidersRequest === request) {
				pendingPublicProvidersRequest = null;
			}
		});
	if (!signal) {
		pendingPublicProvidersRequest = request;
	}
	return request.then(clonePublicProviders);
}

function listPublicPage(
	params: ExternalAuthPublicProviderQuery = {},
	options?: AbortSignal | CachedRequestOptions,
) {
	const { signal } = normalizeOptions(options);
	return api.get<ExternalAuthPublicProviderPage>(
		withQuery("/auth/external-auth/providers", params),
		{ signal },
	);
}

function listPublicByKindPage(
	kind: AuthExternalAuthKindPath["kind"],
	params: ExternalAuthPublicProviderByKindQuery = {},
	options?: AbortSignal | CachedRequestOptions,
) {
	const { signal } = normalizeOptions(options);
	return api.get<ExternalAuthPublicProviderByKindPage>(
		withQuery(
			`/auth/external-auth/${encodeURIComponent(kind)}/providers`,
			params,
		),
		{ signal },
	);
}

function listMinecraftBindingProvidersByKindPage(
	kind: AuthExternalAuthMinecraftBindingProviderPath["kind"],
	params: ExternalAuthMinecraftBindingProviderQuery = {},
	options?: AbortSignal | CachedRequestOptions,
) {
	const { signal } = normalizeOptions(options);
	return api.get<ExternalAuthMinecraftBindingProviderPage>(
		withQuery(
			`/auth/external-auth/${encodeURIComponent(kind)}/binding/providers`,
			params,
		),
		{ signal },
	);
}

function listLinks(options?: AbortSignal | CachedRequestOptions) {
	const { force = false, signal } = normalizeOptions(options);
	if (!force && !signal && cachedLinks !== null) {
		return Promise.resolve(cloneLinks(cachedLinks));
	}
	if (!force && !signal && pendingLinksRequest !== null) {
		return pendingLinksRequest.then(cloneLinks);
	}

	const requestSerial = ++linksCacheSerial;
	const request = api
		.get<ExternalAuthLinkPage>(
			withQuery("/auth/external-auth/links", { limit: 20 }),
			{ signal },
		)
		.then((page) => {
			const links = page.items;
			if (!signal && requestSerial === linksCacheSerial) {
				primeLinksCache(links);
			}
			return cloneLinks(links);
		})
		.finally(() => {
			if (pendingLinksRequest === request) {
				pendingLinksRequest = null;
			}
		});
	if (!signal) {
		pendingLinksRequest = request;
	}
	return request.then(cloneLinks);
}

function listLinksPage(
	params: ExternalAuthLinkQuery = {},
	options?: AbortSignal | CachedRequestOptions,
) {
	const { signal } = normalizeOptions(options);
	return api.get<ExternalAuthLinkPage>(
		withQuery("/auth/external-auth/links", {
			limit: params.limit,
			after_created_at: params.after_created_at,
			after_id: params.after_id,
		}),
		{ signal },
	);
}

export const externalAuthService = {
	listPublic,
	listPublicPage,
	listAuthAliases: listPublic,
	listAuthAliasesByKind: (
		kind: AuthExternalAuthKindPath["kind"],
		signal?: AbortSignal,
	) =>
		listPublicByKindPage(kind, { limit: 20 }, signal).then(
			(page) => page.items,
		),
	listAuthAliasesByKindPage: listPublicByKindPage,
	listMinecraftBindingProvidersByKindPage,
	startAuthAlias: (
		kind: AuthExternalAuthProviderPath["kind"],
		provider: AuthExternalAuthProviderPath["provider"],
		data: ExternalAuthStartLoginRequest,
	) =>
		api.post<
			ExternalAuthStartLoginResponse,
			OperationRequestBody<"auth_external_auth_start_login">
		>(
			`/auth/external-auth/${encodeURIComponent(kind)}/${encodeURIComponent(
				provider,
			)}/start`,
			data,
		),
	startMinecraftBinding: (
		kind: AuthExternalAuthMinecraftBindingProviderPath["kind"],
		provider: AuthExternalAuthMinecraftBindingProviderPath["provider"],
		data: ExternalAuthStartLoginRequest,
	) =>
		api.post<
			MinecraftDeviceCodeStartResponse,
			OperationRequestBody<"auth_external_auth_start_minecraft_binding">
		>(
			`/auth/external-auth/${encodeURIComponent(kind)}/${encodeURIComponent(
				provider,
			)}/binding/start`,
			data,
		),
	checkMinecraftDeviceCode: (data: MinecraftDeviceCodeCheckRequest) =>
		api.post<MinecraftDeviceCodeCheckResponse, MinecraftDeviceCodeCheckRequest>(
			"/auth/external-auth/device-code/check",
			data,
		),
	finishAuthAlias: (
		kind: AuthExternalAuthProviderPath["kind"],
		provider: AuthExternalAuthProviderPath["provider"],
		state: AuthExternalAuthFinishLoginQuery["state"],
		code: AuthExternalAuthFinishLoginQuery["code"],
	) =>
		api.get<ExternalAuthFinishLoginResponse>(
			withQuery(
				`/auth/external-auth/${encodeURIComponent(kind)}/${encodeURIComponent(
					provider,
				)}/callback`,
				{ state, code },
			),
		),
	listLinks,
	listLinksPage,
	deleteLink: async (id: number) => {
		await api.delete<void>(`/auth/external-auth/links/${id}`);
		removeCachedLink(id);
	},
};
