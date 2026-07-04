use crate::api::dto::yggdrasil::YggdrasilProfile;
use crate::config::yggdrasil::RuntimeYggdrasilPolicy;
use crate::db::repository::{minecraft_profile_repo, user_repo, yggdrasil_token_repo};
use crate::entities::minecraft_profile;
use crate::errors::{AsterError, Result};
use crate::runtime::{
    CacheRuntimeState, DatabaseRuntimeState, ObjectStorageRuntimeState, RuntimeConfigRuntimeState,
};
use crate::services::{ban_service, texture_service};
use crate::types::user::UserBanScope;
use crate::types::yggdrasil::MinecraftProfileSource;
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct DeleteMinecraftProfileResult {
    pub profile: minecraft_profile::Model,
    pub deleted_texture_count: usize,
    pub revoked_token_count: u64,
}

#[derive(Debug, Clone)]
pub struct RenameMinecraftProfileResult {
    pub profile: minecraft_profile::Model,
    pub old_name: String,
    pub temporarily_invalidated_token_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(all(debug_assertions, feature = "openapi"), derive(utoipa::ToSchema))]
pub struct MinecraftProfileInfo {
    pub id: i64,
    pub user_id: i64,
    pub uuid: String,
    pub name: String,
    pub source: MinecraftProfileSource,
    pub uploadable_textures: String,
    pub texture_model: crate::types::yggdrasil::MinecraftTextureModel,
    #[cfg_attr(all(debug_assertions, feature = "openapi"), schema(value_type = String))]
    pub created_at: chrono::DateTime<chrono::Utc>,
    #[cfg_attr(all(debug_assertions, feature = "openapi"), schema(value_type = String))]
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

pub fn profile_summary(profile: &minecraft_profile::Model) -> YggdrasilProfile {
    YggdrasilProfile {
        id: profile.uuid.clone(),
        name: profile.name.clone(),
        source: None,
        properties: None,
    }
}

pub fn project_profile_summary(profile: &minecraft_profile::Model) -> YggdrasilProfile {
    YggdrasilProfile {
        id: profile.uuid.clone(),
        name: profile.name.clone(),
        source: Some(profile.source),
        properties: None,
    }
}

pub fn profile_info(profile: &minecraft_profile::Model) -> MinecraftProfileInfo {
    MinecraftProfileInfo {
        id: profile.id,
        user_id: profile.user_id,
        uuid: profile.uuid.clone(),
        name: profile.name.clone(),
        source: profile.source,
        uploadable_textures: profile.uploadable_textures.clone(),
        texture_model: profile.texture_model,
        created_at: profile.created_at,
        updated_at: profile.updated_at,
    }
}

pub async fn create_profile<S>(
    state: &S,
    user_id: i64,
    user_role: crate::types::user::UserRole,
    name: &str,
) -> Result<minecraft_profile::Model>
where
    S: DatabaseRuntimeState + RuntimeConfigRuntimeState,
{
    create_profile_inner(state, user_id, user_role, name, false).await
}

pub async fn create_profile_with_uuid_in_connection<S, C>(
    state: &S,
    db: &C,
    user_id: i64,
    user_role: crate::types::user::UserRole,
    uuid: &str,
    name: &str,
    source: MinecraftProfileSource,
) -> Result<minecraft_profile::Model>
where
    S: DatabaseRuntimeState + RuntimeConfigRuntimeState,
    C: sea_orm::ConnectionTrait,
{
    create_profile_with_uuid_in_connection_inner(
        state,
        db,
        CreateProfileInput {
            user_id,
            user_role,
            uuid,
            name,
            source,
            allow_reserved_linuxdo_name: false,
            check_mojang_name: false,
        },
    )
    .await
}

struct CreateProfileInput<'a> {
    user_id: i64,
    user_role: crate::types::user::UserRole,
    uuid: &'a str,
    name: &'a str,
    source: MinecraftProfileSource,
    allow_reserved_linuxdo_name: bool,
    check_mojang_name: bool,
}

