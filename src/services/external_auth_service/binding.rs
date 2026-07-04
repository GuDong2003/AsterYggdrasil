use chrono::{Duration, Utc};
use sea_orm::ActiveValue::Set;
use serde::{Deserialize, Serialize};

use crate::api::error_code::AsterErrorCode;
use crate::db::repository::{
    external_auth_binding_flow_repo, external_auth_identity_repo, external_auth_provider_repo,
    minecraft_profile_repo,
};
use crate::entities::{external_auth_binding_flow, external_auth_identity, external_auth_provider};
use crate::errors::{AsterError, Result};
use crate::external_auth::{MapExternalAuthResult, registry};
use crate::runtime::SharedRuntimeState;
use crate::types::external_auth::{ExternalAuthProviderKind, parse_external_auth_provider_options};
use crate::types::user::UserRole;
use crate::utils::OUTBOUND_HTTP_USER_AGENT;
use aster_forge_external_auth::providers::microsoft::normalize_microsoft_tenant_input;
use aster_forge_utils::numbers::u64_to_i64;
use reqwest::Url;

use super::normalize::{
    binding_callback_redirect_uri, normalize_key, normalize_return_path, state_hash,
};
use super::providers::external_auth_provider_config;
use super::{
    ExternalAuthCallbackQuery, ExternalAuthStartLoginResponse, FLOW_TTL_SECS,
    MICROSOFT_PROVIDER_PUBLIC_KEY, provider_key_matches, public_provider_key,
};
use crate::types::yggdrasil::{MinecraftTextureModel, MinecraftTextureType};

const MICROSOFT_LOGIN_BASE: &str = "https://login.microsoftonline.com";
// HMCL 使用的旧 Live SDK 端点
const LIVE_TOKEN_URL: &str = "https://login.live.com/oauth20_token.srf";
// Microsoft 设备代码流端点，固定使用 consumers tenant。
const DEVICE_CODE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const DEVICE_TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

const MICROSOFT_MINECRAFT_SCOPES: &str = "XboxLive.signin offline_access";
const MINECRAFT_IDENTITY_NAMESPACE: &str = "https://api.minecraftservices.com/minecraft/profile";
const XBOX_LIVE_AUTH_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_AUTHORIZE_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MINECRAFT_LOGIN_WITH_XBOX_URL: &str =
    "https://api.minecraftservices.com/authentication/login_with_xbox";
const MINECRAFT_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";
const BINDING_HTTP_TIMEOUT_SECS: u64 = 10;
const ERROR_RESPONSE_LOG_BODY_CHARS: usize = 2048;

pub struct ExternalAuthMinecraftBindingCallbackResult {
    pub user_id: i64,
    pub provider_id: i64,
    pub identity_id: i64,
    pub profile: crate::entities::minecraft_profile::Model,
    pub identity_linked: bool,
    pub profile_created: bool,
    pub return_path: String,
}

#[derive(Debug, Clone)]
struct MicrosoftMinecraftAccount {
    uuid: String,
    name: String,
    xbox_user_hash: Option<String>,
    official_textures: OfficialMinecraftTextures,
}

#[derive(Debug, Clone, Default)]
struct OfficialMinecraftTextures {
    skin: Option<OfficialMinecraftTexture>,
    cape: Option<OfficialMinecraftTexture>,
}

#[derive(Debug, Clone)]
struct OfficialMinecraftTexture {
    url: String,
    texture_model: MinecraftTextureModel,
}

struct MicrosoftOAuthEndpoints {
    token_url: String,
}

struct MinecraftServicesEndpoints {
    xbox_live_auth_url: String,
    xsts_authorize_url: String,
    minecraft_login_with_xbox_url: String,
    minecraft_profile_url: String,
}

pub async fn start_minecraft_binding(
    state: &impl SharedRuntimeState,
    _req: &actix_web::HttpRequest,
    user_id: i64,
    provider_kind: ExternalAuthProviderKind,
    provider_key: &str,
    return_path: Option<&str>,
) -> Result<ExternalAuthStartLoginResponse> {
    ensure_minecraft_binding_provider_kind(provider_kind)?;
    let provider = find_minecraft_binding_provider(state, provider_kind, provider_key).await?;
    ensure_provider_enabled(&provider)?;

    // 有客户端密钥时按服务端授权码流走固定回调；无密钥时按公共客户端设备码流绑定。
    if provider_has_client_secret(&provider) {
        start_authorization_code_binding_flow(state, _req, user_id, &provider, return_path).await
    } else {
        start_device_code_flow(state, user_id, &provider, return_path).await
    }
}

async fn find_minecraft_binding_provider(
    state: &impl SharedRuntimeState,
    provider_kind: ExternalAuthProviderKind,
    provider_key: &str,
) -> Result<external_auth_provider::Model> {
    let provider_key = normalize_key(provider_key)?;
    if let Some(provider) = external_auth_provider_repo::find_by_kind_key(
        state.writer_db(),
        provider_kind,
        &provider_key,
    )
    .await?
    {
        return Ok(provider);
    }

    if provider_kind == ExternalAuthProviderKind::Microsoft
        && provider_key == MICROSOFT_PROVIDER_PUBLIC_KEY
    {
        let providers =
            external_auth_provider_repo::find_enabled_by_kind(state.writer_db(), provider_kind)
                .await?;
        let mut providers = providers.into_iter();
        return match (providers.next(), providers.next()) {
            (Some(provider), None) => Ok(provider),
            (None, _) => Err(AsterError::record_not_found(format!(
                "external auth provider '{}:{provider_key}'",
                provider_kind.as_str()
            ))),
            _ => Err(AsterError::validation_error_code(
                AsterErrorCode::ExternalAuthProviderMisconfigured,
                "multiple enabled Microsoft providers are configured; keep only one enabled Microsoft provider for the fixed callback URL",
            )),
        };
    }

    Err(AsterError::record_not_found(format!(
        "external auth provider '{}:{provider_key}'",
        provider_kind.as_str()
    )))
}

fn provider_has_client_secret(provider: &external_auth_provider::Model) -> bool {
    provider
        .client_secret
        .as_deref()
        .is_some_and(|secret| !secret.trim().is_empty())
}

