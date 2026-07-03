//! Integration tests for Microsoft Minecraft account binding.

#[macro_use]
mod common;

use actix_web::{App, HttpRequest, HttpResponse, HttpServer, Responder, test, web};
use aster_yggdrasil::db::repository::{external_auth_identity_repo, minecraft_profile_repo};
use aster_yggdrasil::entities::{external_auth_provider, user};
use aster_yggdrasil::types::external_auth::{
    ExternalAuthProtocol, ExternalAuthProviderKind, StoredExternalAuthProviderOptions,
};
use aster_yggdrasil::types::yggdrasil::MinecraftProfileSource;
use chrono::Utc;
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter};
use serde::Deserialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};

const TEST_CLIENT_ID: &str = "minecraft-binding-client";
const TEST_CLIENT_SECRET: &str = "minecraft-binding-secret";
const TEST_DEVICE_CODE: &str = "mock-device-code";
const TEST_USER_CODE: &str = "ABCD-EFGH";
const TEST_MINECRAFT_UUID: &str = "069a79f444e94726a5befca90e38aaf5";
const TEST_MINECRAFT_NAME: &str = "Notch";

#[derive(Clone)]
struct MockMicrosoftMinecraftProvider {
    base_url: String,
    device_code_requests: Arc<Mutex<Vec<DeviceCodeRequest>>>,
    device_token_requests: Arc<Mutex<Vec<DeviceTokenRequest>>>,
    device_token_attempts: Arc<Mutex<usize>>,
}

#[derive(Clone, Debug, Deserialize)]
struct DeviceCodeRequest {
    client_id: String,
    scope: String,
}

#[derive(Clone, Debug, Deserialize)]
struct DeviceTokenRequest {
    grant_type: String,
    client_id: String,
    device_code: String,
}

async fn start_mock_microsoft_minecraft_provider()
-> (MockMicrosoftMinecraftProvider, actix_web::dev::ServerHandle) {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("listener should bind");
    let addr = listener
        .local_addr()
        .expect("listener address should exist");
    let provider = MockMicrosoftMinecraftProvider {
        base_url: format!("http://127.0.0.1:{}", addr.port()),
        device_code_requests: Arc::new(Mutex::new(Vec::new())),
        device_token_requests: Arc::new(Mutex::new(Vec::new())),
        device_token_attempts: Arc::new(Mutex::new(0)),
    };
    let app_provider = provider.clone();
    let server = HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(app_provider.clone()))
            .route("/devicecode", web::post().to(mock_device_code))
            .route("/oauth2/v2.0/token", web::post().to(mock_token))
            .route("/user/authenticate", web::post().to(mock_xbox_live))
            .route("/xsts/authorize", web::post().to(mock_xsts))
            .route(
                "/authentication/login_with_xbox",
                web::post().to(mock_minecraft_login),
            )
            .route("/minecraft/profile", web::get().to(mock_minecraft_profile))
    })
    .workers(1)
    .listen(listener)
    .expect("mock Microsoft Minecraft server should listen")
    .run();
    let handle = server.handle();
    tokio::spawn(server);
    (provider, handle)
}

async fn mock_device_code(
    provider: web::Data<MockMicrosoftMinecraftProvider>,
    form: web::Form<DeviceCodeRequest>,
) -> impl Responder {
    let request = form.into_inner();
    assert_eq!(request.client_id, TEST_CLIENT_ID);
    assert_eq!(request.scope, "XboxLive.signin offline_access");
    provider
        .device_code_requests
        .lock()
        .expect("device code requests lock should not be poisoned")
        .push(request);
    HttpResponse::Ok().json(serde_json::json!({
        "device_code": TEST_DEVICE_CODE,
        "user_code": TEST_USER_CODE,
        "verification_uri": "https://www.microsoft.com/link",
        "expires_in": 900,
        "interval": 1
    }))
}

async fn mock_token(
    provider: web::Data<MockMicrosoftMinecraftProvider>,
    form: web::Form<DeviceTokenRequest>,
) -> impl Responder {
    let request = form.into_inner();
    assert_eq!(
        request.grant_type,
        "urn:ietf:params:oauth:grant-type:device_code"
    );
    assert_eq!(request.client_id, TEST_CLIENT_ID);
    assert_eq!(request.device_code, TEST_DEVICE_CODE);
    provider
        .device_token_requests
        .lock()
        .expect("device token requests lock should not be poisoned")
        .push(request);

    let mut attempts = provider
        .device_token_attempts
        .lock()
        .expect("device token attempts lock should not be poisoned");
    *attempts += 1;
    if *attempts == 1 {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "authorization_pending",
            "error_description": "Authorization is still pending."
        }));
    }

    HttpResponse::Ok().json(serde_json::json!({
        "access_token": "mock-microsoft-access-token",
        "token_type": "Bearer",
        "expires_in": 3600
    }))
}

