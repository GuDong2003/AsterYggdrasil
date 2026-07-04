//! Track whether a Minecraft texture came from local upload or Mojang sync.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(MinecraftTextures::Table)
                    .add_column(
                        ColumnDef::new(MinecraftTextures::Source)
                            .string_len(16)
                            .not_null()
                            .default("local"),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(MinecraftTextures::Table)
                    .drop_column(MinecraftTextures::Source)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum MinecraftTextures {
    Table,
    Source,
}