async fn start_authorization_code_binding_flow(
    state: &impl SharedRuntimeState,
    req: &actix_web::HttpRequest,
    user_id: i64,
    provider: &external_auth_provider::Model,
    return_path: Option<&str>,
) -> Result<ExternalAuthStartLoginResponse> {
    let return_path = normalize_return_path(return_path)?;
    let redirect_provider_key = public_provider_key(provider.provider_kind, &provider.key);
    let redirect_uri =
        binding_callback_redirect_uri(state, req, provider.provider_kind, redirect_provider_key)?;
    let mut provider_config = external_auth_provider_config(provider);
    provider_config.scopes = MICROSOFT_MINECRAFT_SCOPES.to_string();
    let auth_start = registry::default_registry()
        .get_driver(provider.provider_kind)?
        .start_authorization(&provider_config, &redirect_uri)
        .await
        .map_external_auth()?;

    let now = Utc::now();
    let ttl = u64_to_i64(FLOW_TTL_SECS, "external auth binding flow ttl")?;
    let flow = external_auth_binding_flow::ActiveModel {
        user_id: Set(user_id),
        provider_id: Set(provider.id),
        state_hash: Set(state_hash(&auth_start.state)),
        nonce: Set(auth_start.nonce),
        pkce_verifier: Set(auth_start.pkce_verifier),
        redirect_uri: Set(redirect_uri),
        return_path: Set(Some(return_path)),
        created_at: Set(now),
        expires_at: Set(now + Duration::seconds(ttl)),
        consumed_at: Set(None),
        ..Default::default()
    };
    external_auth_binding_flow_repo::create(state.writer_db(), flow).await?;

    Ok(ExternalAuthStartLoginResponse {
        authorization_url: auth_start.authorization_url,
        device_code: None,
        user_code: None,
        verification_uri: None,
        expires_in: None,
        interval: None,
    })
}