async fn create_profile_inner<S>(
    state: &S,
    user_id: i64,
    user_role: crate::types::user::UserRole,
    name: &str,
    allow_reserved_linuxdo_name: bool,
) -> Result<minecraft_profile::Model>
where
    S: DatabaseRuntimeState + RuntimeConfigRuntimeState,
{
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    create_profile_with_uuid_in_connection_inner(
        state,
        state.writer_db(),
        CreateProfileInput {
            user_id,
            user_role,
            uuid: &uuid,
            name,
            source: MinecraftProfileSource::Local,
            allow_reserved_linuxdo_name,
            check_mojang_name: true,
        },
    )
    .await
}

async fn create_profile_with_uuid_in_connection_inner<S, C>(
    state: &S,
    db: &C,
    input: CreateProfileInput<'_>,
) -> Result<minecraft_profile::Model>
where
    S: DatabaseRuntimeState + RuntimeConfigRuntimeState,
    C: sea_orm::ConnectionTrait,
{
    let CreateProfileInput {
        user_id,
        user_role,
        uuid,
        name,
        source,
        allow_reserved_linuxdo_name,
        check_mojang_name,
    } = input;
    tracing::debug!(user_id, name_len = name.len(), "creating minecraft profile");
    ensure_profile_creation_not_banned(db, user_id).await?;
    let policy = RuntimeYggdrasilPolicy::from_runtime_config(state.runtime_config());
    if !user_role.is_admin() {
        let existing_count = minecraft_profile_repo::count_by_user(db, user_id).await?;
        if existing_count >= policy.max_profiles_per_user {
            tracing::debug!(
                user_id,
                existing_count,
                max = policy.max_profiles_per_user,
                "minecraft profile creation rejected because user reached profile limit"
            );
            return Err(AsterError::validation_error_code(
                crate::api::error_code::AsterErrorCode::MinecraftProfileLimitExceeded,
                "profile limit reached for this user",
            ));
        }
    }
    validate_profile_name(name)?;
    validate_reserved_profile_name(name, allow_reserved_linuxdo_name)?;
    if source == MinecraftProfileSource::Local && check_mojang_name {
        ensure_name_not_reserved_by_mojang(state, name).await?;
    }
    if minecraft_profile_repo::find_by_uuid(db, uuid)
        .await?
        .is_some()
    {
        tracing::debug!(
            user_id,
            profile_uuid = %uuid,
            "minecraft profile creation rejected because uuid is taken"
        );
        return Err(AsterError::validation_error_code(
            crate::api::error_code::AsterErrorCode::MinecraftProfileUuidTaken,
            "profile uuid already exists",
        ));
    }
    if profile_name_taken(db, name, user_id, None).await? {
        tracing::debug!(
            user_id,
            profile_name = name,
            "minecraft profile creation rejected because name is taken"
        );
        return Err(AsterError::validation_error_code(
            crate::api::error_code::AsterErrorCode::MinecraftProfileNameTaken,
            "profile name already exists",
        ));
    }
    let policy = RuntimeYggdrasilPolicy::from_runtime_config(state.runtime_config());
    let profile = minecraft_profile_repo::create_with_source(
        db,
        user_id,
        uuid,
        name,
        source,
        crate::types::yggdrasil::MinecraftTextureModel::Default,
        &policy.uploadable_textures_value(),
    )
    .await?;
    tracing::debug!(
        user_id,
        profile_id = profile.id,
        profile_uuid = %profile.uuid,
        uploadable_textures = %profile.uploadable_textures,
        "created minecraft profile"
    );
    Ok(profile)
}

async fn ensure_profile_creation_not_banned<C: sea_orm::ConnectionTrait>(
    db: &C,
    user_id: i64,
) -> Result<()> {
    let scope = UserBanScope::MinecraftProfileManage;
    if let Some(ban) = crate::db::repository::user_ban_repo::find_effective_for_scope(
        db,
        user_id,
        scope,
        chrono::Utc::now(),
    )
    .await?
    {
        tracing::debug!(
            user_id,
            ban_id = ban.id,
            scope = scope.as_str(),
            "minecraft profile creation rejected by active user capability ban"
        );
        return Err(AsterError::auth_forbidden_code(
            crate::api::error_code::AsterErrorCode::UserBanForbidden,
            format!("user is banned from {}", scope.as_str()),
        ));
    }
    Ok(())
}

