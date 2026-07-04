use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;

use crate::api::error_code::AsterErrorCode;
use crate::config::yggdrasil::RuntimeYggdrasilPolicy;
use crate::entities::minecraft_profile;
use crate::errors::{AsterError, Result};
use crate::runtime::{
    CacheRuntimeState, DatabaseRuntimeState, ObjectStorageRuntimeState, RuntimeConfigRuntimeState,
};
use crate::services::texture_service;
use crate::types::yggdrasil::{
    MinecraftProfileSource, MinecraftTextureModel, MinecraftTextureType,
};
use crate::utils::OUTBOUND_HTTP_USER_AGENT;

const MOJANG_SESSION_SERVER_PROFILE_URL: &str =
    "https://sessionserver.mojang.com/session/minecraft/profile";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MojangProfileName {
    pub uuid: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MojangProfileNameLookup {
    Found(MojangProfileName),
    NotFound,
}

#[derive(Debug, Deserialize)]
struct MojangProfileResponse {
    id: Option<String>,
    name: Option<String>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MojangOfficialTextures {
    pub skin: Option<MojangOfficialTexture>,
    pub cape: Option<MojangOfficialTexture>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MojangOfficialTexture {
    pub url: String,
    pub texture_model: MinecraftTextureModel,
}

#[derive(Debug, Deserialize)]
struct MojangSessionProfileResponse {
    properties: Vec<MojangSessionProfileProperty>,
}

#[derive(Debug, Deserialize)]
struct MojangSessionProfileProperty {
    name: String,
    value: String,
}

pub async fn lookup_profile_name<S>(state: &S, name: &str) -> Result<MojangProfileNameLookup>
where
    S: RuntimeConfigRuntimeState,
{
    let policy = RuntimeYggdrasilPolicy::from_runtime_config(state.runtime_config());
    let url = format!(
        "{}/users/profiles/minecraft/{}",
        policy.mojang_profile_api_base_url.trim_end_matches('/'),
        urlencoding::encode(name)
    );
    let http_client = reqwest::Client::builder()
        .user_agent(OUTBOUND_HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(
            policy.mojang_name_check_timeout_secs,
        ))
        .build()
        .map_err(|error| AsterError::internal_error(format!("build HTTP client: {error}")))?;

    let response = http_client.get(&url).send().await.map_err(|error| {
        tracing::warn!(error = %error, profile_name = %name, "Mojang profile name lookup failed");
        mojang_lookup_failed_error()
    })?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(MojangProfileNameLookup::NotFound);
    }
    if !status.is_success() {
        tracing::warn!(
            status = %status,
            profile_name = %name,
            "Mojang profile name lookup returned non-success status"
        );
        return Err(mojang_lookup_failed_error());
    }

    let body = response.json::<MojangProfileResponse>().await.map_err(|error| {
        tracing::warn!(error = %error, profile_name = %name, "Mojang profile name lookup response parse failed");
        mojang_lookup_failed_error()
    })?;
    if let Some(message) = body.error_message.as_deref()
        && message
            .to_ascii_lowercase()
            .contains("couldn't find any profile")
    {
        return Ok(MojangProfileNameLookup::NotFound);
    }
    let (Some(id), Some(name)) = (body.id, body.name) else {
        return Err(mojang_lookup_failed_error());
    };
    let uuid = uuid::Uuid::parse_str(id.trim())
        .map_err(|_| mojang_lookup_failed_error())?
        .simple()
        .to_string();
    Ok(MojangProfileNameLookup::Found(MojangProfileName {
        uuid,
        name,
    }))
}

pub async fn refresh_official_profile_textures<S>(
    state: &S,
    profile: &minecraft_profile::Model,
) -> Result<Vec<texture_service::MinecraftTextureMetadata>>
where
    S: CacheRuntimeState
        + DatabaseRuntimeState
        + RuntimeConfigRuntimeState
        + ObjectStorageRuntimeState,
{
    if profile.source != MinecraftProfileSource::Microsoft {
        return Err(AsterError::auth_forbidden_code(
            AsterErrorCode::MinecraftProfileOfficialNameReadonly,
            "official texture refresh requires a Microsoft Minecraft profile",
        ));
    }

    let official_textures = fetch_official_profile_textures(state, &profile.uuid).await?;
    sync_official_texture_slot(
        state,
        profile,
        MinecraftTextureType::Skin,
        official_textures.skin.as_ref(),
    )
    .await?;
    sync_official_texture_slot(
        state,
        profile,
        MinecraftTextureType::Cape,
        official_textures.cape.as_ref(),
    )
    .await?;
    texture_service::texture_metadata_for_profile(state, profile).await
}

async fn sync_official_texture_slot<S>(
    state: &S,
    profile: &minecraft_profile::Model,
    texture_type: MinecraftTextureType,
    texture: Option<&MojangOfficialTexture>,
) -> Result<()>
where
    S: CacheRuntimeState
        + DatabaseRuntimeState
        + RuntimeConfigRuntimeState
        + ObjectStorageRuntimeState,
{
    if let Some(texture) = texture {
        texture_service::import_official_texture_to_profile(
            state,
            profile,
            texture_type,
            texture.texture_model,
            &texture.url,
        )
        .await
        .map_err(|error| AsterError::internal_error(error.protocol_message()))?;
    } else {
        texture_service::delete_texture_for_profile_unchecked(state, profile, texture_type)
            .await
            .map_err(|error| AsterError::internal_error(error.protocol_message()))?;
    }
    Ok(())
}

async fn fetch_official_profile_textures<S>(state: &S, uuid: &str) -> Result<MojangOfficialTextures>
where
    S: RuntimeConfigRuntimeState,
{
    let policy = RuntimeYggdrasilPolicy::from_runtime_config(state.runtime_config());
    let url = format!(
        "{}/{}?unsigned=false",
        MOJANG_SESSION_SERVER_PROFILE_URL, uuid
    );
    let http_client = reqwest::Client::builder()
        .user_agent(OUTBOUND_HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(
            policy.mojang_name_check_timeout_secs,
        ))
        .build()
        .map_err(|error| AsterError::internal_error(format!("build HTTP client: {error}")))?;

    let response = http_client.get(&url).send().await.map_err(|error| {
        tracing::warn!(error = %error, profile_uuid = %uuid, "Mojang profile texture refresh failed");
        mojang_lookup_failed_error()
    })?;
    let status = response.status();
    if !status.is_success() {
        tracing::warn!(
            status = %status,
            profile_uuid = %uuid,
            "Mojang profile texture refresh returned non-success status"
        );
        return Err(mojang_lookup_failed_error());
    }

    let body = response
        .json::<MojangSessionProfileResponse>()
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, profile_uuid = %uuid, "Mojang profile texture refresh response parse failed");
            mojang_lookup_failed_error()
        })?;
    parse_official_textures_property(&body)
}