async fn start_device_code_flow(
    state: &impl SharedRuntimeState,
    user_id: i64,
    provider: &external_auth_provider::Model,
    return_path: Option<&str>,
) -> Result<ExternalAuthStartLoginResponse> {
    let return_path = normalize_return_path(return_path)?;
    let http_client = reqwest::Client::builder()
        .user_agent(OUTBOUND_HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(BINDING_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|error| AsterError::internal_error(format!("build HTTP client: {error}")))?;
    let device_code_url = microsoft_device_code_url(provider)?;

    // 请求设备代码
    let response = http_client
        .post(device_code_url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_urlencoded_body(&[
            ("client_id", provider.client_id.clone()),
            ("scope", MICROSOFT_MINECRAFT_SCOPES.to_string()),
        ]))
        .send()
        .await
        .map_err(|error| {
            AsterError::auth_invalid_credentials(format!("Device code request failed: {error}"))
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        tracing::warn!(status = %status, body = %body, "Device code request failed");
        return Err(AsterError::auth_invalid_credentials(
            "Device code request failed",
        ));
    }

    let device_code_response: serde_json::Value = serde_json::from_str(&body).map_err(|error| {
        AsterError::auth_invalid_credentials(format!("Device code response parse failed: {error}"))
    })?;

    let device_code = device_code_response["device_code"]
        .as_str()
        .ok_or_else(|| AsterError::auth_invalid_credentials("Missing device_code in response"))?;
    let user_code = device_code_response["user_code"]
        .as_str()
        .ok_or_else(|| AsterError::auth_invalid_credentials("Missing user_code in response"))?;
    let verification_uri = device_code_response["verification_uri"]
        .as_str()
        .ok_or_else(|| {
            AsterError::auth_invalid_credentials("Missing verification_uri in response")
        })?;
    let expires_in = device_code_response["expires_in"].as_u64().unwrap_or(900);
    let interval = device_code_response["interval"].as_u64().unwrap_or(5);

    // 保存设备代码流信息到数据库
    let now = Utc::now();
    let ttl_secs = expires_in.clamp(1, 900);
    let ttl = u64_to_i64(ttl_secs, "external auth device code flow ttl")?;
    let flow = external_auth_binding_flow::ActiveModel {
        user_id: Set(user_id),
        provider_id: Set(provider.id),
        state_hash: Set(state_hash(device_code)),
        nonce: Set(None),
        pkce_verifier: Set(None),
        redirect_uri: Set(verification_uri.to_string()),
        return_path: Set(Some(return_path)),
        created_at: Set(now),
        expires_at: Set(now + Duration::seconds(ttl)),
        consumed_at: Set(None),
        ..Default::default()
    };
    external_auth_binding_flow_repo::create(state.writer_db(), flow).await?;

    tracing::info!(
        user_code = %user_code,
        verification_uri = %verification_uri,
        expires_in = expires_in,
        "Device code flow started"
    );

    // 返回设备代码流信息，前端需要显示给用户
    Ok(ExternalAuthStartLoginResponse {
        authorization_url: verification_uri.to_string(),
        device_code: Some(device_code.to_string()),
        user_code: Some(user_code.to_string()),
        verification_uri: Some(verification_uri.to_string()),
        expires_in: Some(expires_in),
        interval: Some(interval),
    })
}

pub async fn finish_minecraft_binding_callback(
    state: &impl SharedRuntimeState,
    provider_kind: ExternalAuthProviderKind,
    provider_key: Option<&str>,
    query: &ExternalAuthCallbackQuery,
) -> Result<ExternalAuthMinecraftBindingCallbackResult> {
    ensure_minecraft_binding_provider_kind(provider_kind)?;
    if let Some(error) = query.error.as_deref() {
        let description = query
            .error_description
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(error);
        return Err(AsterError::auth_invalid_credentials(format!(
            "external auth provider returned error: {description}"
        )));
    }
    let code = query.code.as_deref().ok_or_else(|| {
        AsterError::auth_invalid_credentials("external auth binding callback missing code")
    })?;
    let state_value = query.state.as_deref().ok_or_else(|| {
        AsterError::auth_invalid_credentials("external auth binding callback missing state")
    })?;

    let flow = external_auth_binding_flow_repo::consume_by_state_hash(
        state.writer_db(),
        &state_hash(state_value),
        Utc::now(),
    )
    .await?
    .ok_or_else(|| {
        AsterError::auth_invalid_credentials("external auth binding state is invalid or expired")
    })?;
    let provider =
        external_auth_provider_repo::find_by_id(state.writer_db(), flow.provider_id).await?;
    if provider.provider_kind != provider_kind {
        return Err(AsterError::auth_invalid_credentials(
            "external auth binding callback provider kind does not match flow",
        ));
    }
    if let Some(provider_key) = provider_key {
        let expected_key = normalize_key(provider_key)?;
        if !provider_key_matches(provider.provider_kind, &provider.key, &expected_key) {
            return Err(AsterError::auth_invalid_credentials(
                "external auth binding callback provider does not match flow",
            ));
        }
    }
    ensure_provider_enabled(&provider)?;

    let account = exchange_microsoft_minecraft_account(
        &provider,
        code,
        &flow.redirect_uri,
        flow.pkce_verifier.as_deref(),
    )
    .await?;
    let applied = apply_minecraft_binding(
        state,
        &provider,
        flow.user_id,
        user_role_for_binding(state, flow.user_id).await?,
        &account,
    )
    .await?;
    sync_official_minecraft_textures(state, &applied.profile, &account).await;

    Ok(ExternalAuthMinecraftBindingCallbackResult {
        user_id: flow.user_id,
        provider_id: provider.id,
        identity_id: applied.identity.id,
        profile: applied.profile,
        identity_linked: applied.identity_linked,
        profile_created: applied.profile_created,
        return_path: flow.return_path.unwrap_or_else(|| "/account".to_string()),
    })
}

pub async fn check_device_code_status(
    state: &impl SharedRuntimeState,
    user_id: i64,
    device_code: &str,
) -> Result<Option<ExternalAuthMinecraftBindingCallbackResult>> {
    let now = Utc::now();
    let flow = external_auth_binding_flow_repo::find_active_by_state_hash(
        state.writer_db(),
        &state_hash(device_code),
        now,
    )
    .await?;

    let flow = match flow {
        Some(f) => f,
        None => return Ok(None),
    };

    if flow.user_id != user_id {
        return Err(AsterError::auth_forbidden_code(
            AsterErrorCode::ExternalAuthIdentityConflict,
            "Device code flow does not belong to this user",
        ));
    }

    let provider =
        external_auth_provider_repo::find_by_id(state.writer_db(), flow.provider_id).await?;

    let http_client = reqwest::Client::builder()
        .user_agent(OUTBOUND_HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(BINDING_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|error| AsterError::internal_error(format!("build HTTP client: {error}")))?;

    let token_url = microsoft_device_token_url(&provider)?;
    let token_status =
        poll_device_code_token(&http_client, &token_url, &provider.client_id, device_code).await?;
    let access_token = match token_status {
        DeviceCodeTokenStatus::Pending => return Ok(None),
        DeviceCodeTokenStatus::SlowDown => return Ok(None),
        DeviceCodeTokenStatus::Expired => {
            let consumed = external_auth_binding_flow_repo::consume_by_id(
                state.writer_db(),
                flow.id,
                Utc::now(),
            )
            .await?;
            tracing::debug!(
                flow_id = flow.id,
                consumed,
                "Microsoft device code flow expired"
            );
            return Err(AsterError::auth_invalid_credentials(
                "Microsoft device code has expired",
            ));
        }
        DeviceCodeTokenStatus::Authorized { access_token } => access_token,
    };

    if !external_auth_binding_flow_repo::consume_by_id(state.writer_db(), flow.id, Utc::now())
        .await?
    {
        return Ok(None);
    }

    // 使用 access_token 完成 Minecraft 绑定
    let account =
        exchange_microsoft_minecraft_account_with_token(&http_client, &provider, &access_token)
            .await?;

    let applied = apply_minecraft_binding(
        state,
        &provider,
        flow.user_id,
        user_role_for_binding(state, flow.user_id).await?,
        &account,
    )
    .await?;
    sync_official_minecraft_textures(state, &applied.profile, &account).await;

    Ok(Some(ExternalAuthMinecraftBindingCallbackResult {
        user_id: flow.user_id,
        provider_id: provider.id,
        identity_id: applied.identity.id,
        profile: applied.profile,
        identity_linked: applied.identity_linked,
        profile_created: applied.profile_created,
        return_path: flow.return_path.unwrap_or_else(|| "/account".to_string()),
    }))
}

enum DeviceCodeTokenStatus {
    Authorized { access_token: String },
    Pending,
    SlowDown,
    Expired,
}

#[derive(Deserialize)]
struct DeviceCodeTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn poll_device_code_token(
    http_client: &reqwest::Client,
    token_url: &str,
    client_id: &str,
    device_code: &str,
) -> Result<DeviceCodeTokenStatus> {
    let response = http_client
        .post(token_url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_urlencoded_body(&[
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
            ("device_code", device_code.to_string()),
            ("client_id", client_id.to_string()),
        ]))
        .send()
        .await
        .map_err(|error| {
            AsterError::auth_invalid_credentials(format!(
                "Device code token request failed: {error}"
            ))
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let token_response: DeviceCodeTokenResponse = serde_json::from_str(&body).map_err(|error| {
        AsterError::auth_invalid_credentials(format!("Token response parse failed: {error}"))
    })?;

    if let Some(error) = token_response.error.as_deref() {
        return match error {
            "authorization_pending" => Ok(DeviceCodeTokenStatus::Pending),
            "slow_down" => Ok(DeviceCodeTokenStatus::SlowDown),
            "expired_token" => Ok(DeviceCodeTokenStatus::Expired),
            _ => {
                let description = token_response
                    .error_description
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(error);
                tracing::warn!(
                    status = %status,
                    error,
                    error_description = %description,
                    "Device code token request returned error"
                );
                Err(AsterError::auth_invalid_credentials(format!(
                    "Microsoft device code token request failed: {description}"
                )))
            }
        };
    }

    if !status.is_success() {
        tracing::warn!(status = %status, body = %body, "Device code token request failed");
        return Err(AsterError::auth_invalid_credentials(
            "Device code token request failed",
        ));
    }

    let access_token = token_response
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AsterError::auth_invalid_credentials("Missing access_token in response"))?;
    Ok(DeviceCodeTokenStatus::Authorized { access_token })
}

async fn exchange_microsoft_minecraft_account_with_token(
    http_client: &reqwest::Client,
    provider: &external_auth_provider::Model,
    access_token: &str,
) -> Result<MicrosoftMinecraftAccount> {
    let endpoints = microsoft_oauth_endpoints(provider)?;
    let minecraft_endpoints = minecraft_services_endpoints(&endpoints.token_url)?;

    let xbox_live = authenticate_xbox_live(
        http_client,
        &minecraft_endpoints.xbox_live_auth_url,
        access_token,
    )
    .await?;
    tracing::info!(user_hash = %xbox_live.user_hash, "Xbox Live authentication successful");

    let xsts = authorize_xsts(
        http_client,
        &minecraft_endpoints.xsts_authorize_url,
        &xbox_live.token,
    )
    .await?;
    tracing::info!(user_hash = %xsts.user_hash, "XSTS authorization successful");

    let minecraft_token = login_minecraft_with_xbox(
        http_client,
        &minecraft_endpoints.minecraft_login_with_xbox_url,
        &xsts.user_hash,
        &xsts.token,
    )
    .await?;
    tracing::info!("Minecraft login successful");

    let profile = fetch_minecraft_profile(
        http_client,
        &minecraft_endpoints.minecraft_profile_url,
        &minecraft_token.access_token,
    )
    .await?;
    let official_textures = profile.official_textures();

    Ok(MicrosoftMinecraftAccount {
        uuid: normalize_minecraft_uuid(&profile.id)?,
        name: profile.name,
        xbox_user_hash: Some(xsts.user_hash),
        official_textures,
    })
}

fn ensure_minecraft_binding_provider_kind(provider_kind: ExternalAuthProviderKind) -> Result<()> {
    if provider_kind == ExternalAuthProviderKind::Microsoft {
        return Ok(());
    }
    Err(AsterError::validation_error_code(
        AsterErrorCode::ExternalAuthProviderMisconfigured,
        "Minecraft account binding requires a Microsoft external auth provider",
    ))
}

fn ensure_provider_enabled(provider: &external_auth_provider::Model) -> Result<()> {
    if provider.enabled {
        return Ok(());
    }
    Err(AsterError::auth_forbidden_code(
        AsterErrorCode::ExternalAuthProviderDisabled,
        "external auth provider is disabled",
    ))
}

fn microsoft_oauth_endpoints(
    provider: &external_auth_provider::Model,
) -> Result<MicrosoftOAuthEndpoints> {
    // 如果 provider 配置了自定义端点，保留 token_url 以便本地 mock 测试。
    let has_manual_authorization_url = provider
        .authorization_url
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let has_manual_token_url = provider
        .token_url
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if has_manual_authorization_url || has_manual_token_url {
        let token_url = provider
            .token_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(LIVE_TOKEN_URL);
        return Ok(MicrosoftOAuthEndpoints {
            token_url: token_url.to_string(),
        });
    }

    // 检查是否使用 legacy 模式（通过 options.microsoft.legacy 配置）
    let options = parse_external_auth_provider_options(provider.options.as_ref());
    let use_legacy = options
        .microsoft
        .as_ref()
        .and_then(|m| m.legacy)
        .unwrap_or(false);

    if use_legacy {
        // 使用 HMCL 的旧端点
        tracing::info!("Using legacy Live SDK endpoints for Microsoft authentication");
        return Ok(MicrosoftOAuthEndpoints {
            token_url: LIVE_TOKEN_URL.to_string(),
        });
    }

    // 默认使用新的 v2.0 端点
    let token_url = microsoft_oauth_endpoint_from_provider(provider, "token")?;
    parse_http_url(&token_url, "Microsoft token_url")?;
    Ok(MicrosoftOAuthEndpoints { token_url })
}

fn microsoft_device_code_url(provider: &external_auth_provider::Model) -> Result<String> {
    let endpoints = microsoft_oauth_endpoints(provider)?;
    let token_url = parse_http_url(&endpoints.token_url, "Microsoft token_url")?;
    if token_url.host_str().is_some_and(is_loopback_host) {
        return Ok(format!("{}/devicecode", url_origin(&token_url)));
    }
    Ok(DEVICE_CODE_URL.to_string())
}

fn microsoft_device_token_url(provider: &external_auth_provider::Model) -> Result<String> {
    let endpoints = microsoft_oauth_endpoints(provider)?;
    let token_url = parse_http_url(&endpoints.token_url, "Microsoft token_url")?;
    if token_url.host_str().is_some_and(is_loopback_host) {
        return Ok(endpoints.token_url);
    }
    Ok(DEVICE_TOKEN_URL.to_string())
}

fn microsoft_oauth_endpoint_from_provider(
    provider: &external_auth_provider::Model,
    endpoint: &str,
) -> Result<String> {
    let tenant = microsoft_provider_tenant(provider)?;
    Ok(format!(
        "{MICROSOFT_LOGIN_BASE}/{tenant}/oauth2/v2.0/{endpoint}"
    ))
}

fn microsoft_provider_tenant(provider: &external_auth_provider::Model) -> Result<String> {
    let options = parse_external_auth_provider_options(provider.options.as_ref());
    if let Some(options) = options.microsoft.as_ref() {
        return normalize_microsoft_tenant_input(Some(options.tenant.clone())).map_external_auth();
    }
    if let Some(issuer_url) = provider
        .issuer_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        && let Ok(url) = Url::parse(issuer_url)
        && let Some(tenant) = tenant_from_issuer_url(&url)
    {
        return normalize_microsoft_tenant_input(Some(tenant)).map_external_auth();
    }
    normalize_microsoft_tenant_input(None).map_external_auth()
}

fn tenant_from_issuer_url(url: &Url) -> Option<String> {
    let segments = url.path_segments()?.collect::<Vec<_>>();
    if segments.len() == 2 && segments[1].eq_ignore_ascii_case("v2.0") && !segments[0].is_empty() {
        return Some(segments[0].to_string());
    }
    None
}

async fn exchange_microsoft_minecraft_account(
    provider: &external_auth_provider::Model,
    code: &str,
    redirect_uri: &str,
    pkce_verifier: Option<&str>,
) -> Result<MicrosoftMinecraftAccount> {
    let pkce_verifier = pkce_verifier.ok_or_else(|| {
        AsterError::internal_error("stored Microsoft binding PKCE verifier is missing")
    })?;
    let http_client = reqwest::Client::builder()
        .user_agent(OUTBOUND_HTTP_USER_AGENT)
        .timeout(std::time::Duration::from_secs(BINDING_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|error| AsterError::internal_error(format!("build HTTP client: {error}")))?;
    let endpoints = microsoft_oauth_endpoints(provider)?;
    let minecraft_endpoints = minecraft_services_endpoints(&endpoints.token_url)?;
    let microsoft_token = exchange_microsoft_code_for_token(
        &http_client,
        provider,
        &endpoints.token_url,
        code,
        redirect_uri,
        pkce_verifier,
    )
    .await?;
    tracing::info!("Microsoft token obtained successfully");

    let xbox_live = authenticate_xbox_live(
        &http_client,
        &minecraft_endpoints.xbox_live_auth_url,
        &microsoft_token.access_token,
    )
    .await?;
    tracing::info!(user_hash = %xbox_live.user_hash, "Xbox Live authentication successful");

    let xsts = authorize_xsts(
        &http_client,
        &minecraft_endpoints.xsts_authorize_url,
        &xbox_live.token,
    )
    .await?;
    tracing::info!(user_hash = %xsts.user_hash, "XSTS authorization successful");

    let minecraft_token = login_minecraft_with_xbox(
        &http_client,
        &minecraft_endpoints.minecraft_login_with_xbox_url,
        &xsts.user_hash,
        &xsts.token,
    )
    .await?;
    tracing::info!("Minecraft login successful");
    let profile = fetch_minecraft_profile(
        &http_client,
        &minecraft_endpoints.minecraft_profile_url,
        &minecraft_token.access_token,
    )
    .await?;
    let official_textures = profile.official_textures();
    Ok(MicrosoftMinecraftAccount {
        uuid: normalize_minecraft_uuid(&profile.id)?,
        name: profile.name,
        xbox_user_hash: Some(xsts.user_hash),
        official_textures,
    })
}

#[derive(Deserialize)]
struct MicrosoftOAuthTokenResponse {
    access_token: String,
}

async fn exchange_microsoft_code_for_token(
    http_client: &reqwest::Client,
    provider: &external_auth_provider::Model,
    token_url: &str,
    code: &str,
    redirect_uri: &str,
    pkce_verifier: &str,
) -> Result<MicrosoftOAuthTokenResponse> {
    // 检查是否使用 legacy 模式
    let options = parse_external_auth_provider_options(provider.options.as_ref());
    let use_legacy = options
        .microsoft
        .as_ref()
        .and_then(|m| m.legacy)
        .unwrap_or(false);

    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("client_id", provider.client_id.clone()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("code_verifier", pkce_verifier.to_string()),
    ];
    if let Some(client_secret) = provider
        .client_secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        // legacy 模式下不使用 client_secret
        if !use_legacy {
            form.push(("client_secret", client_secret.to_string()));
        }
    }
    let response = http_client
        .post(token_url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_urlencoded_body(&form))
        .send()
        .await
        .map_err(|error| {
            AsterError::auth_invalid_credentials(format!(
                "Microsoft token exchange failed: {error}"
            ))
        })?;
    parse_json_response(response, "Microsoft token exchange").await
}

fn form_urlencoded_body(fields: &[(&str, String)]) -> String {
    fields
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                urlencoding::encode(key),
                urlencoding::encode(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

#[derive(Serialize)]
struct XboxLiveAuthRequest<'a> {
    #[serde(rename = "Properties")]
    properties: XboxLiveAuthProperties<'a>,
    #[serde(rename = "RelyingParty")]
    relying_party: &'static str,
    #[serde(rename = "TokenType")]
    token_type: &'static str,
}

#[derive(Serialize)]
struct XboxLiveAuthProperties<'a> {
    #[serde(rename = "AuthMethod")]
    auth_method: &'static str,
    #[serde(rename = "SiteName")]
    site_name: &'static str,
    #[serde(rename = "RpsTicket")]
    rps_ticket: String,
    #[serde(skip)]
    _phantom: std::marker::PhantomData<&'a ()>,
}

#[derive(Serialize)]
struct XstsAuthorizeRequest<'a> {
    #[serde(rename = "Properties")]
    properties: XstsAuthorizeProperties<'a>,
    #[serde(rename = "RelyingParty")]
    relying_party: &'static str,
    #[serde(rename = "TokenType")]
    token_type: &'static str,
}

#[derive(Serialize)]
struct XstsAuthorizeProperties<'a> {
    #[serde(rename = "SandboxId")]
    sandbox_id: &'static str,
    #[serde(rename = "UserTokens")]
    user_tokens: Vec<&'a str>,
}

#[derive(Deserialize)]
struct XboxAuthResponse {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims")]
    display_claims: XboxDisplayClaims,
}

#[derive(Deserialize)]
struct XboxDisplayClaims {
    #[serde(default)]
    xui: Vec<XboxUserClaim>,
}

#[derive(Deserialize)]
struct XboxUserClaim {
    uhs: Option<String>,
}

struct XboxToken {
    token: String,
    user_hash: String,
}

async fn authenticate_xbox_live(
    http_client: &reqwest::Client,
    url: &str,
    microsoft_access_token: &str,
) -> Result<XboxToken> {
    let request = XboxLiveAuthRequest {
        properties: XboxLiveAuthProperties {
            auth_method: "RPS",
            site_name: "user.auth.xboxlive.com",
            rps_ticket: format!("d={microsoft_access_token}"),
            _phantom: std::marker::PhantomData,
        },
        relying_party: "http://auth.xboxlive.com",
        token_type: "JWT",
    };
    let response = http_client
        .post(url)
        .header("Accept", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            AsterError::auth_invalid_credentials(format!(
                "Xbox Live authentication failed: {error}"
            ))
        })?;
    let response: XboxAuthResponse =
        parse_json_response(response, "Xbox Live authentication").await?;
    Ok(XboxToken {
        user_hash: xbox_user_hash(&response)?,
        token: response.token,
    })
}

async fn authorize_xsts(
    http_client: &reqwest::Client,
    url: &str,
    xbox_token: &str,
) -> Result<XboxToken> {
    let request = XstsAuthorizeRequest {
        properties: XstsAuthorizeProperties {
            sandbox_id: "RETAIL",
            user_tokens: vec![xbox_token],
        },
        relying_party: "rp://api.minecraftservices.com/",
        token_type: "JWT",
    };
    let response = http_client
        .post(url)
        .header("Accept", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            AsterError::auth_invalid_credentials(format!("XSTS authorization failed: {error}"))
        })?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    // 参考 HMCL 和 PCL 的错误处理
    // XSTS 可能返回 401，但响应体中包含详细错误信息
    if status == 401 || status == 400 {
        tracing::warn!(status = %status, body = %body, "XSTS authorization returned error");
        // 检查特定错误码
        if body.contains("2148916227") {
            return Err(AsterError::auth_invalid_credentials(
                "Xbox account is banned",
            ));
        } else if body.contains("2148916233") {
            return Err(AsterError::auth_invalid_credentials(
                "Xbox account not found, please register first",
            ));
        } else if body.contains("2148916235") {
            return Err(AsterError::auth_invalid_credentials(
                "Xbox service is not available in your region",
            ));
        } else if body.contains("2148916238") {
            return Err(AsterError::auth_invalid_credentials(
                "Xbox account age restriction, please update your birth date",
            ));
        }
        return Err(AsterError::auth_invalid_credentials(format!(
            "XSTS authorization failed: {body}"
        )));
    }

    if !status.is_success() {
        tracing::warn!(status = %status, body = %body, "XSTS authorization failed");
        return Err(AsterError::auth_invalid_credentials(
            "XSTS authorization failed",
        ));
    }

    let response: XboxAuthResponse = serde_json::from_str(&body).map_err(|error| {
        AsterError::auth_invalid_credentials(format!("XSTS response parse failed: {error}"))
    })?;
    Ok(XboxToken {
        user_hash: xbox_user_hash(&response)?,
        token: response.token,
    })
}