async fn ensure_name_not_reserved_by_mojang<S>(state: &S, name: &str) -> Result<()>
where
    S: RuntimeConfigRuntimeState,
{
    let policy = RuntimeYggdrasilPolicy::from_runtime_config(state.runtime_config());
    if !policy.mojang_name_check_enabled {
        return Ok(());
    }
    match super::mojang::lookup_profile_name(state, name).await? {
        super::mojang::MojangProfileNameLookup::NotFound => Ok(()),
        super::mojang::MojangProfileNameLookup::Found(profile) => {
            tracing::debug!(
                profile_name = %name,
                mojang_profile_name = %profile.name,
                mojang_profile_uuid = %profile.uuid,
                "minecraft profile creation rejected because name exists on Mojang"
            );
            Err(AsterError::validation_error_code(
                crate::api::error_code::AsterErrorCode::MinecraftProfileNameReservedByMojang,
                "profile name is already used by an official Minecraft account",
            ))
        }
    }
}

pub async fn delete_profile_for_user<S>(
    state: &S,
    user_id: i64,
    uuid: &str,
) -> Result<Option<DeleteMinecraftProfileResult>>
where
    S: CacheRuntimeState + DatabaseRuntimeState + ObjectStorageRuntimeState,
{
    tracing::debug!(
        user_id,
        profile_uuid = uuid,
        "deleting minecraft profile for user"
    );
    ban_service::ensure_user_not_banned(state, user_id, UserBanScope::MinecraftProfileManage)
        .await?;
    let Some(profile) =
        minecraft_profile_repo::find_by_uuid_for_user(state.reader_db(), uuid, user_id).await?
    else {
        tracing::debug!(
            user_id,
            profile_uuid = uuid,
            "minecraft profile delete skipped because profile was not found"
        );
        return Ok(None);
    };
    if profile.source == MinecraftProfileSource::Microsoft {
        tracing::debug!(
            user_id,
            profile_id = profile.id,
            profile_uuid = %profile.uuid,
            "minecraft profile delete rejected because official Microsoft profiles are read-only"
        );
        return Err(AsterError::auth_forbidden_code(
            crate::api::error_code::AsterErrorCode::MinecraftProfileDeleteForbidden,
            "official Minecraft profile cannot be deleted on this site",
        ));
    }

    super::token::invalidate_token_cache_for_selected_profile(state, profile.id).await?;
    let deleted_textures = texture_service::delete_all_textures_for_profile(state, &profile)
        .await
        .map_err(|error| AsterError::internal_error(error.protocol_message()))?;
    let revoked_token_count =
        yggdrasil_token_repo::revoke_all_for_selected_profile(state.writer_db(), profile.id)
            .await?;
    let deleted_profile = minecraft_profile_repo::delete_by_id(state.writer_db(), profile.id)
        .await?
        .unwrap_or_else(|| profile.clone());

    tracing::debug!(
        user_id,
        profile_id = deleted_profile.id,
        profile_uuid = %deleted_profile.uuid,
        deleted_texture_count = deleted_textures.len(),
        revoked_token_count,
        "deleted minecraft profile"
    );
    Ok(Some(DeleteMinecraftProfileResult {
        profile: deleted_profile,
        deleted_texture_count: deleted_textures.len(),
        revoked_token_count,
    }))
}

pub async fn rename_profile_for_user<S>(
    state: &S,
    user_id: i64,
    uuid: &str,
    new_name: &str,
) -> Result<Option<RenameMinecraftProfileResult>>
where
    S: CacheRuntimeState + DatabaseRuntimeState + RuntimeConfigRuntimeState,
{
    tracing::debug!(
        user_id,
        profile_uuid = uuid,
        new_name_len = new_name.len(),
        "renaming minecraft profile for user"
    );
    ban_service::ensure_user_not_banned(state, user_id, UserBanScope::MinecraftProfileManage)
        .await?;
    validate_profile_name(new_name)?;
    validate_reserved_profile_name(new_name, false)?;
    let Some(profile) =
        minecraft_profile_repo::find_by_uuid_for_user(state.reader_db(), uuid, user_id).await?
    else {
        tracing::debug!(
            user_id,
            profile_uuid = uuid,
            "minecraft profile rename skipped because profile was not found"
        );
        return Ok(None);
    };
    rename_profile(state, profile, new_name).await.map(Some)
}