async fn mock_xbox_live(body: web::Json<Value>) -> impl Responder {
    assert_eq!(body["Properties"]["AuthMethod"], "RPS");
    assert_eq!(body["Properties"]["SiteName"], "user.auth.xboxlive.com");
    assert_eq!(
        body["Properties"]["RpsTicket"],
        "d=mock-microsoft-access-token"
    );
    assert_eq!(body["RelyingParty"], "http://auth.xboxlive.com");
    assert_eq!(body["TokenType"], "JWT");
    HttpResponse::Ok().json(serde_json::json!({
        "Token": "mock-xbox-live-token",
        "DisplayClaims": {
            "xui": [{ "uhs": "mock-user-hash" }]
        }
    }))
}

async fn mock_xsts(body: web::Json<Value>) -> impl Responder {
    assert_eq!(body["Properties"]["SandboxId"], "RETAIL");
    assert_eq!(body["Properties"]["UserTokens"][0], "mock-xbox-live-token");
    assert_eq!(body["RelyingParty"], "rp://api.minecraftservices.com/");
    assert_eq!(body["TokenType"], "JWT");
    HttpResponse::Ok().json(serde_json::json!({
        "Token": "mock-xsts-token",
        "DisplayClaims": {
            "xui": [{ "uhs": "mock-user-hash" }]
        }
    }))
}

async fn mock_minecraft_login(body: web::Json<Value>) -> impl Responder {
    assert_eq!(
        body["identityToken"],
        "XBL3.0 x=mock-user-hash;mock-xsts-token"
    );
    HttpResponse::Ok().json(serde_json::json!({
        "access_token": "mock-minecraft-access-token",
        "token_type": "Bearer",
        "expires_in": 3600
    }))
}

async fn mock_minecraft_profile(req: HttpRequest) -> impl Responder {
    let authorization = req
        .headers()
        .get("Authorization")
        .and_then(|value| value.to_str().ok());
    assert_eq!(authorization, Some("Bearer mock-minecraft-access-token"));
    HttpResponse::Ok().json(serde_json::json!({
        "id": TEST_MINECRAFT_UUID,
        "name": TEST_MINECRAFT_NAME
    }))
}