fn xbox_user_hash(response: &XboxAuthResponse) -> Result<String> {
    response
        .display_claims
        .xui
        .iter()
        .find_map(|claim| claim.uhs.as_deref())
        .map(str::to_string)
        .ok_or_else(|| AsterError::auth_invalid_credentials("Xbox response missing user hash"))
}

#[derive(Serialize)]
struct MinecraftLoginWithXboxRequest<'a> {
    #[serde(rename = "identityToken")]
    identity_token: String,
    #[serde(skip)]
    _phantom: std::marker::PhantomData<&'a ()>,
}

#[derive(Deserialize)]
struct MinecraftLoginResponse {
    access_token: String,
}

async fn login_minecraft_with_xbox(
    http_client: &reqwest::Client,
    url: &str,
    user_hash: &str,
    xsts_token: &str,
) -> Result<MinecraftLoginResponse> {
    let request = MinecraftLoginWithXboxRequest {
        identity_token: format!("XBL3.0 x={user_hash};{xsts_token}"),
        _phantom: std::marker::PhantomData,
    };
    let response = http_client
        .post(url)
        .header("Accept", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            AsterError::auth_invalid_credentials(format!(
                "Minecraft Services login failed: {error}"
            ))
        })?;
    parse_json_response(response, "Minecraft Services login").await
}