pub async fn rename_profile<S>(
    state: &S,
    profile: minecraft_profile::Model,
    new_name: &str,
) -> Result<RenameMinecraftProfileResult>
where
    S: CacheRuntimeState + DatabaseRuntimeState + RuntimeConfigRuntimeState,
{
    validate_profile_name(new_name)?;
    validate_reserved_profile_name(new_name, false)?;
    if profile.name == new_name {
        tracing::debug!(
            profile_id = profile.id,
            profile_uuid = %profile.uuid,
            "minecraft profile rename no-op because name is unchanged"
        );
        return Ok(RenameMinecraftProfileResult {
            old_name: profile.name.clone(),
            profile,
            temporarily_invalidated_token_count: 0,
        });
    }
    if profile.source == MinecraftProfileSource::Microsoft {
        tracing::debug!(
            profile_id = profile.id,
            profile_uuid = %profile.uuid,
            "minecraft profile rename rejected because official Microsoft profile names are read-only"
        );
        return Err(AsterError::validation_error_code(
            crate::api::error_code::AsterErrorCode::MinecraftProfileOfficialNameReadonly,
            "official Minecraft profile name cannot be changed on this site",
        ));
    }
    let policy = RuntimeYggdrasilPolicy::from_runtime_config(state.runtime_config());
    if u64::try_from(profile.rename_count).unwrap_or(0) >= policy.max_profile_renames {
        tracing::debug!(
            profile_id = profile.id,
            profile_uuid = %profile.uuid,
            rename_count = profile.rename_count,
            max = policy.max_profile_renames,
            "minecraft profile rename rejected because rename limit reached"
        );
        return Err(AsterError::validation_error_code(
            crate::api::error_code::AsterErrorCode::MinecraftProfileRenameLimitExceeded,
            "profile rename limit reached",
        ));
    }

    if profile_name_taken(
        state.reader_db(),
        new_name,
        profile.user_id,
        Some(profile.id),
    )
    .await?
    {
        tracing::debug!(
            profile_id = profile.id,
            profile_uuid = %profile.uuid,
            new_profile_name = new_name,
            "minecraft profile rename rejected because name is taken"
        );
        return Err(AsterError::validation_error_code(
            crate::api::error_code::AsterErrorCode::MinecraftProfileNameTaken,
            "profile name already exists",
        ));
    }

    let old_name = profile.name.clone();
    let token_hashes =
        super::token::invalidate_token_cache_for_selected_profile(state, profile.id).await?;
    let result = crate::db::transaction::with_transaction(state.writer_db(), async |txn| {
        let updated = minecraft_profile_repo::update_name_by_id(txn, profile.id, new_name)
            .await?
            .ok_or_else(|| {
                AsterError::record_not_found(format!("minecraft profile '{}'", profile.uuid))
            })?;
        let temporarily_invalidated_token_count =
            yggdrasil_token_repo::temporarily_invalidate_all_for_selected_profile(txn, profile.id)
                .await?;
        Ok(RenameMinecraftProfileResult {
            profile: updated,
            old_name,
            temporarily_invalidated_token_count,
        })
    })
    .await?;
    // Clear the same cache entries again after commit so tokens repopulated
    // during the rename transaction observe the temporary invalidation state.
    super::token::invalidate_token_cache_hashes(state, &token_hashes).await;
    crate::services::yggdrasil_service::invalidate_profile_name_summary_cache(
        state,
        &result.old_name,
    )
    .await;
    crate::services::yggdrasil_service::invalidate_profile_name_summary_cache(
        state,
        &result.profile.name,
    )
    .await;
    Ok(result)
}

pub fn validate_profile_name(name: &str) -> Result<()> {
    let valid_len = (3..=16).contains(&name.len());
    let valid_chars = name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    if !valid_len || !valid_chars {
        return Err(AsterError::validation_error(
            "profile name must be 3-16 ASCII letters, numbers, or underscores",
        ));
    }
    Ok(())
}

fn validate_reserved_profile_name(name: &str, allow_reserved_linuxdo_name: bool) -> Result<()> {
    if !allow_reserved_linuxdo_name && is_reserved_linuxdo_profile_name(name) {
        return Err(AsterError::validation_error(
            "profile name is reserved for LinuxDO fallback identities",
        ));
    }
    Ok(())
}

fn is_reserved_linuxdo_profile_name(name: &str) -> bool {
    let Some(subject) = name.strip_prefix("linuxdo_") else {
        return false;
    };
    !subject.is_empty() && subject.bytes().all(|byte| byte.is_ascii_digit())
}

