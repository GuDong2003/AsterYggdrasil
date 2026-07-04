//! AsterYggdrasil database migrations.
#![deny(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::unreachable,
        clippy::expect_used,
        clippy::panic,
        clippy::unimplemented,
        clippy::todo
    )
)]

pub use sea_orm_migration::prelude::*;

mod m20260606_000001_foundation_schema;
mod m20260615_000001_yggdrasil_profiles;
mod m20260615_000002_minecraft_textures;
mod m20260615_000003_passkeys;
mod m20260616_000001_yggdrasil_token_temporary_invalidation;
mod m20260618_000001_auth_email_registration_and_invitations;
mod m20260618_000002_add_user_must_change_password;
mod m20260618_000003_audit_log_activity_indexes;
mod m20260618_000004_texture_library_metadata;
mod m20260618_000005_operator_scopes;
mod m20260618_000006_texture_library_review;
mod m20260618_000007_texture_library_reports;
mod m20260619_000001_cursor_pagination_indexes;
mod m20260620_000001_yggdrasil_session_forward_servers;
mod m20260620_000002_user_bans;
mod m20260626_000001_runtime_leases;
mod m20260626_000002_background_task_dedupe_key;
mod m20260626_000003_scheduled_tasks;
mod m20260626_000004_widen_mail_outbox_template_code;
mod m20260629_000001_external_auth_identity_metadata;
mod m20260630_000001_minecraft_profile_rename_count;
mod m20260701_000001_nullable_user_email;
mod m20260701_000002_minecraft_profile_normalized_name;
mod m20260701_000003_ensure_user_email_nullable;
mod m20260702_000001_external_auth_binding_flows;
mod m20260702_000002_minecraft_profile_source;
mod m20260704_000001_minecraft_texture_source;
mod m20260704_000002_minecraft_profile_texture_preferences;
mod time;

pub struct Migrator;

impl Migrator {
    pub async fn up(
        db: &sea_orm_migration::sea_orm::DatabaseConnection,
        steps: Option<u32>,
    ) -> Result<(), DbErr> {
        <Self as MigratorTrait>::up(db, steps).await
    }
}

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260606_000001_foundation_schema::Migration),
            Box::new(m20260615_000001_yggdrasil_profiles::Migration),
            Box::new(m20260615_000002_minecraft_textures::Migration),
            Box::new(m20260615_000003_passkeys::Migration),
            Box::new(m20260616_000001_yggdrasil_token_temporary_invalidation::Migration),
            Box::new(m20260618_000001_auth_email_registration_and_invitations::Migration),
            Box::new(m20260618_000002_add_user_must_change_password::Migration),
            Box::new(m20260618_000003_audit_log_activity_indexes::Migration),
            Box::new(m20260618_000004_texture_library_metadata::Migration),
            Box::new(m20260618_000005_operator_scopes::Migration),
            Box::new(m20260618_000006_texture_library_review::Migration),
            Box::new(m20260618_000007_texture_library_reports::Migration),
            Box::new(m20260619_000001_cursor_pagination_indexes::Migration),
            Box::new(m20260620_000001_yggdrasil_session_forward_servers::Migration),
            Box::new(m20260620_000002_user_bans::Migration),
            Box::new(m20260626_000001_runtime_leases::Migration),
            Box::new(m20260626_000002_background_task_dedupe_key::Migration),
            Box::new(m20260626_000003_scheduled_tasks::Migration),
            Box::new(m20260626_000004_widen_mail_outbox_template_code::Migration),
            Box::new(m20260629_000001_external_auth_identity_metadata::Migration),
            Box::new(m20260630_000001_minecraft_profile_rename_count::Migration),
            Box::new(m20260701_000001_nullable_user_email::Migration),
            Box::new(m20260701_000002_minecraft_profile_normalized_name::Migration),
            Box::new(m20260701_000003_ensure_user_email_nullable::Migration),
            Box::new(m20260702_000001_external_auth_binding_flows::Migration),
            Box::new(m20260702_000002_minecraft_profile_source::Migration),
            Box::new(m20260704_000001_minecraft_texture_source::Migration),
            Box::new(m20260704_000002_minecraft_profile_texture_preferences::Migration),
        ]
    }
}