#[derive(Deserialize)]
struct MinecraftProfileResponse {
    id: String,
    name: String,
    #[serde(default)]
    skins: Vec<MinecraftProfileSkinResponse>,
    #[serde(default)]
    capes: Vec<MinecraftProfileCapeResponse>,
}

#[derive(Deserialize)]
struct MinecraftProfileSkinResponse {
    state: Option<String>,
    url: Option<String>,
    variant: Option<String>,
}

#[derive(Deserialize)]
struct MinecraftProfileCapeResponse {
    state: Option<String>,
    url: Option<String>,
}

impl MinecraftProfileResponse {
    fn official_textures(&self) -> OfficialMinecraftTextures {
        OfficialMinecraftTextures {
            skin: self
                .skins
                .iter()
                .find_map(MinecraftProfileSkinResponse::active_texture),
            cape: self
                .capes
                .iter()
                .find_map(MinecraftProfileCapeResponse::active_texture),
        }
    }
}

impl MinecraftProfileSkinResponse {
    fn active_texture(&self) -> Option<OfficialMinecraftTexture> {
        if !is_active_minecraft_profile_texture(self.state.as_deref()) {
            return None;
        }
        let url = self.url.as_deref()?.trim();
        if url.is_empty() {
            return None;
        }
        let texture_model = match self.variant.as_deref().map(str::trim) {
            Some(value) if value.eq_ignore_ascii_case("SLIM") => MinecraftTextureModel::Slim,
            _ => MinecraftTextureModel::Default,
        };
        Some(OfficialMinecraftTexture {
            url: url.to_string(),
            texture_model,
        })
    }
}