fn microsoft_binding_provider_model(base_url: &str) -> external_auth_provider::ActiveModel {
    let now = Utc::now();
    external_auth_provider::ActiveModel {
        key: Set("ms-bind".to_string()),
        display_name: Set("Microsoft Minecraft".to_string()),
        icon_url: Set(None),
        provider_kind: Set(ExternalAuthProviderKind::Microsoft),
        protocol: Set(ExternalAuthProtocol::Oidc),
        options: Set(StoredExternalAuthProviderOptions(
            serde_json::json!({
                "allow_login": false,
                "allow_unlink": false
            })
            .to_string(),
        )),
        issuer_url: Set(None),
        authorization_url: Set(Some(format!("{base_url}/oauth2/v2.0/authorize"))),
        token_url: Set(Some(format!("{base_url}/oauth2/v2.0/token"))),
        userinfo_url: Set(None),
        client_id: Set(TEST_CLIENT_ID.to_string()),
        client_secret: Set(Some(TEST_CLIENT_SECRET.to_string())),
        scopes: Set("openid email profile".to_string()),
        enabled: Set(true),
        auto_provision_enabled: Set(false),
        auto_link_verified_email_enabled: Set(false),
        require_email_verified: Set(false),
        subject_claim: Set(None),
        username_claim: Set(None),
        display_name_claim: Set(None),
        email_claim: Set(None),
        email_verified_claim: Set(None),
        groups_claim: Set(None),
        avatar_url_claim: Set(None),
        allowed_domains: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
}

#[actix_web::test]
async fn microsoft_provider_with_login_disabled_can_bind_minecraft_profile() {
    let (mock_provider, server) = start_mock_microsoft_minecraft_provider().await;
    let state = common::setup().await;
    common::disable_registration_activation(&state);
    state.runtime_config.apply(common::system_config_model(
        aster_yggdrasil::config::site_url::PUBLIC_SITE_URL_KEY,
        r#"["http://localhost:8080"]"#,
    ));
    let provider = microsoft_binding_provider_model(&mock_provider.base_url)
        .insert(state.writer_db())
        .await
        .expect("Microsoft binding provider should insert");

    let app = create_test_app!(state.clone());
    let access_token = register_user!(app, "binduser", "binduser@example.com", "password1234");
    let user = user::Entity::find()
        .filter(user::Column::Username.eq("binduser"))
        .one(state.reader_db())
        .await
        .expect("user query should succeed")
        .expect("user should exist");

    let req = test::TestRequest::get()
        .uri("/api/v1/auth/external-auth/microsoft/providers")
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = test::read_body_json(resp).await;
    assert_eq!(body["data"]["total"], 0);

    let req = test::TestRequest::get()
        .uri("/api/v1/auth/external-auth/microsoft/binding/providers")
        .insert_header(("Cookie", common::access_cookie_header(&access_token)))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = test::read_body_json(resp).await;
    assert_eq!(body["data"]["total"], 1);
    assert_eq!(body["data"]["items"][0]["key"], "microsoft");
    assert_eq!(body["data"]["items"][0]["kind"], "microsoft");

    let req = test::TestRequest::post()
        .uri("/api/v1/auth/external-auth/microsoft/microsoft/binding/start")
        .insert_header(("Cookie", common::access_cookie_header(&access_token)))
        .insert_header(common::csrf_header_for(&access_token))
        .set_json(serde_json::json!({
            "return_path": "/account/settings?tab=profiles"
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = test::read_body_json(resp).await;
    assert_eq!(
        body["data"]["authorization_url"],
        "https://www.microsoft.com/link"
    );
    assert_eq!(body["data"]["device_code"], TEST_DEVICE_CODE);
    assert_eq!(body["data"]["user_code"], TEST_USER_CODE);
    assert_eq!(
        body["data"]["verification_uri"],
        "https://www.microsoft.com/link"
    );
    assert_eq!(body["data"]["interval"], 1);

    let req = test::TestRequest::post()
        .uri("/api/v1/auth/external-auth/device-code/check")
        .insert_header(("Cookie", common::access_cookie_header(&access_token)))
        .insert_header(common::csrf_header_for(&access_token))
        .set_json(serde_json::json!({
            "device_code": TEST_DEVICE_CODE
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = test::read_body_json(resp).await;
    assert_eq!(body["data"]["status"], "pending");

    let req = test::TestRequest::post()
        .uri("/api/v1/auth/external-auth/device-code/check")
        .insert_header(("Cookie", common::access_cookie_header(&access_token)))
        .insert_header(common::csrf_header_for(&access_token))
        .set_json(serde_json::json!({
            "device_code": TEST_DEVICE_CODE
        }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = test::read_body_json(resp).await;
    assert_eq!(body["data"]["status"], "completed");
    assert_eq!(body["data"]["profile"]["uuid"], TEST_MINECRAFT_UUID);
    assert_eq!(body["data"]["profile"]["name"], TEST_MINECRAFT_NAME);
    assert_eq!(body["data"]["profile_created"], true);
    assert_eq!(body["data"]["identity_linked"], true);

    let profile = minecraft_profile_repo::find_by_uuid(state.reader_db(), TEST_MINECRAFT_UUID)
        .await
        .expect("profile query should succeed")
        .expect("bound profile should exist");
    assert_eq!(profile.user_id, user.id);
    assert_eq!(profile.name, TEST_MINECRAFT_NAME);
    assert_eq!(profile.source, MinecraftProfileSource::Microsoft);

    let req = test::TestRequest::put()
        .uri(&format!(
            "/api/v1/profiles/minecraft/{TEST_MINECRAFT_UUID}/name"
        ))
        .insert_header(("Cookie", common::access_cookie_header(&access_token)))
        .insert_header(common::csrf_header_for(&access_token))
        .set_json(serde_json::json!({ "name": "ChangedName" }))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), 400);
    let body: Value = test::read_body_json(resp).await;
    assert_eq!(body["code"], "minecraft_profile.official_name_readonly");

    let identity = external_auth_identity_repo::find_by_provider_subject(
        state.reader_db(),
        provider.id,
        TEST_MINECRAFT_UUID,
    )
    .await
    .expect("identity query should succeed")
    .expect("Microsoft identity should exist");
    assert_eq!(identity.user_id, user.id);
    assert_eq!(
        identity.identity_namespace,
        "https://api.minecraftservices.com/minecraft/profile"
    );
    assert_eq!(
        identity.display_name_snapshot.as_deref(),
        Some(TEST_MINECRAFT_NAME)
    );
    let metadata: Value =
        serde_json::from_str(identity.metadata.as_deref().expect("metadata should exist"))
            .expect("metadata should be JSON");
    assert_eq!(metadata["minecraft_uuid"], TEST_MINECRAFT_UUID);
    assert_eq!(metadata["minecraft_name"], TEST_MINECRAFT_NAME);
    assert_eq!(metadata["xbox_user_hash"], "mock-user-hash");

    let mut provider_update: external_auth_provider::ActiveModel = provider.clone().into();
    provider_update.options = Set(StoredExternalAuthProviderOptions(
        serde_json::json!({
            "allow_login": false,
            "allow_unlink": true
        })
        .to_string(),
    ));
    provider_update
        .update(state.writer_db())
        .await
        .expect("provider unlink option should update");

    let req = test::TestRequest::get()
        .uri("/api/v1/auth/external-auth/links")
        .insert_header(("Cookie", common::access_cookie_header(&access_token)))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = test::read_body_json(resp).await;
    assert_eq!(body["data"]["total"], 1);
    assert_eq!(body["data"]["items"][0]["provider_key"], "ms-bind");
    assert_eq!(body["data"]["items"][0]["allow_unlink"], false);
    let link_id = body["data"]["items"][0]["id"]
        .as_i64()
        .expect("link id should exist");

    let req = test::TestRequest::delete()
        .uri(&format!("/api/v1/auth/external-auth/links/{link_id}"))
        .insert_header(("Cookie", common::access_cookie_header(&access_token)))
        .insert_header(common::csrf_header_for(&access_token))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), 403);
    let body: Value = test::read_body_json(resp).await;
    assert_eq!(body["code"], "external_auth.provider_unlink_disabled");

    server.stop(true).await;
}
