//! Remember each profile's last local wardrobe texture selection.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(MinecraftProfileTexturePreferences::Table)
                    .if_not_exists()
                    .col(big_integer_pk(MinecraftProfileTexturePreferences::Id))
                    .col(
                        ColumnDef::new(MinecraftProfileTexturePreferences::ProfileId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(MinecraftProfileTexturePreferences::TextureType)
                            .string_len(16)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(MinecraftProfileTexturePreferences::TextureId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        utc_timestamp(manager, MinecraftProfileTexturePreferences::CreatedAt)
                            .not_null(),
                    )
                    .col(
                        utc_timestamp(manager, MinecraftProfileTexturePreferences::UpdatedAt)
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_minecraft_profile_texture_prefs_profile")
                            .from(
                                MinecraftProfileTexturePreferences::Table,
                                MinecraftProfileTexturePreferences::ProfileId,
                            )
                            .to(MinecraftProfiles::Table, MinecraftProfiles::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_minecraft_profile_texture_prefs_texture")
                            .from(
                                MinecraftProfileTexturePreferences::Table,
                                MinecraftProfileTexturePreferences::TextureId,
                            )
                            .to(MinecraftTextures::Table, MinecraftTextures::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .index(
                        Index::create()
                            .name("idx_minecraft_profile_texture_prefs_profile_type_unique")
                            .col(MinecraftProfileTexturePreferences::ProfileId)
                            .col(MinecraftProfileTexturePreferences::TextureType)
                            .unique(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_minecraft_profile_texture_prefs_texture")
                    .table(MinecraftProfileTexturePreferences::Table)
                    .col(MinecraftProfileTexturePreferences::TextureId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(MinecraftProfileTexturePreferences::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await
    }
}

fn big_integer_pk<T: IntoIden>(column: T) -> ColumnDef {
    let mut column = ColumnDef::new(column);
    column
        .big_integer()
        .not_null()
        .auto_increment()
        .primary_key();
    column
}

fn utc_timestamp<T: IntoIden>(manager: &SchemaManager<'_>, column: T) -> ColumnDef {
    crate::time::utc_date_time_column(manager, column)
}

#[derive(DeriveIden)]
enum MinecraftProfiles {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum MinecraftTextures {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum MinecraftProfileTexturePreferences {
    Table,
    Id,
    ProfileId,
    TextureType,
    TextureId,
    CreatedAt,
    UpdatedAt,
}