impl MinecraftProfileCapeResponse {
    fn active_texture(&self) -> Option<OfficialMinecraftTexture> {
        if !is_active_minecraft_profile_texture(self.state.as_deref()) {
            return None;
        }
        let url = self.url.as_deref()?.trim();
        if url.is_empty() {
            return None;
        }
        Some(OfficialMinecraftTexture {
            url: url.to_string(),
            texture_model: MinecraftTextureModel::Default,
        })
    }
}

fn is_active_minecraft_profile_texture(state: Option<&str>) -> bool {
    state
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("ACTIVE"))
}

async fn fetch_minecraft_profile(
    http_client: &reqwest::Client,
    url: &str,
    minecraft_access_token: &str,
) -> Result<MinecraftProfileResponse> {
    let response = http_client
        .get(url)
        .header("Accept", "application/json")
        .bearer_auth(minecraft_access_token)
        .send()
        .await
        .map_err(|error| {
            AsterError::auth_invalid_credentials(format!("Minecraft profile fetch failed: {error}"))
        })?;
    parse_json_response(response, "Minecraft profile fetch").await
}

async fn parse_json_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    context: &str,
) -> Result<T> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body = truncate_log_body(&body, ERROR_RESPONSE_LOG_BODY_CHARS);
        tracing::warn!(
            status = %status,
            context,
            response_body = %body,
            "Microsoft Minecraft binding HTTP step failed"
        );
        return Err(AsterError::auth_invalid_credentials(format!(
            "{context} returned non-success status"
        )));
    }
    response.json::<T>().await.map_err(|error| {
        AsterError::auth_invalid_credentials(format!("{context} response parse failed: {error}"))
    })
}

