//! Minecraft profile local texture preset repository.

use crate::entities::minecraft_profile_texture_preference::{
    self, Entity as MinecraftProfileTexturePreference,
};
use crate::errors::{AsterError, MapAsterErr, Result};
use crate::types::yggdrasil::MinecraftTextureType;
use sea_orm::{ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set};

#[derive(Debug, Clone)]
pub struct UpsertMinecraftProfileTexturePreference {
    pub profile_id: i64,
    pub texture_type: MinecraftTextureType,
    pub texture_id: i64,
}

pub async fn upsert<C: ConnectionTrait>(
    db: &C,
    input: UpsertMinecraftProfileTexturePreference,
) -> Result<minecraft_profile_texture_preference::Model> {
    let now = chrono::Utc::now();
    let preference = if let Some(existing) =
        find_by_profile_and_type(db, input.profile_id, input.texture_type).await?
    {
        let mut active: minecraft_profile_texture_preference::ActiveModel = existing.into();
        active.texture_id = Set(input.texture_id);
        active.updated_at = Set(now);
        active
            .update(db)
            .await
            .map_aster_err(AsterError::database_operation)?
    } else {
        minecraft_profile_texture_preference::ActiveModel {
            profile_id: Set(input.profile_id),
            texture_type: Set(input.texture_type),
            texture_id: Set(input.texture_id),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await
        .map_aster_err(AsterError::database_operation)?
    };
    Ok(preference)
}

pub async fn find_by_profile_and_type<C: ConnectionTrait>(
    db: &C,
    profile_id: i64,
    texture_type: MinecraftTextureType,
) -> Result<Option<minecraft_profile_texture_preference::Model>> {
    MinecraftProfileTexturePreference::find()
        .filter(minecraft_profile_texture_preference::Column::ProfileId.eq(profile_id))
        .filter(minecraft_profile_texture_preference::Column::TextureType.eq(texture_type))
        .one(db)
        .await
        .map_aster_err(AsterError::database_operation)
}
