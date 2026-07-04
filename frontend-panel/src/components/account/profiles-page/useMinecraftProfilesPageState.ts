import { useReducer } from "react";
import type {
	IdCursor,
	MinecraftTextureMetadata,
	MinecraftTextureModel,
	MinecraftTextureType,
	MinecraftTextureVisibility,
	YggdrasilProfile,
} from "@/types/api";

export type MinecraftProfilesPageState = {
	debouncedQuery: string;
	deleteDialogOpen: boolean;
	deleteProfileDialogOpen: boolean;
	deletingProfile: boolean;
	dragActive: boolean;
	file: File | null;
	loading: boolean;
	model: MinecraftTextureModel;
	profileCursorStack: IdCursor[];
	profileNextCursor: IdCursor | null;
	profilePageSize: number;
	profileName: string;
	profileTotal: number;
	profileSkinUrls: Record<string, string | null>;
	profiles: YggdrasilProfile[];
	profilesLoading: boolean;
	query: string;
	renameDialogOpen: boolean;
	renameName: string;
	renaming: boolean;
	refreshingOfficialProfileUuid: string | null;
	selectedUuid: string;
	textures: MinecraftTextureMetadata[];
	texturesLoading: boolean;
	textureDialogOpen: boolean;
	textureManageDialogOpen: boolean;
	textureType: MinecraftTextureType;
	uploadTextureType: MinecraftTextureType;
	visibility: MinecraftTextureVisibility;
};

export type MinecraftProfilesPageAction =
	| { type: "debouncedQuery"; value: string }
	| { type: "deleteDialogOpen"; value: boolean }
	| { type: "deleteProfileDialogOpen"; value: boolean }
	| { type: "deletingProfile"; value: boolean }
	| { type: "dragActive"; value: boolean }
	| { type: "file"; value: File | null }
	| { type: "loading"; value: boolean }
	| { type: "model"; value: MinecraftTextureModel }
	| { type: "profileCursorStack"; value: IdCursor[] }
	| { type: "profileNextCursor"; value: IdCursor | null }
	| { type: "profilePageSize"; value: number }
	| { type: "profileName"; value: string }
	| {
			type: "profilePage";
			value: {
				cursorStack?: IdCursor[];
				items: YggdrasilProfile[];
				next_cursor?: IdCursor | null;
				selectedUuid?: string;
				total: number;
			};
	  }
	| { type: "profileSkinUrls"; value: Record<string, string | null> }
	| { type: "profiles"; value: YggdrasilProfile[] }
	| { type: "profilesLoading"; value: boolean }
	| { type: "query"; value: string }
	| { type: "renameDialogOpen"; value: boolean }
	| { type: "renameName"; value: string }
	| { type: "renaming"; value: boolean }
	| { type: "refreshingOfficialProfileUuid"; value: string | null }
	| { type: "selectedUuid"; value: string }
	| { type: "textures"; value: MinecraftTextureMetadata[] }
	| { type: "texturesLoading"; value: boolean }
	| { type: "textureDialogOpen"; value: boolean }
	| { type: "textureManageDialogOpen"; value: boolean }
	| { type: "textureType"; value: MinecraftTextureType }
	| { type: "uploadTextureType"; value: MinecraftTextureType }
	| { type: "visibility"; value: MinecraftTextureVisibility };

const initialState: MinecraftProfilesPageState = {
	debouncedQuery: "",
	deleteDialogOpen: false,
	deleteProfileDialogOpen: false,
	deletingProfile: false,
	dragActive: false,
	file: null,
	loading: false,
	model: "default",
	profileCursorStack: [],
	profileNextCursor: null,
	profilePageSize: 5,
	profileName: "",
	profileTotal: 0,
	profileSkinUrls: {},
	profiles: [],
	profilesLoading: false,
	query: "",
	renameDialogOpen: false,
	renameName: "",
	renaming: false,
	refreshingOfficialProfileUuid: null,
	selectedUuid: "",
	textures: [],
	texturesLoading: false,
	textureDialogOpen: false,
	textureManageDialogOpen: false,
	textureType: "skin",
	uploadTextureType: "skin",
	visibility: "private",
};

function reducer(
	state: MinecraftProfilesPageState,
	action: MinecraftProfilesPageAction,
): MinecraftProfilesPageState {
	switch (action.type) {
		case "file":
		case "debouncedQuery":
		case "deleteDialogOpen":
		case "deleteProfileDialogOpen":
		case "deletingProfile":
		case "dragActive":
		case "loading":
		case "model":
		case "profileCursorStack":
		case "profileNextCursor":
		case "profilePageSize":
		case "profileName":
		case "profileSkinUrls":
		case "profilesLoading":
		case "query":
		case "renameDialogOpen":
		case "renameName":
		case "renaming":
		case "refreshingOfficialProfileUuid":
		case "selectedUuid":
		case "textures":
		case "texturesLoading":
		case "textureDialogOpen":
		case "textureManageDialogOpen":
		case "textureType":
		case "uploadTextureType":
		case "visibility":
			return { ...state, [action.type]: action.value };
		case "profiles":
			return {
				...state,
				profileTotal: action.value.length,
				profiles: action.value,
				selectedUuid: action.value.some(
					(profile) => profile.id === state.selectedUuid,
				)
					? state.selectedUuid
					: action.value[0]?.id || "",
			};
		case "profilePage":
			return {
				...state,
				profileCursorStack:
					action.value.cursorStack &&
					!sameCursorStack(action.value.cursorStack, state.profileCursorStack)
						? action.value.cursorStack
						: state.profileCursorStack,
				profileNextCursor: action.value.next_cursor ?? null,
				profileTotal: action.value.total,
				profiles: action.value.items,
				selectedUuid:
					action.value.selectedUuid &&
					action.value.items.some(
						(profile) => profile.id === action.value.selectedUuid,
					)
						? action.value.selectedUuid
						: action.value.items.some(
									(profile) => profile.id === state.selectedUuid,
								)
							? state.selectedUuid
							: action.value.items[0]?.id || "",
			};
	}
}

function sameCursorStack(left: IdCursor[], right: IdCursor[]) {
	if (left.length !== right.length) return false;
	return left.every((cursor, index) => cursor.id === right[index]?.id);
}

export function useMinecraftProfilesPageState() {
	return useReducer(reducer, initialState);
}