fn truncate_log_body(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_none() {
        return truncated;
    }
    format!("{truncated}...<truncated>")
}

fn minecraft_services_endpoints(token_url: &str) -> Result<MinecraftServicesEndpoints> {
    let token_url = parse_http_url(token_url, "Microsoft token_url")?;
    if token_url.host_str().is_some_and(is_loopback_host) {
        let origin = url_origin(&token_url);
        return Ok(MinecraftServicesEndpoints {
            xbox_live_auth_url: format!("{origin}/user/authenticate"),
            xsts_authorize_url: format!("{origin}/xsts/authorize"),
            minecraft_login_with_xbox_url: format!("{origin}/authentication/login_with_xbox"),
            minecraft_profile_url: format!("{origin}/minecraft/profile"),
        });
    }
    Ok(MinecraftServicesEndpoints {
        xbox_live_auth_url: XBOX_LIVE_AUTH_URL.to_string(),
        xsts_authorize_url: XSTS_AUTHORIZE_URL.to_string(),
        minecraft_login_with_xbox_url: MINECRAFT_LOGIN_WITH_XBOX_URL.to_string(),
        minecraft_profile_url: MINECRAFT_PROFILE_URL.to_string(),
    })
}

fn parse_http_url(value: &str, field: &str) -> Result<Url> {
    let url = Url::parse(value)
        .map_err(|error| AsterError::validation_error(format!("invalid {field}: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AsterError::validation_error(format!(
            "{field} must use http or https"
        )));
    }
    Ok(url)
}

fn url_origin(url: &Url) -> String {
    let mut origin = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
    if let Some(port) = url.port() {
        origin.push(':');
        origin.push_str(&port.to_string());
    }
    origin
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host.eq_ignore_ascii_case("127.0.0.1")
        || host.eq_ignore_ascii_case("::1")
}

fn normalize_minecraft_uuid(value: &str) -> Result<String> {
    let uuid = uuid::Uuid::parse_str(value.trim()).map_err(|_| {
        AsterError::validation_error_code(
            AsterErrorCode::MinecraftProfileUuidInvalid,
            "Minecraft profile id is not a valid UUID",
        )
    })?;
    Ok(uuid.simple().to_string())
}

async fn sync_official_minecraft_textures(
    state: &impl SharedRuntimeState,
    profile: &crate::entities::minecraft_profile::Model,
    account: &MicrosoftMinecraftAccount,
) {
    if let Some(texture) = account.official_textures.skin.as_ref() {
        if let Err(error) = crate::services::texture_service::import_official_texture_to_profile(
            state,
            profile,
            MinecraftTextureType::Skin,
            texture.texture_model,
            &texture.url,
        )
        .await
        {
            tracing::warn!(
                error = ?error,
                profile_id = profile.id,
                profile_uuid = %profile.uuid,
                texture_type = MinecraftTextureType::Skin.as_str(),
                "failed to sync official Minecraft profile texture"
            );
        }
    }

    if let Some(texture) = account.official_textures.cape.as_ref() {
        if let Err(error) = crate::services::texture_service::import_official_texture_to_profile(
            state,
            profile,
            MinecraftTextureType::Cape,
            texture.texture_model,
            &texture.url,
        )
        .await
        {
            tracing::warn!(
                error = ?error,
                profile_id = profile.id,
                profile_uuid = %profile.uuid,
                texture_type = MinecraftTextureType::Cape.as_str(),
                "failed to sync official Minecraft profile texture"
            );
        }
    }
}

struct ApplyBindingResult {
    identity: external_auth_identity::Model,
    profile: crate::entities::minecraft_profile::Model,
    identity_linked: bool,
    profile_created: bool,
}

async fn user_role_for_binding(state: &impl SharedRuntimeState, user_id: i64) -> Result<UserRole> {
    let user = crate::db::repository::user_repo::find_by_id(state.reader_db(), user_id).await?;
    Ok(user.role)
}

async fn apply_minecraft_binding(
    state: &impl SharedRuntimeState,
    provider: &external_auth_provider::Model,
    user_id: i64,
    user_role: UserRole,
    account: &MicrosoftMinecraftAccount,
) -> Result<ApplyBindingResult> {
    crate::db::transaction::with_transaction(state.writer_db(), async |txn| {
        let now = Utc::now();
        let metadata = minecraft_binding_metadata(account);
        let (identity, identity_linked) =
            ensure_minecraft_identity(txn, user_id, provider, account, &metadata, now).await?;
        let (profile, profile_created) =
            ensure_minecraft_profile(txn, state, user_id, user_role, account).await?;
        Ok(ApplyBindingResult {
            identity,
            profile,
            identity_linked,
            profile_created,
        })
    })
    .await
}

