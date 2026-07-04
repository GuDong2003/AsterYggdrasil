use chrono::Utc;

use crate::api::error_code::AsterErrorCode;
use crate::db::repository::{
    external_auth_binding_flow_repo, external_auth_email_verification_flow_repo,
    external_auth_identity_repo, external_auth_login_flow_repo, external_auth_provider_repo,
};
use crate::entities::{external_auth_identity, external_auth_provider};
use crate::errors::{AsterError, Result};
use crate::runtime::SharedRuntimeState;
use crate::types::external_auth::{ExternalAuthProviderKind, parse_external_auth_provider_options};
use aster_forge_api::{CursorPage, DateTimeIdCursor};

use super::ExternalAuthLinkInfo;

const MINECRAFT_IDENTITY_NAMESPACE: &str = "https://api.minecraftservices.com/minecraft/profile";

pub async fn list_links(
    state: &impl SharedRuntimeState,
    user_id: i64,
) -> Result<Vec<ExternalAuthLinkInfo>> {
    let identities = external_auth_identity_repo::list_for_user(state.writer_db(), user_id).await?;
    let providers = external_auth_provider_repo::find_all(state.writer_db()).await?;
    let provider_lookup = providers
        .into_iter()
        .map(|provider| (provider.id, provider))
        .collect::<std::collections::HashMap<_, _>>();
    Ok(identities
        .into_iter()
        .filter_map(|identity| {
            let provider = provider_lookup.get(&identity.provider_id)?;
            Some(link_to_info(identity, provider))
        })
        .collect())
}

pub async fn list_links_paginated(
    state: &impl SharedRuntimeState,
    user_id: i64,
    limit: u64,
    cursor: Option<(chrono::DateTime<chrono::Utc>, i64)>,
) -> Result<CursorPage<ExternalAuthLinkInfo, DateTimeIdCursor>> {
    let limit = limit.clamp(1, 100);
    let page = external_auth_identity_repo::list_for_user_cursor(
        state.writer_db(),
        user_id,
        limit,
        cursor,
    )
    .await?;
    let next_cursor = if page.has_more {
        page.items.last().map(|identity| DateTimeIdCursor {
            value: identity.created_at,
            id: identity.id,
        })
    } else {
        None
    };
    let provider_ids = page
        .items
        .iter()
        .map(|identity| identity.provider_id)
        .collect::<std::collections::BTreeSet<_>>();
    let provider_ids = provider_ids.into_iter().collect::<Vec<_>>();
    let providers =
        external_auth_provider_repo::find_by_ids(state.writer_db(), &provider_ids).await?;
    let provider_lookup = providers
        .into_iter()
        .map(|provider| (provider.id, provider))
        .collect::<std::collections::HashMap<_, _>>();
    let items = page
        .items
        .into_iter()
        .filter_map(|identity| {
            let provider = provider_lookup.get(&identity.provider_id)?;
            Some(link_to_info(identity, provider))
        })
        .collect::<Vec<_>>();
    Ok(CursorPage::new(items, page.total, limit, next_cursor))
}

fn link_to_info(
    identity: external_auth_identity::Model,
    provider: &external_auth_provider::Model,
) -> ExternalAuthLinkInfo {
    let metadata = identity
        .metadata
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    let options = parse_external_auth_provider_options(provider.options.as_ref());
    let allow_unlink = external_auth_identity_can_unlink(
        provider.provider_kind,
        &identity.identity_namespace,
        options.allow_unlink,
    );
    ExternalAuthLinkInfo {
        id: identity.id,
        provider_id: identity.provider_id,
        provider_key: provider.key.clone(),
        provider_kind: provider.provider_kind,
        provider_display_name: provider.display_name.clone(),
        provider_icon_url: provider.icon_url.clone(),
        issuer: identity.identity_namespace,
        subject: identity.subject,
        email_snapshot: identity.email_snapshot,
        display_name_snapshot: identity.display_name_snapshot,
        created_at: identity.created_at,
        updated_at: identity.updated_at,
        last_login_at: identity.last_login_at,
        metadata,
        allow_unlink,
    }
}

pub async fn delete_link(state: &impl SharedRuntimeState, user_id: i64, id: i64) -> Result<bool> {
    let Some(identity) =
        external_auth_identity_repo::find_by_id_for_user(state.writer_db(), id, user_id).await?
    else {
        return Ok(false);
    };
    let provider =
        external_auth_provider_repo::find_by_id(state.writer_db(), identity.provider_id).await?;
    let options = parse_external_auth_provider_options(provider.options.as_ref());
    if !external_auth_identity_can_unlink(
        provider.provider_kind,
        &identity.identity_namespace,
        options.allow_unlink,
    ) {
        return Err(AsterError::auth_forbidden_code(
            AsterErrorCode::ExternalAuthProviderUnlinkDisabled,
            "external auth identity cannot be unlinked",
        ));
    }

    external_auth_identity_repo::delete_for_user(state.writer_db(), id, user_id).await
}

fn external_auth_identity_can_unlink(
    provider_kind: ExternalAuthProviderKind,
    identity_namespace: &str,
    provider_allows_unlink: bool,
) -> bool {
    if matches!(
        provider_kind,
        ExternalAuthProviderKind::Microsoft | ExternalAuthProviderKind::LinuxDo
    ) {
        return false;
    }
    identity_namespace != MINECRAFT_IDENTITY_NAMESPACE && provider_allows_unlink
}

pub async fn cleanup_expired_flows(state: &impl SharedRuntimeState) -> Result<u64> {
    let now = Utc::now();
    let login_flows =
        external_auth_login_flow_repo::cleanup_expired(state.writer_db(), now).await?;
    let binding_flows =
        external_auth_binding_flow_repo::cleanup_expired(state.writer_db(), now).await?;
    let email_flows =
        external_auth_email_verification_flow_repo::cleanup_expired(state.writer_db(), now).await?;
    Ok(login_flows + binding_flows + email_flows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microsoft_and_linuxdo_links_are_not_unlinkable() {
        assert!(!external_auth_identity_can_unlink(
            ExternalAuthProviderKind::Microsoft,
            "https://login.microsoftonline.com/consumers/v2.0",
            true,
        ));
        assert!(!external_auth_identity_can_unlink(
            ExternalAuthProviderKind::LinuxDo,
            "https://connect.linux.do",
            true,
        ));
    }

    #[test]
    fn minecraft_namespace_and_provider_policy_disable_unlinking() {
        assert!(!external_auth_identity_can_unlink(
            ExternalAuthProviderKind::Oidc,
            MINECRAFT_IDENTITY_NAMESPACE,
            true,
        ));
        assert!(!external_auth_identity_can_unlink(
            ExternalAuthProviderKind::Oidc,
            "https://example.com",
            false,
        ));
    }

    #[test]
    fn ordinary_links_can_be_unlinked_when_provider_allows_it() {
        assert!(external_auth_identity_can_unlink(
            ExternalAuthProviderKind::Oidc,
            "https://example.com",
            true,
        ));
    }
}
