use ai_gateway_lib::utils;
use ai_gateway_lib::utils::{normalize_log_level, resolve_custom_data_dir};
use std::env;
use std::path::PathBuf;

#[test]
fn test_generate_client_url() {
    // Normal localhost
    assert_eq!(utils::generate_client_url("127.0.0.1", 6722), "http://127.0.0.1:6722");
    assert_eq!(utils::generate_client_url("localhost", 6722), "http://localhost:6722");
    
    // Custom IP
    assert_eq!(utils::generate_client_url("192.168.1.100", 8080), "http://192.168.1.100:8080");
    
    // 0.0.0.0 should be mapped to 127.0.0.1
    assert_eq!(utils::generate_client_url("0.0.0.0", 6722), "http://127.0.0.1:6722");
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = env::temp_dir().join(format!("gt-gateway-test-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn normalize_log_level_accepts_known_levels_case_insensitively() {
    assert_eq!(normalize_log_level("DEBUG").as_deref(), Some("debug"));
    assert_eq!(normalize_log_level("Info").as_deref(), Some("info"));
    assert_eq!(normalize_log_level(" warn ").as_deref(), Some("warn"));
    assert_eq!(normalize_log_level("error").as_deref(), Some("error"));
}

#[test]
fn normalize_log_level_rejects_unknown_values() {
    assert_eq!(normalize_log_level("verbose"), None);
    assert_eq!(normalize_log_level(""), None);
    assert_eq!(normalize_log_level("   "), None);
}

#[test]
fn resolve_custom_data_dir_returns_none_for_empty_values() {
    assert!(resolve_custom_data_dir(None, None).unwrap().is_none());
    assert!(resolve_custom_data_dir(Some(""), None).unwrap().is_none());
    assert!(resolve_custom_data_dir(Some("   "), None).unwrap().is_none());
}

#[test]
fn resolve_custom_data_dir_accepts_existing_directory() {
    let dir = temp_dir("existing");
    let resolved = resolve_custom_data_dir(Some(dir.to_str().unwrap()), None).unwrap();
    assert_eq!(resolved.as_deref(), Some(dir.as_path()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn resolve_custom_data_dir_expands_tilde() {
    let home = temp_dir("home");
    let resolved = resolve_custom_data_dir(Some("~"), Some(&home)).unwrap();
    assert_eq!(resolved.as_deref(), Some(home.as_path()));

    let nested = home.join("data");
    std::fs::create_dir_all(&nested).unwrap();
    let resolved = resolve_custom_data_dir(Some("~/data"), Some(&home)).unwrap();
    assert_eq!(resolved.as_deref(), Some(nested.as_path()));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn resolve_custom_data_dir_rejects_missing_path() {
    let dir = temp_dir("missing").join("not-created");
    let err = resolve_custom_data_dir(Some(dir.to_str().unwrap()), None).unwrap_err();
    assert!(err.contains("不存在"), "错误信息应说明目录不存在：{err}");
}

#[test]
fn resolve_custom_data_dir_rejects_file_path() {
    let dir = temp_dir("file");
    let file = dir.join("config.json");
    std::fs::write(&file, "{}").unwrap();
    let err = resolve_custom_data_dir(Some(file.to_str().unwrap()), None).unwrap_err();
    assert!(err.contains("不是目录"), "错误信息应说明不是目录：{err}");
    let _ = std::fs::remove_dir_all(&dir);
}
