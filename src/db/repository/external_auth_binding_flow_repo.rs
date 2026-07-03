//! Repository helpers for external auth binding flows.

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    sea_query::Expr,
};

use crate::entities::external_auth_binding_flow::{self, Entity as ExternalAuthBindingFlow};
use crate::errors::{AsterError, Result};

pub async fn create<C: ConnectionTrait>(
    db: &C,
    model: external_auth_binding_flow::ActiveModel,
) -> Result<external_auth_binding_flow::Model> {
    model.insert(db).await.map_err(AsterError::from)
}

pub async fn consume_by_state_hash(
    db: &DatabaseConnection,
    state_hash: &str,
    now: chrono::DateTime<Utc>,
) -> Result<Option<external_auth_binding_flow::Model>> {
    let existing = find_active_by_state_hash(db, state_hash, now).await?;

    let Some(flow) = existing else {
        return Ok(None);
    };

    if consume_by_id(db, flow.id, now).await? {
        Ok(Some(flow))
    } else {
        Ok(None)
    }
}

pub async fn find_active_by_state_hash(
    db: &DatabaseConnection,
    state_hash: &str,
    now: chrono::DateTime<Utc>,
) -> Result<Option<external_auth_binding_flow::Model>> {
    ExternalAuthBindingFlow::find()
        .filter(external_auth_binding_flow::Column::StateHash.eq(state_hash))
        .filter(external_auth_binding_flow::Column::ConsumedAt.is_null())
        .filter(external_auth_binding_flow::Column::ExpiresAt.gt(now))
        .one(db)
        .await
        .map_err(AsterError::from)
}

pub async fn consume_by_id(
    db: &DatabaseConnection,
    id: i64,
    now: chrono::DateTime<Utc>,
) -> Result<bool> {
    let result = ExternalAuthBindingFlow::update_many()
        .col_expr(
            external_auth_binding_flow::Column::ConsumedAt,
            Expr::value(Some(now)),
        )
        .filter(external_auth_binding_flow::Column::Id.eq(id))
        .filter(external_auth_binding_flow::Column::ConsumedAt.is_null())
        .filter(external_auth_binding_flow::Column::ExpiresAt.gt(now))
        .exec(db)
        .await
        .map_err(AsterError::from)?;

    Ok(result.rows_affected == 1)
}

pub async fn cleanup_expired(db: &DatabaseConnection, now: chrono::DateTime<Utc>) -> Result<u64> {
    let result = ExternalAuthBindingFlow::delete_many()
        .filter(external_auth_binding_flow::Column::ExpiresAt.lt(now))
        .exec(db)
        .await
        .map_err(AsterError::from)?;
    Ok(result.rows_affected)
}