async fn ensure_minecraft_identity<C: sea_orm::ConnectionTrait>(
    db: &C,
    user_id: i64,
    provider: &external_auth_provider::Model,
    account: &MicrosoftMinecraftAccount,
    metadata: &str,
    now: chrono::DateTime<Utc>,
) -> Result<(external_auth_identity::Model, bool)> {
    if let Some(identity) = external_auth_identity_repo::find_by_identity_namespace_subject(
        db,
        MINECRAFT_IDENTITY_NAMESPACE,
        &account.uuid,
    )
    .await?
    {
        if identity.user_id != user_id {
            return Err(AsterError::auth_forbidden_code(
                AsterErrorCode::ExternalAuthIdentityConflict,
                "Minecraft account is already linked to another user",
            ));
        }
        external_auth_identity_repo::touch_login(
            db,
            identity.id,
            None,
            Some(&account.name),
            Some(metadata),
            now,
        )
        .await?;
        return Ok((identity, false));
    }

    if let Some(identity) =
        external_auth_identity_repo::find_by_provider_for_user(db, provider.id, user_id).await?
    {
        return Err(AsterError::auth_forbidden_code(
            AsterErrorCode::ExternalAuthIdentityConflict,
            format!(
                "user already linked a different account for external auth provider #{}",
                identity.provider_id
            ),
        ));
    }

    let identity = external_auth_identity_repo::create_identity(
        db,
        external_auth_identity_repo::CreateExternalAuthIdentityInput {
            user_id,
            provider_id: provider.id,
            identity_namespace: MINECRAFT_IDENTITY_NAMESPACE,
            subject: &account.uuid,
            email_snapshot: None,
            display_name_snapshot: Some(&account.name),
            metadata: Some(metadata),
            now,
        },
    )
    .await?;
    Ok((identity, true))
}

async fn ensure_minecraft_profile<C: sea_orm::ConnectionTrait>(
    db: &C,
    state: &impl SharedRuntimeState,
    user_id: i64,
    user_role: UserRole,
    account: &MicrosoftMinecraftAccount,
) -> Result<(crate::entities::minecraft_profile::Model, bool)> {
    if let Some(existing) = minecraft_profile_repo::find_by_uuid(db, &account.uuid).await? {
        if existing.user_id != user_id {
            return Err(AsterError::validation_error_code(
                AsterErrorCode::MinecraftProfileUuidTaken,
                "Minecraft profile UUID is already bound to another user",
            ));
        }
        return Ok((existing, false));
    }

    let profile = crate::services::yggdrasil_service::create_profile_with_uuid_in_connection(
        state,
        db,
        user_id,
        user_role,
        &account.uuid,
        &account.name,
        crate::types::yggdrasil::MinecraftProfileSource::Microsoft,
    )
    .await?;
    Ok((profile, true))
}

fn minecraft_binding_metadata(account: &MicrosoftMinecraftAccount) -> String {
    serde_json::json!({
        "minecraft_uuid": account.uuid.as_str(),
        "minecraft_name": account.name.as_str(),
        "xbox_user_hash": account.xbox_user_hash.as_deref(),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::external_auth::{
        ExternalAuthProtocol, ExternalAuthProviderKind, StoredExternalAuthProviderOptions,
    };

    fn microsoft_provider(
        options: &str,
        issuer_url: Option<&str>,
    ) -> external_auth_provider::Model {
        let now = Utc::now();
        external_auth_provider::Model {
            id: 1,
            key: "microsoft".to_string(),
            display_name: "Microsoft".to_string(),
            icon_url: None,
            provider_kind: ExternalAuthProviderKind::Microsoft,
            protocol: ExternalAuthProtocol::Oidc,
            options: StoredExternalAuthProviderOptions(options.to_string()),
            issuer_url: issuer_url.map(str::to_string),
            authorization_url: None,
            token_url: None,
            userinfo_url: None,
            client_id: "client-id".to_string(),
            client_secret: None,
            scopes: "openid profile email".to_string(),
            enabled: true,
            auto_provision_enabled: false,
            auto_link_verified_email_enabled: false,
            require_email_verified: false,
            subject_claim: None,
            username_claim: None,
            display_name_claim: None,
            email_claim: None,
            email_verified_claim: None,
            groups_claim: None,
            avatar_url_claim: None,
            allowed_domains: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn microsoft_provider_tenant_prefers_options_over_legacy_issuer_url() {
        let provider = microsoft_provider(
            r#"{"microsoft":{"tenant":"consumers"}}"#,
            Some("https://login.microsoftonline.com/common/v2.0"),
        );

        let endpoint = microsoft_oauth_endpoint_from_provider(&provider, "authorize").unwrap();

        assert_eq!(
            endpoint,
            "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize"
        );
    }

    #[test]
    fn microsoft_provider_tenant_falls_back_to_legacy_issuer_url() {
        let provider = microsoft_provider(
            "{}",
            Some("https://login.microsoftonline.com/consumers/v2.0"),
        );

        let endpoint = microsoft_oauth_endpoint_from_provider(&provider, "token").unwrap();

        assert_eq!(
            endpoint,
            "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
        );
    }

    #[test]
    fn minecraft_profile_response_extracts_active_official_textures() {
        let profile: MinecraftProfileResponse = serde_json::from_str(
            r#"{
                "id": "069a79f444e94726a5befca90e38aaf5",
                "name": "Notch",
                "skins": [
                    {
                        "state": "INACTIVE",
                        "url": "https://textures.minecraft.net/texture/inactive",
                        "variant": "CLASSIC"
                    },
                    {
                        "state": "ACTIVE",
                        "url": "https://textures.minecraft.net/texture/skin",
                        "variant": "SLIM"
                    }
                ],
                "capes": [
                    {
                        "state": "ACTIVE",
                        "url": "https://textures.minecraft.net/texture/cape",
                        "alias": "vanilla"
                    }
                ]
            }"#,
        )
        .unwrap();

        let textures = profile.official_textures();

        let skin = textures.skin.unwrap();
        assert_eq!(skin.url, "https://textures.minecraft.net/texture/skin");
        assert_eq!(skin.texture_model, MinecraftTextureModel::Slim);

        let cape = textures.cape.unwrap();
        assert_eq!(cape.url, "https://textures.minecraft.net/texture/cape");
        assert_eq!(cape.texture_model, MinecraftTextureModel::Default);
    }
}