fn parse_official_textures_property(
    profile: &MojangSessionProfileResponse,
) -> Result<MojangOfficialTextures> {
    let Some(property) = profile
        .properties
        .iter()
        .find(|property| property.name == "textures")
    else {
        return Ok(MojangOfficialTextures::default());
    };
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&property.value)
        .map_err(|_| mojang_lookup_failed_error())?;
    let payload =
        serde_json::from_slice::<Value>(&decoded).map_err(|_| mojang_lookup_failed_error())?;
    let textures = payload.get("textures").and_then(Value::as_object);
    let skin = textures
        .and_then(|items| items.get("SKIN"))
        .and_then(parse_official_texture_item);
    let cape = textures
        .and_then(|items| items.get("CAPE"))
        .and_then(parse_official_texture_item)
        .map(|texture| MojangOfficialTexture {
            texture_model: MinecraftTextureModel::Default,
            ..texture
        });
    Ok(MojangOfficialTextures { skin, cape })
}

fn parse_official_texture_item(value: &Value) -> Option<MojangOfficialTexture> {
    let url = value.get("url")?.as_str()?.trim();
    if url.is_empty() {
        return None;
    }
    let texture_model = value
        .get("metadata")
        .and_then(|metadata| metadata.get("model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| model.eq_ignore_ascii_case("slim"))
        .map(|_| MinecraftTextureModel::Slim)
        .unwrap_or(MinecraftTextureModel::Default);
    Some(MojangOfficialTexture {
        url: url.to_string(),
        texture_model,
    })
}

fn mojang_lookup_failed_error() -> AsterError {
    AsterError::validation_error_code(
        AsterErrorCode::MinecraftProfileMojangLookupFailed,
        "failed to verify Mojang profile name availability",
    )
}
