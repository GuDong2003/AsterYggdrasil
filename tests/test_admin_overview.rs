//! Integration tests for administrator overview routes.

#[macro_use]
mod common;

use actix_web::test;
use serde_json::Value;

#[actix_web::test]
async fn admin_overview_route_is_admin_only() {
    let state = common::setup().await;
    common::disable_registration_activation(&state);
    let app = create_test_app!(state);
    let admin_token = setup_admin!(app);
    let user_token = register_user!(
        app,
        "overview-user",
        "overview-user@example.com",
        "password1234"
    );

    let req = test::TestRequest::get()
        .uri("/api/v1/admin/overview")
        .to_request();
    assert_service_status!(app, req, 401);

    let req = test::TestRequest::get()
        .uri("/api/v1/admin/overview")
        .insert_header(common::bearer_header(user_token))
        .to_request();
    assert_service_status!(app, req, 403);

    let req = test::TestRequest::get()
        .uri("/api/v1/admin/overview")
        .insert_header(("Cookie", common::access_cookie_header(admin_token)))
        .to_request();
    let resp = test::call_service(&app, req).await;
    assert_eq!(resp.status(), 200);
    let body: Value = test::read_body_json(resp).await;
    assert_eq!(body["code"], "success");
    assert!(body["data"]["summary"]["total_users"].as_u64().unwrap() >= 2);
    assert!(body["data"]["services"].as_array().unwrap().len() >= 5);
    assert_eq!(body["data"]["system_health"]["status"], "unknown");
    assert!(
        body["data"]["system_health"]["components"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