async fn profile_name_taken<C: sea_orm::ConnectionTrait>(
    db: &C,
    name: &str,
    owner_user_id: i64,
    exclude_profile_id: Option<i64>,
) -> Result<bool> {
    if let Some(existing_profile) = minecraft_profile_repo::find_by_name(db, name).await?
        && Some(existing_profile.id) != exclude_profile_id
    {
        return Ok(true);
    }
    if let Some(existing_user) = user_repo::find_by_username_case_insensitive(db, name).await?
        && existing_user.id != owner_user_id
    {
        return Ok(true);
    }
    Ok(false)
}

/// Sanitize an external auth username into a valid Minecraft profile name.
///
/// Replaces invalid characters with underscores, truncates to 16 chars,
/// and pads with underscores if shorter than 3. Returns None if the result
/// would be empty or entirely non-alphanumeric.
fn sanitize_external_username(username: &str) -> Option<String> {
    let sanitized: String = username
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c)
            } else if matches!(c, '_' | '-' | '.' | ' ') {
                Some('_')
            } else {
                None
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();

    let mut name = if sanitized.len() > 16 {
        sanitized[..16].trim_matches('_').to_string()
    } else {
        sanitized
    };

    if name.is_empty() {
        return None;
    }

    while name.len() < 3 {
        name.push('_');
    }

    // Ensure the name contains at least one alphanumeric character
    if !name.bytes().any(|b| b.is_ascii_alphanumeric()) {
        return None;
    }

    Some(name)
}

/// Create a Minecraft profile for an externally-authenticated user.
///
/// This is called during auto-provision (e.g., LinuxDo first login) to
/// automatically create a profile using the external provider's username.
/// If the username cannot be sanitized into a valid profile name (3-16 ASCII
/// alphanumerics/underscores), the profile is silently skipped.
pub async fn create_profile_for_external_auth<S>(
    state: &S,
    user_id: i64,
    user_role: crate::types::user::UserRole,
    external_username: &str,
    fallback_username: Option<&str>,
) -> Result<minecraft_profile::Model>
where
    S: DatabaseRuntimeState + RuntimeConfigRuntimeState,
{
    let mut profile_names: Vec<(String, bool)> = Vec::new();
    if let Some(profile_name) = sanitize_external_username(external_username) {
        profile_names.push((profile_name, false));
    }
    if let Some(fallback_username) = fallback_username
        && let Some(fallback_name) = sanitize_external_username(fallback_username)
        && !profile_names
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case(&fallback_name))
    {
        profile_names.push((fallback_name, true));
    }

    if profile_names.is_empty() {
        tracing::debug!(
            user_id,
            external_username = %external_username,
            "cannot auto-create profile: external username could not be sanitized"
        );
        return Err(AsterError::validation_error(
            "external username cannot be converted to a valid profile name",
        ));
    };

    for (profile_name, allow_reserved_linuxdo_name) in &profile_names {
        if validate_reserved_profile_name(profile_name, *allow_reserved_linuxdo_name).is_err() {
            continue;
        }
        if !profile_name_taken(state.reader_db(), profile_name, user_id, None).await? {
            return create_profile_inner(
                state,
                user_id,
                user_role,
                profile_name,
                *allow_reserved_linuxdo_name,
            )
            .await;
        }
    }

    let Some((profile_name, allow_reserved_linuxdo_name)) = profile_names.last() else {
        return Err(AsterError::validation_error(
            "external username cannot be converted to a valid profile name",
        ));
    };
    let mut candidate = profile_name.clone();
    for suffix in 1..=99u32 {
        let suffix = suffix.to_string();
        let max_base = 16usize.saturating_sub(suffix.len());
        let base = &profile_name[..max_base.min(profile_name.len())];
        candidate = format!("{base}{suffix}");
        if !profile_name_taken(state.reader_db(), &candidate, user_id, None).await? {
            return create_profile_inner(
                state,
                user_id,
                user_role,
                &candidate,
                *allow_reserved_linuxdo_name,
            )
            .await;
        }
    }

    create_profile_inner(
        state,
        user_id,
        user_role,
        &candidate,
        *allow_reserved_linuxdo_name,
    )
    .await
}
