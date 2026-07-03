//! Add case-insensitive uniqueness for Minecraft profile names.

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DatabaseBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        reject_case_insensitive_duplicates(manager).await?;
        add_normalized_name_column(manager).await?;
        backfill_normalized_names(manager).await?;
        drop_profile_name_unique_index(manager).await?;
        create_normalized_name_unique_index(manager).await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        drop_normalized_name_unique_index(manager).await?;
        manager
            .alter_table(
                Table::alter()
                    .table(MinecraftProfiles::Table)
                    .drop_column(MinecraftProfiles::NormalizedName)
                    .to_owned(),
            )
            .await?;
        create_profile_name_unique_index(manager).await
    }
}

async fn reject_case_insensitive_duplicates(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let sql = "SELECT LOWER(name), COUNT(*) \
               FROM minecraft_profiles \
               GROUP BY LOWER(name) \
               HAVING COUNT(*) > 1 \
               LIMIT 1";
    if let Some(row) = manager
        .get_connection()
        .query_one_raw(Statement::from_string(manager.get_database_backend(), sql))
        .await?
    {
        let normalized_name: String = row.try_get_by_index(0)?;
        let duplicate_count: i64 = row.try_get_by_index(1)?;
        return Err(DbErr::Migration(format!(
            "minecraft_profiles contains case-insensitive duplicate names; \
             resolve duplicates before migrating, normalized_name='{normalized_name}', \
             duplicate_count={duplicate_count}"
        )));
    }
    Ok(())
}

async fn add_normalized_name_column(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    manager
        .alter_table(
            Table::alter()
                .table(MinecraftProfiles::Table)
                .add_column(
                    ColumnDef::new(MinecraftProfiles::NormalizedName)
                        .string_len(16)
                        .not_null()
                        .default(""),
                )
                .to_owned(),
        )
        .await
}

async fn backfill_normalized_names(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    manager
        .get_connection()
        .execute_unprepared("UPDATE minecraft_profiles SET normalized_name = LOWER(name)")
        .await?;
    Ok(())
}

async fn drop_profile_name_unique_index(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    match manager.get_database_backend() {
        DatabaseBackend::Postgres => {
            execute_unprepared(
                manager,
                "ALTER TABLE minecraft_profiles \
                 DROP CONSTRAINT IF EXISTS idx_minecraft_profiles_name_unique",
            )
            .await?;
            execute_unprepared(
                manager,
                "DROP INDEX IF EXISTS idx_minecraft_profiles_name_unique",
            )
            .await
        }
        DatabaseBackend::MySql => {
            execute_unprepared(
                manager,
                "DROP INDEX idx_minecraft_profiles_name_unique ON minecraft_profiles",
            )
            .await
        }
        _ => {
            manager
                .drop_index(
                    Index::drop()
                        .name("idx_minecraft_profiles_name_unique")
                        .table(MinecraftProfiles::Table)
                        .if_exists()
                        .to_owned(),
                )
                .await
        }
    }
}

async fn create_profile_name_unique_index(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    if manager.get_database_backend() == DatabaseBackend::MySql {
        return execute_unprepared(
            manager,
            "CREATE UNIQUE INDEX idx_minecraft_profiles_name_unique \
             ON minecraft_profiles (name)",
        )
        .await;
    }

    manager
        .create_index(
            Index::create()
                .name("idx_minecraft_profiles_name_unique")
                .table(MinecraftProfiles::Table)
                .col(MinecraftProfiles::Name)
                .unique()
                .if_not_exists()
                .to_owned(),
        )
        .await
}

async fn drop_normalized_name_unique_index(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    match manager.get_database_backend() {
        DatabaseBackend::MySql => {
            execute_unprepared(
                manager,
                "DROP INDEX idx_minecraft_profiles_normalized_name_unique ON minecraft_profiles",
            )
            .await
        }
        _ => {
            manager
                .drop_index(
                    Index::drop()
                        .name("idx_minecraft_profiles_normalized_name_unique")
                        .table(MinecraftProfiles::Table)
                        .if_exists()
                        .to_owned(),
                )
                .await
        }
    }
}

async fn create_normalized_name_unique_index(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    if manager.get_database_backend() == DatabaseBackend::MySql {
        return execute_unprepared(
            manager,
            "CREATE UNIQUE INDEX idx_minecraft_profiles_normalized_name_unique \
             ON minecraft_profiles (normalized_name)",
        )
        .await;
    }

    manager
        .create_index(
            Index::create()
                .name("idx_minecraft_profiles_normalized_name_unique")
                .table(MinecraftProfiles::Table)
                .col(MinecraftProfiles::NormalizedName)
                .unique()
                .if_not_exists()
                .to_owned(),
        )
        .await
}

async fn execute_unprepared(manager: &SchemaManager<'_>, sql: &str) -> Result<(), DbErr> {
    manager.get_connection().execute_unprepared(sql).await?;
    Ok(())
}

#[derive(DeriveIden)]
enum MinecraftProfiles {
    Table,
    Name,
    NormalizedName,
}
