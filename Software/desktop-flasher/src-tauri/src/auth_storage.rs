use std::sync::Mutex;

// Stable across dev restarts and packaged builds, independent of WebView origin.
const SERVICE: &str = "sbs.trendhub.farmos.desktop-flasher.auth";
static STORAGE_LOCK: Mutex<()> = Mutex::new(());

fn entry(key: &str) -> Result<keyring::Entry, String> {
    if !key.starts_with("sb-") || key.len() > 256 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Khóa lưu phiên không hợp lệ.".into());
    }
    keyring::Entry::new(SERVICE, key).map_err(|_| "Không mở được kho lưu phiên bảo mật.".into())
}

fn read(entry: &keyring::Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Không đọc được phiên đăng nhập đã lưu.".into()),
    }
}

fn remove(entry: &keyring::Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Không xóa được phiên đăng nhập đã lưu.".into()),
    }
}

fn auth_storage_get_blocking(key: String) -> Result<Option<String>, String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Không đọc được kho lưu phiên.".to_string())?;
    read(&entry(&key)?)
}

fn auth_storage_set_blocking(key: String, value: String) -> Result<(), String> {
    if value.len() > 65536 { return Err("Dữ liệu phiên vượt giới hạn.".into()); }
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Không ghi được kho lưu phiên.".to_string())?;
    entry(&key)?.set_password(&value).map_err(|_| "Không lưu được phiên đăng nhập bảo mật.".into())
}

fn auth_storage_remove_blocking(key: String) -> Result<(), String> {
    let _lock = STORAGE_LOCK.lock().map_err(|_| "Không xóa được kho lưu phiên.".to_string())?;
    remove(&entry(&key)?)
}

// OS credential access may wait for a permission prompt; keep the UI responsive.
#[tauri::command]
pub async fn auth_storage_get(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || auth_storage_get_blocking(key)).await
        .map_err(|_| "Không đọc được kho lưu phiên.".to_string())?
}
#[tauri::command]
pub async fn auth_storage_set(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || auth_storage_set_blocking(key, value)).await
        .map_err(|_| "Không ghi được kho lưu phiên.".to_string())?
}
#[tauri::command]
pub async fn auth_storage_remove(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || auth_storage_remove_blocking(key)).await
        .map_err(|_| "Không xóa được kho lưu phiên.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_session_and_repeated_logout_are_normal() {
        let credential = keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        assert_eq!(read(&credential).unwrap(), None);
        credential.set_password("test-session").unwrap();
        assert_eq!(read(&credential).unwrap().as_deref(), Some("test-session"));
        remove(&credential).unwrap();
        remove(&credential).unwrap();
        assert_eq!(read(&credential).unwrap(), None);
    }

    #[test]
    fn unrelated_credential_names_are_rejected() {
        assert!(entry("other-app-secret").is_err());
        assert!(entry("sb-unsafe/path").is_err());
    }

    #[test]
    #[ignore = "Writes a temporary test credential to the real OS keystore"]
    fn native_keystore_process_worker() {
        let Ok(key) = std::env::var("FARMOS_AUTH_TEST_KEY") else { return; };
        auth_storage_set_blocking(key, "farmos-temporary-persistence-test".into()).unwrap();
    }

    #[test]
    #[ignore = "Verifies real OS keystore persistence across process exit"]
    fn native_keystore_survives_process_restart() {
        let key = format!("sb-farmos-persistence-test-{}", std::process::id());
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "auth_storage::tests::native_keystore_process_worker", "--ignored"])
            .env("FARMOS_AUTH_TEST_KEY", &key).status().unwrap();
        let value = auth_storage_get_blocking(key.clone());
        let cleanup = auth_storage_remove_blocking(key.clone());
        assert!(result.success());
        assert_eq!(value.unwrap().as_deref(), Some("farmos-temporary-persistence-test"));
        cleanup.unwrap();
        assert_eq!(auth_storage_get_blocking(key).unwrap(), None);
    }
}
