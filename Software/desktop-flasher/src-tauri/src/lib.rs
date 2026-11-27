use crc32fast::Hasher as Crc32;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, env, fs, io::{Read, Write}, net::TcpListener, path::{Path, PathBuf}, process::Command, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager};

mod logo;
mod auth_storage;
use logo::LOGO_BASE64;

const API_ROOT: &str = "https://farmos.trendhub.sbs/api/v1";
const FRAME_SYNC: [u8; 2] = [0x46, 0x4f];
const FRAME_VERSION: u8 = 1;
const MAX_SERIAL_PAYLOAD: usize = 2048;
const SERIAL_READ_TIMEOUT: &str = "Serial enrollment timeout: không nhận được FO frame từ firmware.";

#[derive(Serialize)] #[serde(rename_all = "camelCase")]
struct NativeToolchain { platformio_home: Option<String>, pio_path: Option<String>, python_path: Option<String>, esptool_path: Option<String>, ready: bool, message: String }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
struct NativePort { path: String, label: String, kind: String, vid: Option<String>, pid: Option<String> }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
struct BoardProbe { ok: bool, output: String, chip: Option<String>, mac: Option<String> }
#[derive(Clone, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
struct DesktopAccount { id: String, email: String, name: Option<String>, avatar_url: Option<String>, role: String }
#[derive(Clone, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
struct DesktopImage {
  id: String,
  name: String,
  #[serde(default)]
  file_name: Option<String>,
  #[serde(default)]
  address: Option<u64>,
  #[serde(default)]
  size_bytes: u64,
  #[serde(default)]
  sha256: String,
  #[serde(default)]
  role: String,
}

#[derive(Clone, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
struct DesktopRelease {
  id: String,
  version: String,
  device_type: String,
  ota_status: String,
  flash_status: String,
  factory_ready: bool,
  updated_at: String,
  #[serde(default)]
  created_at: Option<String>,
  #[serde(default)]
  changelog: Option<String>,
  #[serde(default)]
  firmware_target: Option<String>,
  #[serde(default)]
  artifact_file_name: Option<String>,
  #[serde(default)]
  artifact_sha256: Option<String>,
  #[serde(default)]
  images: Vec<DesktopImage>,
}

#[derive(Serialize)] #[serde(rename_all = "camelCase")]
struct NativeFileInfo {
  path: String,
  name: String,
  size_bytes: u64,
}

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct NativeFlashRequest {
  port: String,
  target_type: String,
  chip_family: String,
  mac_address: String,
  release_id: String,
  expected_device_id: Option<String>,
}

#[tauri::command]
async fn inspect_board_for_flash(chip_family: String, mac_address: String, target_type: String, release_id: String, state: tauri::State<'_, DesktopSession>) -> Result<Value, String> {
  let token = header_token(&state)?;
  let body = json!({ "chipFamily": chip_family, "factoryEfuseMac": mac_address, "targetType": target_type, "releaseId": release_id });
  api_json(&reqwest::Client::new(), &token, reqwest::Method::POST, "/flash/boards/inspect",
    Some(body), None).await
}

#[tauri::command]
async fn verify_flash_identity(device_id: String, state: tauri::State<'_, DesktopSession>) -> Result<Value, String> {
  if device_id.trim().is_empty() { return Err("Thiếu mã thiết bị để kiểm tra kho.".to_string()); }
  let token = header_token(&state)?;
  let inventory = api_json(&reqwest::Client::new(), &token, reqwest::Method::GET, "/admin/devices", None, None).await?;
  let rows = inventory.as_array().ok_or("FarmOS không trả kho thiết bị hợp lệ.")?;
  let row = rows.iter().find(|item| item.get("deviceId").and_then(Value::as_str) == Some(device_id.as_str()));
  Ok(json!({
    "found": row.is_some(),
    "identityState": row.and_then(|item| item.get("identityState")).cloned().unwrap_or(Value::Null),
    "online": row.and_then(|item| item.get("node")).and_then(|node| node.get("online")).and_then(Value::as_bool).unwrap_or(false),
    "lastSeen": row.and_then(|item| item.get("node")).and_then(|node| node.get("lastSeen")).cloned().unwrap_or(Value::Null),
  }))
}

#[tauri::command]
async fn repurpose_board_for_flash(board_id: String, expected_device_id: String, target_type: String, reason: String, state: tauri::State<'_, DesktopSession>) -> Result<Value, String> {
  if board_id.trim().is_empty() || expected_device_id.trim().is_empty() { return Err("Thiếu định danh board hoặc thiết bị cũ.".to_string()); }
  let token = header_token(&state)?;
  api_json(&reqwest::Client::new(), &token, reqwest::Method::POST,
    &format!("/flash/boards/{board_id}/repurpose"),
    Some(json!({ "expectedDeviceId": expected_device_id, "targetType": target_type, "reason": reason })),
    Some(&now_id("desktop-repurpose"))).await
}

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
struct NativeReleaseUpload {
  app: String,
  bootloader: Option<String>,
  partition_table: Option<String>,
  ota_data: Option<String>,
  device_type: Option<String>,
  changelog: Option<String>,
}
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
struct NativeFlashResult { job_id: String, status: String, logs: Vec<String>, device_id: Option<String>, qr_id: Option<String>, qr_payload: Option<Value>, new_identity: bool }
#[derive(Default)] struct DesktopSession(Mutex<Option<String>>);
#[derive(Default)] struct OAuthCancelSignal(Arc<AtomicBool>);

struct SerialMonitorSession {
  port_name: String,
  stop_signal: Arc<AtomicBool>,
  writer: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
}
#[derive(Default, Clone)]
struct SerialMonitorState(Arc<Mutex<Option<SerialMonitorSession>>>);

fn api_url(path: &str) -> String { format!("{API_ROOT}{path}") }
fn now_id(prefix: &str) -> String { format!("{prefix}-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()) }
fn api_error(status: reqwest::StatusCode, body: &str) -> String { serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("error").or_else(|| v.get("message")).and_then(Value::as_str).map(String::from)).unwrap_or_else(|| format!("FarmOS API lỗi ({status})")) }
fn data_of(value: Value) -> Value { value.get("data").cloned().unwrap_or(value) }
fn sha256_hex(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn required_string(value: &Value, name: &str) -> Result<String, String> { value.as_str().filter(|text| !text.trim().is_empty()).map(|text| text.trim().to_string()).ok_or_else(|| format!("FarmOS response thiếu {name}.")) }
fn header_token(state: &DesktopSession) -> Result<String, String> { state.0.lock().map_err(|_| "Không thể đọc phiên native.".to_string())?.clone().ok_or("Vui lòng đăng nhập Google bằng tài khoản ADMIN.".to_string()) }

async fn api_json(client: &reqwest::Client, token: &str, method: reqwest::Method, path: &str, body: Option<Value>, idempotency: Option<&str>) -> Result<Value, String> {
  let mut request = client.request(method.clone(), api_url(path)).bearer_auth(token);
  if method != reqwest::Method::GET { request = request.header("Idempotency-Key", idempotency.unwrap_or("desktop-flasher")); }
  if let Some(body) = body { request = request.json(&body); }
  let response = request.send().await.map_err(|error| format!("Không kết nối được FarmOS API: {error}"))?;
  let status = response.status(); let text = response.text().await.map_err(|error| error.to_string())?;
  if !status.is_success() { return Err(api_error(status, &text)); }
  serde_json::from_str::<Value>(&text).map(data_of).map_err(|_| "FarmOS API trả JSON không hợp lệ.".to_string())
}

#[tauri::command]
async fn create_mobile_session(access_token: String, state: tauri::State<'_, DesktopSession>) -> Result<DesktopAccount, String> {
  if access_token.is_empty() || access_token.len() > 8192 { return Err("Access token không hợp lệ.".to_string()); }
  let response = reqwest::Client::new().post(api_url("/auth/mobile/session")).timeout(Duration::from_secs(15)).json(&json!({ "accessToken": access_token })).send().await.map_err(|error| format!("Không kết nối được FarmOS API: {error}"))?;
  let status = response.status(); let body = response.text().await.map_err(|error| error.to_string())?; if !status.is_success() { return Err(api_error(status, &body)); }
  let payload = data_of(serde_json::from_str(&body).map_err(|_| "FarmOS trả về dữ liệu đăng nhập không hợp lệ.".to_string())?);
  let bearer = required_string(payload.get("accessToken").unwrap_or(&Value::Null), "mobile access token")?;
  let account: DesktopAccount = serde_json::from_value(payload.get("user").cloned().ok_or("FarmOS không trả hồ sơ người dùng.")?).map_err(|_| "Hồ sơ FarmOS không hợp lệ.")?;
  if account.role != "ADMIN" { return Err("Tài khoản không có quyền ADMIN.".to_string()); }
  *state.0.lock().map_err(|_| "Không thể lưu phiên native.")? = Some(bearer); Ok(account)
}
#[tauri::command]
fn clear_mobile_session(state: tauri::State<'_, DesktopSession>) -> Result<(), String> { *state.0.lock().map_err(|_| "Không thể xóa phiên native.")? = None; Ok(()) }

#[tauri::command]
fn cancel_oauth_callback(cancel_state: tauri::State<'_, OAuthCancelSignal>) -> Result<(), String> {
  cancel_state.0.store(true, Ordering::SeqCst);
  Ok(())
}

#[tauri::command]
async fn wait_for_oauth_callback(lang: Option<String>, cancel_state: tauri::State<'_, OAuthCancelSignal>) -> Result<String, String> {
  let cancel_flag = cancel_state.0.clone();
  cancel_flag.store(false, Ordering::SeqCst);

  tauri::async_runtime::spawn_blocking(move || {
    let mut listener = None;
    for _ in 0..6 {
      if cancel_flag.load(Ordering::SeqCst) {
        return Err("Đã hủy đăng nhập.".to_string());
      }
      match TcpListener::bind(("127.0.0.1", 17846)) {
        Ok(l) => {
          listener = Some(l);
          break;
        }
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
          std::thread::sleep(Duration::from_millis(80));
        }
        Err(err) => return Err(format!("Không mở được callback đăng nhập nội bộ: {err}")),
      }
    }

    let listener = match listener {
      Some(l) => l,
      None => return Err("Cổng đăng nhập nội bộ 127.0.0.1:17846 đang được ứng dụng khác sử dụng. Hãy đóng phiên FarmOS Flasher cũ rồi thử lại.".to_string()),
    };
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;

    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
      if cancel_flag.load(Ordering::SeqCst) {
        return Err("Đã hủy đăng nhập.".to_string());
      }
      let (mut stream, _) = match listener.accept() {
        Ok(connection) => connection,
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
          std::thread::sleep(Duration::from_millis(40));
          continue;
        }
        Err(error) => return Err(format!("Không nhận được callback đăng nhập: {error}")),
      };
      stream.set_read_timeout(Some(Duration::from_secs(2))).ok();
      let mut request = [0u8; 8192];
      let read = stream.read(&mut request).map_err(|error| format!("Không đọc được callback đăng nhập: {error}"))?;
      let request = String::from_utf8_lossy(&request[..read]);
      let target = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("");

      if target.starts_with("/favicon") {
        let not_found = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        stream.write_all(not_found.as_bytes()).ok();
        stream.flush().ok();
        continue;
      }

      let parsed = url::Url::parse(&format!("http://127.0.0.1{target}"));
      let code = parsed.as_ref().ok().filter(|url| url.path() == "/auth/callback").and_then(|url| url.query_pairs().find_map(|(key, value)| (key == "code").then(|| value.into_owned())));
      let oauth_error = parsed.as_ref().ok().filter(|url| url.path() == "/auth/callback").and_then(|url| url.query_pairs().find_map(|(key, value)| (key == "error_description" || key == "error").then(|| value.into_owned())));
      let success = code.as_ref().is_some_and(|value| !value.is_empty());

      let query_lang = parsed.as_ref().ok().and_then(|url| url.query_pairs().find_map(|(key, value)| (key == "lang").then(|| value.into_owned())));
      let header_is_en = request.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("accept-language:") && lower.contains("en") && !lower.contains("vi")
      });
      let initial_lang = query_lang
        .or_else(|| lang.clone())
        .unwrap_or_else(|| if header_is_en { "en".to_string() } else { "vi".to_string() });
      let is_en = initial_lang == "en";

      let initial_title = if is_en {
        if success { "Sign-in Successful" } else { "Sign-in Incomplete" }
      } else {
        if success { "Đăng nhập thành công" } else { "Đăng nhập chưa hoàn tất" }
      };

      let initial_detail = if is_en {
        if success { "You can close this tab and return to FarmOS." } else { "FarmOS did not receive authentication code. Please return to the app and try again." }
      } else {
        if success { "Bạn có thể đóng tab này và quay lại ứng dụng FarmOS." } else { "FarmOS không nhận được mã xác thực. Hãy quay lại ứng dụng và thử lại." }
      };

      let initial_badge = if is_en {
        if success { "✓ Verified Successfully" } else { "✕ Sign-in Incomplete" }
      } else {
        if success { "✓ Xác thực hoàn tất" } else { "✕ Đăng nhập thất bại" }
      };

      let initial_switch = if is_en { "VI" } else { "EN" };
      let status_class = if success { "success" } else { "error" };

      let html = format!(r#"<!doctype html>
<html lang="{initial_lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FarmOS — {initial_title}</title>
<style>
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: #ffffff;
  color: #0f172a;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
}}
main {{
  position: relative;
  width: 100%;
  max-width: 440px;
  padding: 44px 34px 38px;
  border: 1px solid #e2e8f0;
  border-radius: 28px;
  background: #ffffff;
  box-shadow: 0 20px 45px -10px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(16, 185, 129, 0.12);
  text-align: center;
}}
.lang-switcher {{
  position: absolute;
  top: 18px;
  right: 18px;
}}
.lang-btn {{
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  color: #0f172a;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s ease;
}}
.lang-btn:hover {{
  background: #f1f5f9;
  border-color: #cbd5e1;
  transform: translateY(-1px);
}}
.logo {{
  width: 68px;
  height: 68px;
  object-fit: contain;
  margin-bottom: 10px;
  filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.06));
}}
.brand-name {{
  font-size: 16px;
  font-weight: 800;
  color: #0f172a;
  margin-bottom: 16px;
  letter-spacing: -0.02em;
}}
.status-badge {{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.03em;
  margin-bottom: 16px;
}}
.status-badge.success {{
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  color: #047857;
}}
.status-badge.error {{
  background: #fff1f2;
  border: 1px solid #fecdd3;
  color: #be123c;
}}
h1 {{
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: #0f172a;
  margin-bottom: 8px;
}}
p {{
  font-size: 14px;
  line-height: 1.6;
  color: #64748b;
}}
</style>
</head>
<body>
<main>
  <div class="lang-switcher">
    <button type="button" class="lang-btn" onclick="toggleLang()">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><path d="M2 12h20"/></svg>
      <span id="lang-indicator">{initial_switch}</span>
    </button>
  </div>
  <img src="data:image/png;base64,{LOGO_BASE64}" class="logo" alt="FarmOS">
  <div class="brand-name">FarmOS</div>
  <div>
    <span id="status-badge" class="status-badge {status_class}">{initial_badge}</span>
  </div>
  <h1 id="title-text">{initial_title}</h1>
  <p id="detail-text">{initial_detail}</p>
</main>
<script>
(function() {{
  var isSuccess = {success};
  var texts = {{
    vi: {{
      badge: isSuccess ? "✓ Xác thực hoàn tất" : "✕ Đăng nhập thất bại",
      title: isSuccess ? "Đăng nhập thành công" : "Đăng nhập chưa hoàn tất",
      detail: isSuccess ? "Bạn có thể đóng tab này và quay lại ứng dụng FarmOS." : "FarmOS không nhận được mã xác thực. Hãy quay lại ứng dụng và thử lại.",
      switchLabel: "EN"
    }},
    en: {{
      badge: isSuccess ? "✓ Verified Successfully" : "✕ Sign-in Incomplete",
      title: isSuccess ? "Sign-in Successful" : "Sign-in Incomplete",
      detail: isSuccess ? "You can close this tab and return to FarmOS." : "FarmOS did not receive authentication code. Please return to the app and try again.",
      switchLabel: "VI"
    }}
  }};

  var curLang = "{initial_lang}";
  try {{
    var saved = localStorage.getItem("farmos_lang");
    if (saved === "vi" || saved === "en") {{ curLang = saved; }}
  }} catch(e) {{}}

  function updateUI() {{
    var t = texts[curLang] || texts.vi;
    document.documentElement.lang = curLang;
    document.title = "FarmOS — " + t.title;
    document.getElementById("status-badge").innerText = t.badge;
    document.getElementById("title-text").innerText = t.title;
    document.getElementById("detail-text").innerText = t.detail;
    document.getElementById("lang-indicator").innerText = t.switchLabel;
  }}

  window.toggleLang = function() {{
    curLang = curLang === "vi" ? "en" : "vi";
    try {{ localStorage.setItem("farmos_lang", curLang); }} catch(e) {{}}
    updateUI();
  }};

  updateUI();
  if (isSuccess) {{
    setTimeout(function() {{
      try {{ window.close(); }} catch(e) {{}}
    }}, 1500);
  }}
}})();
</script>
</body>
</html>"#);
      let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{}", html.len(), html);
      stream.write_all(response.as_bytes()).ok();
      stream.flush().ok();
      if let Some(code) = code.filter(|value| !value.is_empty()) { return Ok(code); }
      if let Some(error) = oauth_error { return Err(format!("Google từ chối đăng nhập: {error}")); }
    }
    Err("Đăng nhập Google quá thời gian chờ.".to_string())
  }).await.map_err(|error| error.to_string())?
}
#[tauri::command]
async fn list_desktop_releases(state: tauri::State<'_, DesktopSession>) -> Result<Vec<DesktopRelease>, String> {
  let token = header_token(&state)?; let payload = api_json(&reqwest::Client::new(), &token, reqwest::Method::GET, "/admin/firmware/releases", None, None).await?;
  let list = payload.as_array().or_else(|| payload.get("releases").and_then(Value::as_array)).ok_or("FarmOS không trả danh sách firmware.")?;
  list.iter().map(|value| serde_json::from_value(value.clone()).map_err(|_| "Firmware release không hợp lệ.".to_string())).collect()
}

fn write_qr_png(path: &Path, bytes: &[u8]) -> Result<(), String> {
  if !path.is_absolute() || path.extension().and_then(|x| x.to_str()).is_none_or(|x| !x.eq_ignore_ascii_case("png"))
    || !(8..=1_048_576).contains(&bytes.len()) || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    return Err("Đường dẫn hoặc ảnh QR PNG không hợp lệ.".into());
  }
  if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file()) {
    return Err("Không lưu QR vào đường dẫn đặc biệt.".into());
  }
  fs::write(path, bytes).map_err(|_| "Không lưu được ảnh QR PNG vào vị trí đã chọn.".into())
}

#[tauri::command]
async fn save_qr_png(path: String, bytes: Vec<u8>) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || write_qr_png(Path::new(&path), &bytes)).await
    .map_err(|_| "Không lưu được ảnh QR PNG.".to_string())?
}

#[tauri::command]
async fn list_desktop_nodes(state: tauri::State<'_, DesktopSession>) -> Result<Value, String> {
  let token = header_token(&state)?;
  let payload = api_json(&reqwest::Client::new(), &token, reqwest::Method::GET, "/nodes", None, None).await?;
  Ok(payload)
}

#[tauri::command]
async fn get_desktop_node_qr(node_id: String, state: tauri::State<'_, DesktopSession>) -> Result<Value, String> {
  if node_id.trim().is_empty() || node_id.len() > 128 { return Err("Mã thiết bị không hợp lệ.".into()); }
  let token = header_token(&state)?;
  let mut url = reqwest::Url::parse("https://local/").map_err(|_| "Đường dẫn QR không hợp lệ.")?;
  url.path_segments_mut().map_err(|_| "Đường dẫn QR không hợp lệ.")?.push("nodes").push(&node_id).push("qr");
  api_json(&reqwest::Client::new(), &token, reqwest::Method::GET, url.path(), None, None).await
}

#[tauri::command]
async fn unbind_desktop_node(node_id: String, state: tauri::State<'_, DesktopSession>) -> Result<Value, String> {
  let token = header_token(&state)?;
  let payload = api_json(&reqwest::Client::new(), &token, reqwest::Method::POST, &format!("/nodes/{node_id}/unbind"), None, None).await?;
  Ok(payload)
}

#[tauri::command]
async fn delete_desktop_node(node_id: String, state: tauri::State<'_, DesktopSession>) -> Result<Value, String> {
  let token = header_token(&state)?;
  let payload = api_json(&reqwest::Client::new(), &token, reqwest::Method::DELETE, &format!("/nodes/{node_id}"), None, None).await?;
  Ok(payload)
}

#[tauri::command]
fn start_serial_monitor(
  port: String,
  baud_rate: u32,
  app: tauri::AppHandle,
  state: tauri::State<'_, SerialMonitorState>,
) -> Result<(), String> {
  {
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = current.take() {
      session.stop_signal.store(true, Ordering::Relaxed);
    }
  }

  if !allowed_port(&port) || !Path::new(&port).exists() {
    return Err("Cổng serial không hợp lệ hoặc không còn tồn tại.".to_string());
  }

  let port_obj = serialport::new(&port, baud_rate)
    .timeout(Duration::from_millis(50))
    .open()
    .map_err(|e| format!("Không mở được cổng {port}: {e}"))?;

  let mut reader = port_obj
    .try_clone()
    .map_err(|e| format!("Không thể clone cổng serial: {e}"))?;

  let stop_signal = Arc::new(AtomicBool::new(false));
  let writer = Arc::new(Mutex::new(port_obj));

  *state.0.lock().map_err(|e| e.to_string())? = Some(SerialMonitorSession {
    port_name: port.clone(),
    stop_signal: stop_signal.clone(),
    writer,
  });

  let app_clone = app.clone();
  let stop_clone = stop_signal;
  let port_clone = port.clone();

  std::thread::spawn(move || {
    let mut buf = [0u8; 1024];
    while !stop_clone.load(Ordering::Relaxed) {
      match reader.read(&mut buf) {
        Ok(n) if n > 0 => {
          let text = String::from_utf8_lossy(&buf[..n]).to_string();
          let _ = app_clone.emit("serial-data", text);
        }
        Ok(_) => {}
        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
        Err(e) => {
          if !stop_clone.load(Ordering::Relaxed) {
            let _ = app_clone.emit(
              "serial-status",
              json!({
                "connected": false,
                "port": port_clone,
                "error": format!("Mất kết nối cổng: {e}")
              }),
            );
          }
          break;
        }
      }
    }
  });

  let _ = app.emit(
    "serial-status",
    json!({
      "connected": true,
      "port": port,
      "baudRate": baud_rate
    }),
  );

  Ok(())
}

#[tauri::command]
fn stop_serial_monitor(
  state: tauri::State<'_, SerialMonitorState>,
  app: tauri::AppHandle,
) -> Result<(), String> {
  let mut current = state.0.lock().map_err(|e| e.to_string())?;
  if let Some(session) = current.take() {
    session.stop_signal.store(true, Ordering::Relaxed);
    let _ = app.emit(
      "serial-status",
      json!({
        "connected": false,
        "port": session.port_name
      }),
    );
  }
  Ok(())
}

#[tauri::command]
fn send_serial_data(
  data: String,
  state: tauri::State<'_, SerialMonitorState>,
) -> Result<(), String> {
  let session_opt = state.0.lock().map_err(|e| e.to_string())?;
  let session = session_opt.as_ref().ok_or("Serial Monitor chưa kết nối.")?;
  let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
  writer
    .write_all(data.as_bytes())
    .map_err(|e| format!("Lỗi gửi dữ liệu serial: {e}"))?;
  writer
    .flush()
    .map_err(|e| format!("Lỗi flush serial: {e}"))?;
  Ok(())
}

#[tauri::command]
fn reset_esp32_device(
  port: Option<String>,
  state: tauri::State<'_, SerialMonitorState>,
) -> Result<(), String> {
  let session_opt = state.0.lock().map_err(|e| e.to_string())?;
  if let Some(session) = session_opt.as_ref() {
    let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
    let _ = writer.write_data_terminal_ready(false);
    let _ = writer.write_request_to_send(true);
    std::thread::sleep(Duration::from_millis(150));
    let _ = writer.write_request_to_send(false);
    let _ = writer.write_data_terminal_ready(false);
    return Ok(());
  }
  if let Some(port_path) = port {
    if allowed_port(&port_path) && Path::new(&port_path).exists() {
      if let Ok(mut p) = serialport::new(&port_path, 115_200)
        .timeout(Duration::from_millis(100))
        .open()
      {
        let _ = p.write_data_terminal_ready(false);
        let _ = p.write_request_to_send(true);
        std::thread::sleep(Duration::from_millis(150));
        let _ = p.write_request_to_send(false);
        let _ = p.write_data_terminal_ready(false);
        return Ok(());
      }
    }
  }
  Err("Không có cổng serial nào đang mở để reset.".to_string())
}

fn firmware_part(path: &str) -> Result<reqwest::multipart::Part, String> {
  let source = Path::new(path);
  let metadata = fs::metadata(source).map_err(|_| "Không đọc được firmware file đã chọn.".to_string())?;
  if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 64 * 1024 * 1024 { return Err("Firmware file phải là file hợp lệ, không rỗng và tối đa 64 MB.".to_string()); }
  let name = source.file_name().and_then(|item| item.to_str()).filter(|item| item.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))).ok_or("Tên firmware file không hợp lệ.")?;
  let bytes = fs::read(source).map_err(|_| "Không thể đọc firmware file.".to_string())?;
  reqwest::multipart::Part::bytes(bytes).file_name(name.to_string()).mime_str("application/octet-stream").map_err(|error| error.to_string())
}

#[tauri::command]
fn inspect_local_file(path: String) -> Result<NativeFileInfo, String> {
  let source = Path::new(&path);
  let metadata = fs::metadata(source).map_err(|error| format!("Không đọc được file {path}: {error}"))?;
  if !metadata.is_file() {
    return Err(format!("{path} không phải là file hợp lệ."));
  }
  let name = source.file_name().and_then(|item| item.to_str()).unwrap_or("unknown").to_string();
  Ok(NativeFileInfo {
    path,
    name,
    size_bytes: metadata.len(),
  })
}

#[tauri::command]
async fn upload_desktop_release(upload: NativeReleaseUpload, state: tauri::State<'_, DesktopSession>) -> Result<DesktopRelease, String> {
  let token = header_token(&state)?;
  let mut form = reqwest::multipart::Form::new().part("app", firmware_part(&upload.app)?);
  if let Some(device_type) = upload.device_type.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    if device_type != "GATEWAY" && device_type != "SENSOR_NODE" {
      return Err("Loại firmware không hợp lệ.".to_string());
    }
    form = form.text("deviceType", device_type.to_string());
  }
  if let Some(path) = upload.bootloader.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    form = form.part("bootloader", firmware_part(path)?);
  }
  if let Some(path) = upload.partition_table.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    form = form.part("partitionTable", firmware_part(path)?);
  }
  if let Some(path) = upload.ota_data.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    form = form.part("otaData", firmware_part(path)?);
  }
  if let Some(changelog) = upload.changelog.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    form = form.text("changelog", changelog.to_string());
  }
  let response = reqwest::Client::new()
    .post(api_url("/admin/firmware/releases"))
    .bearer_auth(token)
    .header("Idempotency-Key", now_id("desktop-upload"))
    .multipart(form)
    .send()
    .await
    .map_err(|error| format!("Không tải được firmware lên FarmOS: {error}"))?;
  let status = response.status();
  let text = response.text().await.map_err(|error| error.to_string())?;
  if !status.is_success() {
    return Err(api_error(status, &text));
  }
  let data = data_of(serde_json::from_str::<Value>(&text).map_err(|_| "FarmOS trả JSON upload không hợp lệ.".to_string())?);
  let release = data.get("release").cloned().unwrap_or(data);
  serde_json::from_value(release).map_err(|_| "FarmOS trả release upload không hợp lệ.".to_string())
}

#[tauri::command]
async fn update_desktop_release_status(release_id: String, channel: String, status: String, state: tauri::State<'_, DesktopSession>) -> Result<DesktopRelease, String> {
  let token = header_token(&state)?;
  let body = serde_json::json!({
    "channel": channel,
    "status": status,
    "rolloutPercent": 100
  });
  let payload = api_json(&reqwest::Client::new(), &token, reqwest::Method::PATCH, &format!("/admin/firmware/releases/{release_id}"), Some(body), None).await?;
  let release = payload.get("release").cloned().unwrap_or(payload);
  serde_json::from_value(release).map_err(|_| "FarmOS trả release cập nhật không hợp lệ.".to_string())
}

#[tauri::command]
async fn delete_desktop_release(release_id: String, state: tauri::State<'_, DesktopSession>) -> Result<(), String> {
  let token = header_token(&state)?;
  let response = reqwest::Client::new()
    .delete(api_url(&format!("/admin/firmware/releases/{release_id}")))
    .bearer_auth(token)
    .send()
    .await
    .map_err(|error| format!("Không thể xóa firmware: {error}"))?;
  let status = response.status();
  if status == reqwest::StatusCode::NO_CONTENT || status.is_success() {
    Ok(())
  } else {
    let text = response.text().await.unwrap_or_default();
    Err(api_error(status, &text))
  }
}

#[tauri::command]
async fn download_desktop_artifact(release_id: String, image_id: Option<String>, save_path: String, state: tauri::State<'_, DesktopSession>) -> Result<(), String> {
  let token = header_token(&state)?;
  let query = image_id.as_deref().map(|id| format!("?imageId={id}")).unwrap_or_default();
  let url = api_url(&format!("/admin/firmware/releases/{release_id}/download{query}"));
  let response = reqwest::Client::new()
    .get(&url)
    .bearer_auth(token)
    .send()
    .await
    .map_err(|error| format!("Không thể tải file firmware: {error}"))?;
  let status = response.status();
  if !status.is_success() {
    let text = response.text().await.unwrap_or_default();
    return Err(api_error(status, &text));
  }
  let bytes = response.bytes().await.map_err(|error| format!("Lỗi đọc dữ liệu tải về: {error}"))?;
  fs::write(&save_path, bytes).map_err(|error| format!("Không thể lưu file vào {save_path}: {error}"))?;
  Ok(())
}

fn platformio_home() -> Option<PathBuf> { env::var_os("PLATFORMIO_CORE_DIR").map(PathBuf::from).or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".platformio"))) }
fn executable(path: PathBuf) -> Option<PathBuf> { path.is_file().then_some(path) }
fn bundled_esptool(app: &tauri::AppHandle) -> Option<PathBuf> { app.path().resource_dir().ok().and_then(|root| executable(root.join("resources/tools/esptool/farmos-esptool"))) }
fn find_tools() -> (Option<PathBuf>, Option<PathBuf>, Option<PathBuf>, Option<PathBuf>) { let home = platformio_home(); let pio = home.as_ref().and_then(|base| executable(base.join("penv/bin/pio"))); let python = home.as_ref().and_then(|base| executable(base.join("penv/bin/python"))); let esptool = home.as_ref().and_then(|base| executable(base.join("packages/tool-esptoolpy/esptool.py"))); (home, pio, python, esptool) }
fn string_path(path: &Option<PathBuf>) -> Option<String> { path.as_ref().map(|item| item.display().to_string()) }
#[tauri::command]
fn native_toolchain_status(app: tauri::AppHandle) -> NativeToolchain {
  let (home, pio, python, esptool) = find_tools(); let bundled = bundled_esptool(&app); let ready = bundled.is_some() || (python.is_some() && esptool.is_some());
  let message = if bundled.is_some() { "Bộ nạp native đã được đóng gói trong ứng dụng.".to_string() } else if ready { "Đang dùng esptool.py từ PlatformIO cài trên máy (chế độ development).".to_string() } else { "Bản development cần PlatformIO; bộ cài production dùng native flasher đóng gói.".to_string() };
  NativeToolchain { platformio_home: string_path(&home), pio_path: string_path(&pio), python_path: string_path(&python), esptool_path: string_path(&bundled).or_else(|| string_path(&esptool)), ready, message }
}
fn usb_serial_name(name: &str) -> bool {
  let value = name.to_ascii_lowercase();
  ["usb", "wch", "slab", "uart", "serial", "modem", "acm"].iter().any(|needle| value.contains(needle))
}
fn serial_candidates() -> Vec<PathBuf> {
  let Ok(entries) = fs::read_dir("/dev") else { return Vec::new(); };
  entries.filter_map(Result::ok).map(|entry| entry.path()).filter(|path| {
    path.file_name().and_then(|name| name.to_str()).is_some_and(|name| {
      #[cfg(target_os = "macos")] { name.starts_with("cu.") && usb_serial_name(name) }
      #[cfg(not(target_os = "macos"))] { usb_serial_name(name) }
    })
  }).collect()
}
#[tauri::command]
fn list_native_ports() -> Vec<NativePort> {
  // macOS can expose a valid USB CDC device in /dev before serialport returns
  // USB metadata for it. Start with the OS callout devices, then enrich them
  // with VID/PID and product information when serialport has that data.
  let mut ports: Vec<NativePort> = serial_candidates().into_iter().map(|path| {
    let value = path.display().to_string();
    NativePort { path: value.clone(), label: format!("USB Serial · {value}"), kind: "usb".to_string(), vid: None, pid: None }
  }).collect();
  let mut known: HashSet<String> = ports.iter().map(|port| port.path.clone()).collect();
  for port in serialport::available_ports().unwrap_or_default() {
    let serialport::SerialPortType::UsbPort(info) = port.port_type else { continue; };
    #[cfg(target_os = "macos")]
    let path = if port.port_name.starts_with("/dev/tty.") {
      port.port_name.replacen("/dev/tty.", "/dev/cu.", 1)
    } else {
      port.port_name.clone()
    };
    #[cfg(not(target_os = "macos"))]
    let path = port.port_name.clone();
    if !usb_serial_name(&path) { continue; }
    let product = info.product.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "USB Serial".to_string());
    let detailed = NativePort {
      path: path.clone(),
      label: format!("{product} · {path} · {:04x}:{:04x}", info.vid, info.pid),
      kind: "usb".to_string(),
      vid: Some(format!("{:04x}", info.vid)),
      pid: Some(format!("{:04x}", info.pid)),
    };
    if let Some(existing) = ports.iter_mut().find(|item| item.path == path) {
      *existing = detailed;
    } else if known.insert(path) {
      ports.push(detailed);
    }
  }
  ports.sort_by(|a, b| {
    let a_preferred = matches!((a.vid.as_deref(), a.pid.as_deref()), (Some("1a86"), Some("55d3")) | (Some("303a"), Some("4001")));
    let b_preferred = matches!((b.vid.as_deref(), b.pid.as_deref()), (Some("1a86"), Some("55d3")) | (Some("303a"), Some("4001")));
    b_preferred.cmp(&a_preferred).then_with(|| a.path.cmp(&b.path))
  });
  ports
}
fn allowed_port(port: &str) -> bool { #[cfg(target_os = "macos")] { port.starts_with("/dev/cu.") || port.starts_with("/dev/tty.") } #[cfg(target_os = "linux")] { port.starts_with("/dev/tty") } #[cfg(target_os = "windows")] { port.starts_with("COM") } }
fn capture_field(output: &str, prefix: &str) -> Option<String> { output.lines().find_map(|line| line.trim().strip_prefix(prefix).map(|value| value.trim().to_string())) }
fn tool_command(app: &tauri::AppHandle, port: &str, args: &[String]) -> Result<Command, String> {
  if !allowed_port(port) || !Path::new(port).exists() { return Err("Cổng serial không hợp lệ hoặc không còn tồn tại.".to_string()); }
  if let Some(tool) = bundled_esptool(app) { let mut command = Command::new(tool); command.args(args); return Ok(command); }
  let (_, _, python, esptool) = find_tools(); let python = python.ok_or("Không tìm thấy native flasher đóng gói. Bản development cần PlatformIO Core.")?; let esptool = esptool.ok_or("Không tìm thấy esptool.py PlatformIO development.")?;
  let mut command = Command::new(python); command.arg(esptool).args(args); Ok(command)
}
// Missing, contradictory or partially enabled security must never fall through
// to the ordinary plaintext path.
fn board_security(output: &str) -> Result<bool, String> {
  let enabled = |label: &str| -> Result<bool, String> {
    let values: Vec<_> = output.lines().filter_map(|line| line.trim().strip_prefix(label)).map(str::trim).collect();
    match values.as_slice() {
      ["Enabled"] => Ok(true),
      ["Disabled"] => Ok(false),
      _ => Err("Không xác định được trạng thái bảo mật board; dừng trước khi ghi flash.".into()),
    }
  };
  match (enabled("Secure Boot:")?, enabled("Flash Encryption:")?) {
    (false, false) => Ok(false),
    (true, true) => Ok(true),
    _ => Err("Flasher chỉ hỗ trợ board chưa khóa Secure Boot/Flash Encryption.".into()),
  }
}
#[tauri::command]
fn probe_esp32(port: String, app: tauri::AppHandle, serial_state: tauri::State<'_, SerialMonitorState>) -> Result<BoardProbe, String> {
  let _ = stop_serial_monitor(serial_state, app.clone());
  let security_args = vec!["--chip".into(), "auto".into(), "--port".into(), port.clone(), "--no-stub".into(), "get_security_info".into()];
  let security = tool_command(&app, &port, &security_args)?.output().map_err(|_| "Không đọc được trạng thái bảo mật board.".to_string())?;
  if !security.status.success() { return Err("Không xác minh được trạng thái bảo mật board.".to_string()); }
  let security_text = String::from_utf8_lossy(&security.stdout);
  let secured = board_security(&security_text)?;
  if secured {
    return Err("Flasher chỉ hỗ trợ ESP32-S3 chưa khóa Secure Boot/Flash Encryption. Hãy dùng board mới chưa khóa.".into());
  }
  let args = vec!["--chip".to_string(), "auto".to_string(), "--port".to_string(), port.clone(), "chip_id".to_string()];
  let result = tool_command(&app, &port, &args)?.output().map_err(|error| format!("Không thể chạy native flash tool: {error}"))?;
  let mut output = String::from_utf8_lossy(&result.stdout).to_string(); output.push_str(&String::from_utf8_lossy(&result.stderr));
  let chip = output.lines().find(|line| line.contains("ESP32")).map(|line| line.trim().to_string()); let mac = capture_field(&output, "MAC:");
  Ok(BoardProbe { ok: result.status.success(), output, chip, mac })
}

fn image_role(image: &Value) -> String { image.get("role").or_else(|| image.get("partition")).and_then(Value::as_str).unwrap_or("").to_ascii_uppercase() }
fn protected_range(address: u64, size: u64) -> bool { address < 0x630000 && address.saturating_add(size) > 0x620000 }
fn select_plan_images(manifest: &Value) -> Result<Vec<Value>, String> {
  if manifest.get("signed") != Some(&Value::Bool(true)) && manifest.get("signature").and_then(Value::as_str).filter(|value| !value.is_empty()).is_none() && manifest.get("manifestSignature").and_then(Value::as_str).filter(|value| !value.is_empty()).is_none() { return Err("Manifest chưa có chữ ký server hợp lệ.".to_string()); }
  let images = manifest.get("images").and_then(Value::as_array).ok_or("Manifest thiếu images.")?; let selected = manifest.get("selectedPlan").and_then(Value::as_object).ok_or("Manifest thiếu selectedPlan.")?;
  let steps = selected.get("steps").and_then(Value::as_array).ok_or("Manifest selectedPlan thiếu steps.")?; let ids = selected.get("imageIds").and_then(Value::as_array).ok_or("Manifest selectedPlan thiếu imageIds.")?;
  if steps.is_empty() || steps.len() != ids.len() { return Err("Manifest selectedPlan không nhất quán.".to_string()); }
  let mut output = Vec::new(); let mut seen = HashSet::new();
  for (index, step) in steps.iter().enumerate() { let expected_id = ids[index].as_str().ok_or("Manifest image id không hợp lệ.")?; let image = images.iter().find(|image| image.get("id").and_then(Value::as_str) == Some(expected_id)).ok_or("Write plan tham chiếu image không tồn tại.")?; let address = image.get("address").and_then(Value::as_u64).ok_or("Image thiếu address.")?; let size = image.get("sizeBytes").and_then(Value::as_u64).ok_or("Image thiếu sizeBytes.")?;
    if protected_range(address, size) || address.saturating_add(size) > 0x10000000 { return Err("Manifest chứa vùng flash bị bảo vệ hoặc không hợp lệ.".to_string()); }
    if step.get("address").and_then(Value::as_u64).is_some_and(|step_address| step_address != address) || !seen.insert(expected_id.to_string()) { return Err("Write plan không nhất quán với image được ký.".to_string()); } output.push(image.clone()); }
  let selector: Vec<_> = output.iter().enumerate().filter_map(|(index, image)| (image_role(image) == "OTA_DATA").then_some(index)).collect();
  if selector.len() != 1 || selector[0] != output.len() - 1 || !output.iter().take(output.len() - 1).any(|image| matches!(image_role(image).as_str(), "APP" | "OTA_0" | "OTA_1")) { return Err("Signed write plan phải ghi APP trước OTA_DATA selector cuối cùng.".to_string()); } Ok(output)
}

fn validate_identity_preserving_plan(manifest: &Value) -> Result<(), String> {
  if manifest.pointer("/selectedPlan/name").and_then(Value::as_str) != Some("NORMAL_REFLASH") {
    return Err("Server chưa cấp gói nạp lại giữ identity.".into());
  }
  let images = select_plan_images(manifest)?;
  let expected = [("APP", 0x20000, 0x300000), ("OTA_DATA", 0x19000, 0x2000)];
  if images.len() != expected.len() || images.iter().zip(expected).any(|(image, (role, offset, capacity))| {
    image_role(image) != role || image.get("address").and_then(Value::as_u64) != Some(offset) ||
      !image.get("sizeBytes").and_then(Value::as_u64).is_some_and(|size| (1..=capacity).contains(&size))
  }) {
    return Err("Gói nạp lại phải ghi đúng phân vùng APP rồi mới ghi OTA_DATA.".into());
  }
  Ok(())
}

// Only an admin-created job without a server identity may initialize factory_cfg.
fn initialize_factory_identity(job: &Value, manifest: &Value, files: &mut Vec<(u64, PathBuf)>) -> Result<bool, String> {
  if !job.get("sourceDeviceId").is_some_and(Value::is_null) { return Ok(false); }
  if manifest.pointer("/selectedPlan/name").and_then(Value::as_str) != Some("FACTORY_FULL_FLASH") ||
      files.last().map(|file| file.0) != Some(0x19000) ||
      !files.iter().any(|file| file.0 == 0x20000) {
    return Err("Khởi tạo danh tính cần kế hoạch xuất xưởng có APP và OTA selector cuối cùng.".into());
  }
  let blank = files.first().ok_or("Write plan rỗng.")?.1.parent().ok_or("Không có cache firmware.")?.join("factory-initial-enrollment.bin");
  fs::write(&blank, vec![0xff; 0x10000]).map_err(|_| "Không tạo được initial enrollment image.")?;
  let selector = files.pop().ok_or("Thiếu OTA selector.")?;
  files.push((0x620000, blank)); files.push(selector);
  Ok(true)
}

async fn download_images(client: &reqwest::Client, token: &str, job_id: &str, manifest: &Value, logs: &mut Vec<String>, app: &tauri::AppHandle) -> Result<Vec<(u64, PathBuf)>, String> {
  let images = select_plan_images(manifest)?; let cache = app.path().app_cache_dir().map_err(|error| error.to_string())?.join("flash-jobs").join(job_id); fs::create_dir_all(&cache).map_err(|error| error.to_string())?; let mut output = Vec::new();
  for image in images { let address = image.get("address").and_then(Value::as_u64).ok_or("Image thiếu address.")?; let name = required_string(image.get("name").unwrap_or(&Value::Null), "image name")?; if !name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')) { return Err("Tên image từ server không an toàn.".to_string()); }
    let url = required_string(image.get("downloadUrl").unwrap_or(&Value::Null), "image downloadUrl")?; let url = if url.starts_with('/') { format!("https://farmos.trendhub.sbs{url}") } else { url }; let response = client.get(url).bearer_auth(token).send().await.map_err(|error| format!("Không tải được image {name}: {error}"))?; let status = response.status(); let bytes = response.bytes().await.map_err(|error| error.to_string())?; if !status.is_success() { return Err(format!("Server từ chối image {name} ({status}).")); }
    let size = image.get("sizeBytes").and_then(Value::as_u64).ok_or("Image thiếu sizeBytes.")?; let hash = required_string(image.get("sha256").unwrap_or(&Value::Null), "image sha256")?.to_ascii_lowercase(); if bytes.len() as u64 != size || sha256_hex(&bytes) != hash { return Err(format!("Image {name} không khớp SHA-256/kích thước đã ký.")); }
    let file = cache.join(format!("{address:08x}-{name}")); fs::write(&file, bytes).map_err(|error| error.to_string())?; logs.push(format!("Đã xác minh SHA-256 image {name} tại 0x{address:x}.")); output.push((address, file)); }
  Ok(output)
}

fn write_frame(port: &mut dyn serialport::SerialPort, frame_type: u8, sequence: u32, payload: &Value) -> Result<(), String> {
  let body = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
  if body.is_empty() || body.len() > MAX_SERIAL_PAYLOAD { return Err("Serial enrollment payload vượt giới hạn 2048 bytes.".to_string()); }
  let mut frame = Vec::with_capacity(2 + 8 + body.len() + 4);
  frame.extend(FRAME_SYNC);
  frame.extend([FRAME_VERSION, frame_type]);
  frame.extend((body.len() as u16).to_be_bytes());
  frame.extend(sequence.to_be_bytes());
  frame.extend(&body);
  let mut crc = Crc32::new();
  crc.update(&frame[2..]);
  frame.extend(crc.finalize().to_be_bytes());
  // Firmware starts a two-second frame deadline at the sync bytes. A single
  // write matches Web Serial and prevents per-chunk flushes from expiring it.
  port.write_all(&frame).map_err(|error| format!("Không ghi được serial protocol: {error}"))?;
  port.flush().map_err(|error| format!("Không hoàn tất ghi serial protocol: {error}"))?;
  Ok(())
}

fn extract_frame(buffer: &mut Vec<u8>) -> Option<Result<(u8, Value), String>> {
  while buffer.len() >= 2 {
    let sync_pos = buffer.windows(2).position(|w| w == FRAME_SYNC);
    let Some(pos) = sync_pos else {
      if buffer.last() == Some(&FRAME_SYNC[0]) {
        *buffer = vec![FRAME_SYNC[0]];
      } else {
        buffer.clear();
      }
      return None;
    };
    if pos > 0 {
      buffer.drain(..pos);
    }
    if buffer.len() < 2 + 8 {
      return None;
    }
    let version = buffer[2];
    let frame_type = buffer[3];
    let payload_len = u16::from_be_bytes([buffer[4], buffer[5]]) as usize;
    if version != FRAME_VERSION || payload_len == 0 || payload_len > MAX_SERIAL_PAYLOAD {
      buffer.drain(..2);
      continue;
    }
    let total_len = 2 + 8 + payload_len + 4;
    if buffer.len() < total_len {
      return None;
    }
    let crc_input = &buffer[2..2 + 8 + payload_len];
    let supplied_crc = u32::from_be_bytes([
      buffer[2 + 8 + payload_len],
      buffer[2 + 8 + payload_len + 1],
      buffer[2 + 8 + payload_len + 2],
      buffer[2 + 8 + payload_len + 3],
    ]);
    let mut crc = Crc32::new();
    crc.update(crc_input);
    if crc.finalize() != supplied_crc {
      buffer.drain(..2);
      continue;
    }
    let payload_slice = &buffer[2 + 8..2 + 8 + payload_len];
    let parsed: Result<Value, _> = serde_json::from_slice(payload_slice);
    buffer.drain(..total_len);
    match parsed {
      Ok(val) => {
        if frame_type == 0x82 || val.get("op").and_then(Value::as_str) == Some("ERROR") {
          let msg = val.get("message").or_else(|| val.get("error")).and_then(Value::as_str).unwrap_or("unknown");
          return Some(Err(format!("Firmware enrollment báo lỗi: {msg}")));
        }
        return Some(Ok((frame_type, val)));
      }
      Err(_) => {
        continue;
      }
    }
  }
  None
}

fn read_frame(port: &mut dyn serialport::SerialPort, buffer: &mut Vec<u8>, timeout: Duration) -> Result<(u8, Value), String> {
  let end = SystemTime::now() + timeout;
  let mut chunk = [0u8; 512];
  while SystemTime::now() < end {
    if let Some(result) = extract_frame(buffer) {
      return result;
    }
    match port.read(&mut chunk) {
      Ok(n) if n > 0 => buffer.extend_from_slice(&chunk[..n]),
      Ok(_) => std::thread::sleep(Duration::from_millis(10)),
      Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {},
      Err(error) => return Err(format!("Không đọc được serial: {error}")),
    }
  }
  if let Some(result) = extract_frame(buffer) {
    return result;
  }
  Err(SERIAL_READ_TIMEOUT.to_string())
}

fn receive_until(
  port: &mut dyn serialport::SerialPort,
  buffer: &mut Vec<u8>,
  expected_type: u8,
  expected_op: &str,
  timeout: Duration,
  logs: &mut Vec<String>,
) -> Result<Value, String> {
  let end = SystemTime::now() + timeout;
  while SystemTime::now() < end {
    let remaining = end.duration_since(SystemTime::now()).unwrap_or(Duration::from_millis(1));
    let (kind, body) = match read_frame(port, buffer, remaining.min(Duration::from_secs(3))) {
      Ok(pair) => pair,
      // Firmware ERROR frames can themselves contain the word "timeout".
      // Only retry our own read deadline; surface the board's error verbatim.
      Err(err) if err == SERIAL_READ_TIMEOUT => continue,
      Err(err) => return Err(err),
    };
    if kind == 0x80 || body.get("op").and_then(Value::as_str) == Some("PROGRESS") {
      let stage = body.get("stage").and_then(Value::as_str).unwrap_or("...");
      let percent = body.get("percent").and_then(Value::as_u64).unwrap_or(0);
      logs.push(format!("Firmware tiến trình: {stage} ({percent}%)"));
      continue;
    }
    if kind == 0x82 || kind == 0xFF || body.get("op").and_then(Value::as_str) == Some("ERROR") {
      let message = body.get("message").and_then(Value::as_str).unwrap_or("Lỗi không xác định từ firmware");
      let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
      return Err(format!("Firmware từ chối (mã {code}): {message}"));
    }
    if kind == expected_type && body.get("op").and_then(Value::as_str) == Some(expected_op) {
      return Ok(body);
    }
  }
  Err(format!("Serial enrollment timeout: không nhận được {expected_op}."))
}

fn serial_enroll(port_path: &str, client: reqwest::Client, token: String, job_id: String, manifest: Value, logs: &mut Vec<String>) -> Result<(Option<String>, Option<String>, Option<Value>), String> {
  logs.push("Đang mở native serial 115200 để nhận firmware HELLO.".to_string());
  let mut port = serialport::new(port_path, 115_200).timeout(Duration::from_millis(200)).open().map_err(|error| format!("Không mở được cổng serial ứng dụng: {error}"))?;
  let _ = port.write_data_terminal_ready(false);
  let _ = port.write_request_to_send(true);
  std::thread::sleep(Duration::from_millis(150));
  let _ = port.write_request_to_send(false);
  let _ = port.write_data_terminal_ready(false);
  std::thread::sleep(Duration::from_millis(400));
  let _ = port.clear(serialport::ClearBuffer::All);
  let mut rx_buf = Vec::new();
  let hello = match receive_until(&mut *port, &mut rx_buf, 1, "HELLO", Duration::from_secs(4), logs) {
    Ok(value) => value,
    Err(_) => {
      logs.push("Chưa nhận HELLO tự động; đang gửi HELLO_REQUEST qua native serial.".to_string());
      write_frame(&mut *port, 2, 1, &json!({"op":"HELLO_REQUEST"}))?;
      receive_until(&mut *port, &mut rx_buf, 1, "HELLO", Duration::from_secs(8), logs)?
    }
  };
  for field in ["role", "chipFamily", "efuseMac", "hardwareProof", "nonce", "attestationPublicKey", "publicKeyFingerprint"] { required_string(hello.get(field).unwrap_or(&Value::Null), field)?; }
  let body = json!({ "chipFamily": hello["chipFamily"], "factoryEfuseMac": hello["efuseMac"], "hardwareProof": hello["hardwareProof"], "nonce": hello["nonce"], "publicKey": hello["attestationPublicKey"], "publicKeyFingerprint": hello["publicKeyFingerprint"], "role": hello["role"], "physicalSerial": true, "hello": hello });
  let enrollment = tauri::async_runtime::block_on(api_json(&client, &token, reqwest::Method::POST, &format!("/flash/jobs/{job_id}/enrollment"), Some(body), Some(&now_id("desktop-enroll"))))?;
  let ticket = required_string(enrollment.get("ticket").unwrap_or(&Value::Null), "enrollment ticket")?;
  let challenge = required_string(enrollment.get("challenge").unwrap_or(&Value::Null), "enrollment challenge")?;
  let serial = enrollment.get("serial").cloned().ok_or("Enrollment thiếu serial metadata.")?;
  let envelope: Value = serde_json::from_str(&ticket).map_err(|_| "Enrollment ticket không phải signed envelope.".to_string())?;
  for field in ["payload", "signature", "kid"] { required_string(envelope.get(field).unwrap_or(&Value::Null), field)?; }
  logs.push("FarmOS đã cấp ticket; đang chuyển tới firmware qua serial.".to_string());
  let ticket_write_started = Instant::now();
  write_frame(&mut *port, 3, 2, &envelope)?;
  logs.push(format!("Đã gửi ticket trong {} ms.", ticket_write_started.elapsed().as_millis()));
  receive_until(&mut *port, &mut rx_buf, 0x81, "ENROLLMENT_COMMITTED", Duration::from_secs(15), logs)?;
  logs.push("Firmware đã xác nhận enrollment ticket.".to_string());
  let selected_plan = manifest.get("selectedPlan").and_then(|plan| plan.get("name")).and_then(Value::as_str).ok_or("Manifest thiếu selectedPlan name.")?;
  let images = select_plan_images(&manifest)?;
  let app = images.iter().find(|image| matches!(image_role(image).as_str(), "APP" | "OTA_0" | "OTA_1")).ok_or("Manifest không có APP image.")?;
  let readback_sha = required_string(app.get("sha256").unwrap_or(&Value::Null), "APP sha256")?;
  let readback_length = app.get("sizeBytes").and_then(Value::as_u64).ok_or("APP thiếu size.")?;
  let flash_attestation = json!({ "boardId": serial["boardId"], "jobId": serial["jobId"], "releaseId": serial["releaseId"], "manifestSha256": manifest["manifestSha256"], "readbackSha256": readback_sha, "challenge": challenge, "readbackLength": readback_length });
  write_frame(&mut *port, 4, 3, &json!({ "op":"READBACK_CHALLENGE", "challengeId": format!("{job_id}-readback"), "nonce": serial["nonce"], "flashAttestation": flash_attestation }))?;
  let response = receive_until(&mut *port, &mut rx_buf, 0x81, "READBACK_RESPONSE", Duration::from_secs(20), logs)?;
  logs.push("Đã nhận readback/attestation từ firmware.".to_string());
  tauri::async_runtime::block_on(api_json(&client, &token, reqwest::Method::POST, &format!("/flash/jobs/{job_id}/progress"), Some(json!({"ticket":ticket,"progress":100,"sequence":1})), Some(&now_id("desktop-progress"))))?;
  tauri::async_runtime::block_on(api_json(&client, &token, reqwest::Method::POST, &format!("/flash/jobs/{job_id}/readback"), Some(json!({"ticket":ticket,"planName":selected_plan,"readbackSha256":readback_sha,"readbackLength":readback_length})), Some(&now_id("desktop-readback"))))?;
  let complete = json!({ "ticket":ticket, "planName":selected_plan, "challenge":challenge, "readbackSha256":readback_sha, "readbackLength":readback_length, "nonce":response["nonce"], "attestationPublicKey":response["attestationPublicKey"], "flashAttestationSignature":response["flashAttestationSignature"], "flashAttestationMessage":response["flashAttestationMessage"], "flashAttestation": { "boardId":serial["boardId"], "jobId":serial["jobId"], "releaseId":serial["releaseId"], "manifestSha256":manifest["manifestSha256"], "readbackSha256":readback_sha, "challenge":challenge, "readbackLength":readback_length, "signature":response["flashAttestationSignature"], "message":response["flashAttestationMessage"], "attestationPublicKey":response["attestationPublicKey"] } });
  let completed = tauri::async_runtime::block_on(api_json(&client, &token, reqwest::Method::POST, &format!("/flash/jobs/{job_id}/complete"), Some(complete), Some(&now_id("desktop-complete"))))?;
  let device_id = required_string(completed.get("identity").and_then(|value| value.get("deviceId")).unwrap_or(&Value::Null), "identity.deviceId")?;
  let qr_id = required_string(completed.get("qr").and_then(|value| value.get("qrId")).unwrap_or(&Value::Null), "qr.qrId")?;
  let qr_payload = completed.get("qr").and_then(|value| value.get("payload")).filter(|value| value.is_object()).cloned().ok_or("FarmOS chưa trả payload QR v3 đã ký.".to_string())?;
  if qr_payload.get("v").and_then(Value::as_u64) != Some(3)
    || qr_payload.get("qrId").and_then(Value::as_str) != Some(qr_id.as_str())
    || qr_payload.get("deviceId").and_then(Value::as_str) != Some(device_id.as_str())
    || qr_payload.get("sig").and_then(Value::as_str).is_none_or(str::is_empty) {
    return Err("Payload QR v3 không khớp identity hoặc thiếu chữ ký.".to_string());
  }
  if completed.get("job").and_then(|value| value.get("status")).and_then(Value::as_str) != Some("COMPLETED") {
    return Err("FarmOS chưa xác nhận FlashJob hoàn tất.".to_string());
  }
  if completed.get("job").and_then(|value| value.get("sourceDeviceId")).is_some_and(Value::is_null)
    && (completed.get("identity").and_then(|value| value.get("identityVersion")).and_then(Value::as_u64) != Some(3)
      || completed.get("identity").and_then(|value| value.get("state")).and_then(Value::as_str) != Some("READY_TO_SHIP")) {
    return Err("FarmOS chưa xác nhận identity xuất xưởng QR v3 sẵn sàng giao.".to_string());
  }
  logs.push(format!("FlashJob hoàn tất và identity đã được backend xác nhận (Thiết bị: {device_id})."));
  drop(port);
  Ok((Some(device_id), Some(qr_id), Some(qr_payload)))
}

#[tauri::command]
async fn flash_server_release(request: NativeFlashRequest, app: tauri::AppHandle, state: tauri::State<'_, DesktopSession>, serial_state: tauri::State<'_, SerialMonitorState>) -> Result<NativeFlashResult, String> {
  let _ = stop_serial_monitor(serial_state, app.clone());
  if !allowed_port(&request.port) || !Path::new(&request.port).exists() { return Err("Cổng serial không hợp lệ hoặc đã ngắt kết nối.".to_string()); }
  if request.release_id.trim().is_empty() { return Err("Chưa chọn gói firmware xuất xưởng đã kiểm tra.".to_string()); }
  // Shared catalog images are signed plaintext; encrypted factory images are
  // specific to one board. Check security before creating a job or writing.
  let security_args = vec!["--chip".to_string(), "esp32s3".to_string(), "--port".to_string(), request.port.clone(), "--no-stub".to_string(), "get_security_info".to_string()];
  let security_result = tool_command(&app, &request.port, &security_args)?.output().map_err(|error| format!("Không kiểm tra được bảo mật bo: {error}"))?;
  if !security_result.status.success() { return Err("Không đọc được trạng thái bảo mật bo; dừng trước khi ghi flash.".to_string()); }
  let security_output = String::from_utf8_lossy(&security_result.stdout);
  let secured = board_security(&security_output)?;
  if secured {
    return Err("Flasher chỉ hỗ trợ ESP32-S3 chưa khóa Secure Boot/Flash Encryption.".into());
  }
  {
    // Recheck physical MAC immediately before job creation, including when the
    // operator changed the board after the UI preflight.
    let args = vec!["--chip".into(), "esp32s3".into(), "--port".into(), request.port.clone(), "read_mac".into()];
    let result = tool_command(&app, &request.port, &args)?.output().map_err(|_| "Không đọc được MAC board trước khi nạp.".to_string())?;
    let output = String::from_utf8_lossy(&result.stdout);
    if !result.status.success() || capture_field(&output, "MAC:").is_none_or(|mac| !mac.eq_ignore_ascii_case(&request.mac_address)) {
      return Err("Board đã thay đổi hoặc MAC không khớp; hãy kiểm tra lại cổng USB.".into());
    }
  }
  let token = header_token(&state)?; let client = reqwest::Client::new(); let mut logs = vec!["Nạp firmware USB cho ESP32-S3, không thay đổi eFuse.".to_string(), "Desktop tạo FlashJob có audit trên FarmOS.".to_string()]; let target = if request.target_type == "GATEWAY" { "GATEWAY" } else { "NODE" }; let mode = "NORMAL_REFLASH";
  let expected_identity = json!(request.expected_device_id);
  let require_new_device = expected_identity.is_null();
  let inspection = api_json(&client, &token, reqwest::Method::POST, "/flash/boards/inspect", Some(json!({"targetType":target,"chipFamily":request.chip_family,"factoryEfuseMac":request.mac_address,"releaseId":request.release_id,"requireNewDevice":require_new_device})), None).await?;
  if inspection.get("currentDeviceId") != Some(&expected_identity) || inspection.get("ready").and_then(Value::as_bool) != Some(true) {
    return Err("Identity đã thay đổi hoặc bo chưa đủ điều kiện nạp. Hãy kiểm tra lại trước khi ghi flash.".into());
  }
  if inspection.get("release").and_then(|release| release.get("id")).and_then(Value::as_str) != Some(request.release_id.as_str()) { return Err("Server chưa xác nhận đúng phiên bản đã chọn; dừng trước khi nạp.".into()); }
  let job = api_json(&client, &token, reqwest::Method::POST, "/flash/jobs", Some(json!({"targetType":target,"mode":mode,"chipFamily":request.chip_family,"factoryEfuseMac":request.mac_address,"releaseId":request.release_id,"requireNewDevice":require_new_device})), Some(&now_id("desktop-job"))).await?; let job_id = required_string(job.get("id").unwrap_or(&Value::Null), "FlashJob id")?;
  let _ = app.emit("flash-stage", "Đang tải và xác minh gói firmware.");
  let result = async {
    if job.get("sourceDeviceId") != Some(&expected_identity) {
      return Err("FlashJob không khớp identity đã kiểm tra. Dừng trước khi ghi flash.".into());
    }
    let bundle = api_json(&client, &token, reqwest::Method::GET, &format!("/flash/jobs/{job_id}/manifest"), None, None).await?; let manifest = bundle.get("manifest").cloned().ok_or("FarmOS manifest response không hợp lệ.")?; let announced_hash = required_string(bundle.get("manifestSha256").or_else(|| manifest.get("manifestSha256")).unwrap_or(&Value::Null), "manifest SHA-256")?; let signature = bundle.get("manifestSignature").or_else(|| manifest.get("manifestSignature")).or_else(|| manifest.get("signature")).and_then(Value::as_str).unwrap_or(""); let key_id = bundle.get("manifestKeyId").or_else(|| manifest.get("manifestKeyId")).or_else(|| manifest.get("keyId")).and_then(Value::as_str).unwrap_or(""); if signature.is_empty() || key_id.is_empty() { return Err("Manifest thiếu chữ ký hoặc key id của FarmOS.".to_string()); } if manifest.get("manifestSha256").and_then(Value::as_str).is_some_and(|hash| hash != announced_hash) { return Err("Manifest SHA-256 không nhất quán.".to_string()); } if let Some(payload) = manifest.get("manifestPayload").and_then(Value::as_str) { if sha256_hex(payload.as_bytes()) != announced_hash { return Err("Manifest aggregate SHA-256 không hợp lệ.".to_string()); } }
    if !require_new_device {
      validate_identity_preserving_plan(&manifest)?;
      logs.push("Nạp lại APP và OTA_DATA, giữ nguyên danh tính bo.".into());
    }
    let mut files = download_images(&client, &token, &job_id, &manifest, &mut logs, &app).await?;
    for (address, file) in &files {
      if *address != 0 && *address != 0x20000 { continue; }
      let bytes = fs::read(file).map_err(|_| "Không đọc được firmware để kiểm tra bảo mật.")?;
      let contains = |marker: &[u8]| bytes.windows(marker.len()).any(|window| window == marker);
      let needs_encryption = if *address == 0 { contains(b"flash_encrypt") || contains(b"secure_boot_v2") } else { contains(b"Flash encryption eFuse bit was not enabled in bootloader") };
      if needs_encryption { return Err("Gói firmware yêu cầu khóa eFuse; hãy chọn firmware USB thông thường.".into()); }
    }
    if initialize_factory_identity(&job, &manifest, &mut files)? {
      logs.push("Board chưa có trong hệ thống: tự khởi tạo danh tính để cấp thiết bị và QR mới.".into());
    }
    logs.push("Bắt đầu ghi signed write plan bằng native esptool.".to_string());
    for (index, (address, file)) in files.iter().enumerate() {
      let _ = app.emit("flash-stage", format!("Đang ghi ảnh {}/{} tại 0x{address:x}; vui lòng giữ kết nối USB.", index + 1, files.len()));
      let mut args = vec!["--chip".to_string(), "esp32s3".to_string(), "--port".to_string(), request.port.clone(), "--baud".to_string(), "460800".to_string(), "--after".to_string(), if index + 1 == files.len() { "hard_reset".to_string() } else { "no_reset".to_string() }];
      args.push("write_flash".into());
      args.extend(["--flash_mode".into(), "keep".into(), "--flash_freq".into(), "keep".into(), "--flash_size".into(), "keep".into(), format!("0x{address:x}"), file.display().to_string()]);
      let output = tool_command(&app, &request.port, &args)?.output().map_err(|error| format!("Không khởi chạy được native flasher: {error}"))?;
      let mut text = String::from_utf8_lossy(&output.stdout).to_string(); text.push_str(&String::from_utf8_lossy(&output.stderr));
      logs.extend(text.lines().filter(|line| !line.trim().is_empty()).map(|line| line.trim().to_string()).take(80));
      if !output.status.success() { return Err(format!("esptool ghi image 0x{address:x} thất bại.")); }
    }
    logs.push("Ghi flash hoàn tất; native serial chuyển sang 115200 để enrollment.".to_string());
    let _ = app.emit("flash-stage", "Ghi flash xong; đang xác minh firmware và cấp ID/QR.");
    let client_for_serial = client.clone();
    let token_for_serial = token.clone();
    let port = request.port.clone();
    let job_for_serial = job_id.clone();
    let manifest_for_serial = manifest.clone();
    let (enroll_res, serial_logs) = tauri::async_runtime::spawn_blocking(move || {
      let mut s_logs = Vec::new();
      let res = serial_enroll(&port, client_for_serial, token_for_serial, job_for_serial, manifest_for_serial, &mut s_logs);
      (res, s_logs)
    }).await.map_err(|error| error.to_string())?;
    logs.extend(serial_logs);
    let (device_id, qr_id, qr_payload) = enroll_res?;
    Ok((device_id, qr_id, qr_payload))
  }.await;
  match result { Ok((device_id, qr_id, qr_payload)) => { logs.push("FlashJob hoàn tất và identity đã được backend xác nhận.".to_string()); Ok(NativeFlashResult { job_id, status: "COMPLETED".to_string(), logs, device_id, qr_id, qr_payload, new_identity: job.get("sourceDeviceId").is_some_and(Value::is_null) }) }, Err(error) => { let _ = api_json(&client, &token, reqwest::Method::POST, &format!("/flash/jobs/{job_id}/fail"), Some(json!({"error":error})), Some(&now_id("desktop-fail"))).await; logs.push(format!("Lỗi: {error}")); Err(logs.join("\n")) } }
}

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .manage(DesktopSession::default())
    .manage(OAuthCancelSignal::default())
    .manage(SerialMonitorState::default())
    .invoke_handler(tauri::generate_handler![
      native_toolchain_status,
      list_native_ports,
      probe_esp32,
      inspect_board_for_flash,
      verify_flash_identity,
      repurpose_board_for_flash,
      create_mobile_session,
      auth_storage::auth_storage_get,
      auth_storage::auth_storage_set,
      auth_storage::auth_storage_remove,
      clear_mobile_session,
      wait_for_oauth_callback,
      cancel_oauth_callback,
      list_desktop_releases,
      upload_desktop_release,
      flash_server_release,
      inspect_local_file,
      update_desktop_release_status,
      delete_desktop_release,
      download_desktop_artifact,
      save_qr_png,
      list_desktop_nodes,
      unbind_desktop_node,
      delete_desktop_node,
      get_desktop_node_qr,
      start_serial_monitor,
      stop_serial_monitor,
      send_serial_data,
      reset_esp32_device
    ])
    .run(tauri::generate_context!())
    .expect("error while running FarmOS Flasher");
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reflash_plan_limits_writes_to_app_then_ota_data() {
    let mut manifest = json!({
      "signed": true,
      "images": [
        { "id": "app", "role": "APP", "address": 0x20000, "sizeBytes": 4096 },
        { "id": "ota", "role": "OTA_DATA", "address": 0x19000, "sizeBytes": 8192 }
      ],
      "selectedPlan": { "name": "NORMAL_REFLASH", "imageIds": ["app", "ota"], "steps": [{}, {}] }
    });
    assert!(validate_identity_preserving_plan(&manifest).is_ok());
    manifest["images"][1]["sizeBytes"] = json!(8193);
    assert!(validate_identity_preserving_plan(&manifest).is_err());
    manifest["images"][1]["sizeBytes"] = json!(8192);
    manifest["images"][0]["address"] = json!(0x320000);
    assert!(validate_identity_preserving_plan(&manifest).is_err());
  }

  #[test]
  fn qr_writer_rejects_invalid_formats_and_writes_exact_bytes() {
    let folder = env::temp_dir().join(now_id("farmos-qr-test"));
    fs::create_dir_all(&folder).unwrap();
    let png = b"\x89PNG\r\n\x1a\nexact-qr-bytes";
    assert!(write_qr_png(&folder.join("secrets.env"), png).is_err());
    assert!(write_qr_png(&folder.join("qr.png"), b"invalid").is_err());
    assert!(write_qr_png(Path::new("relative.png"), png).is_err());
    write_qr_png(&folder.join("qr.png"), png).unwrap();
    assert_eq!(fs::read(folder.join("qr.png")).unwrap(), png);
    fs::remove_dir_all(folder).unwrap();
  }

  #[test]
  fn security_detection_requires_complete_unambiguous_state() {
    assert_eq!(board_security("Secure Boot: Disabled\nFlash Encryption: Disabled").unwrap(), false);
    assert_eq!(board_security("Secure Boot: Enabled\nFlash Encryption: Enabled").unwrap(), true);
    for output in ["", "Secure Boot: Disabled", "Secure Boot: Enabled\nFlash Encryption: Disabled",
      "Secure Boot: Disabled\nFlash Encryption: Enabled", "Secure Boot: Unknown\nFlash Encryption: Disabled",
      "Secure Boot: Disabled\nSecure Boot: Enabled\nFlash Encryption: Disabled"] {
      assert!(board_security(output).is_err(), "{output}");
    }
  }

  #[test]
  fn test_deleted_board_initialization_preserves_registered_identity_and_selector_order() {
    let folder = env::temp_dir().join(now_id("farmos-factory-init-test"));
    fs::create_dir_all(&folder).unwrap();
    let original = vec![(0x20000, folder.join("app.bin")), (0x19000, folder.join("selector.bin"))];
    let manifest = json!({"selectedPlan":{"name":"FACTORY_FULL_FLASH"}});
    let mut files = original.clone();
    assert!(!initialize_factory_identity(&json!({"sourceDeviceId":"NODE_1"}), &manifest, &mut files).unwrap());
    assert_eq!(files, original);
    assert!(!initialize_factory_identity(&json!({}), &manifest, &mut files).unwrap());
    assert!(initialize_factory_identity(&json!({"sourceDeviceId":null}), &json!({"selectedPlan":{"name":"NORMAL_REFLASH"}}), &mut files).is_err());
    assert_eq!(files, original);
    assert!(initialize_factory_identity(&json!({"sourceDeviceId":null}), &manifest, &mut files).unwrap());
    assert_eq!(files.iter().map(|file| file.0).collect::<Vec<_>>(), vec![0x20000, 0x620000, 0x19000]);
    assert_eq!(fs::read(&files[1].1).unwrap(), vec![0xff; 0x10000]);
    assert!(!files.iter().any(|file| file.0 == 0x630000));
    fs::remove_dir_all(folder).unwrap();
  }

  fn make_raw_frame(frame_type: u8, sequence: u32, payload: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(payload).unwrap();
    let mut frame = Vec::new();
    frame.extend(FRAME_SYNC);
    frame.extend([FRAME_VERSION, frame_type]);
    frame.extend((body.len() as u16).to_be_bytes());
    frame.extend(sequence.to_be_bytes());
    frame.extend(&body);
    let mut crc = Crc32::new();
    crc.update(&frame[2..]);
    frame.extend(crc.finalize().to_be_bytes());
    frame
  }

  #[test]
  fn test_extract_frame_valid() {
    let payload = json!({"op": "HELLO", "role": "NODE"});
    let mut buf = make_raw_frame(1, 42, &payload);
    let frame = extract_frame(&mut buf).expect("should extract frame").expect("should be ok");
    assert_eq!(frame.0, 1);
    assert_eq!(frame.1["op"], "HELLO");
    assert!(buf.is_empty());
  }

  #[test]
  fn test_extract_frame_resynchronizes_after_noise_and_bad_crc() {
    let payload = json!({"op": "HELLO", "role": "NODE"});
    let valid_frame = make_raw_frame(1, 1, &payload);

    // Corrupted frame with inverted CRC
    let mut bad_frame = make_raw_frame(2, 1, &json!({"op": "HELLO_REQUEST"}));
    let len = bad_frame.len();
    bad_frame[len - 1] ^= 0xff;

    // Stream contains: boot logs with 'FO' substrings, bad frame, noise, and finally valid frame
    let mut stream = Vec::new();
    stream.extend(b"rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)\r\n");
    stream.extend(b"I (24) boot: ESP-IDF v5.1.2\r\n");
    stream.extend(b"[NODE] ENROLLMENT REQUIRED | INFO: READY_FOR_READBACK NOT_FOUND\r\n");
    stream.extend(bad_frame);
    stream.extend(b"\r\nmore noise\r\n");
    stream.extend(valid_frame);

    let extracted = extract_frame(&mut stream).expect("should find valid frame").expect("should be ok");
    assert_eq!(extracted.0, 1);
    assert_eq!(extracted.1["op"], "HELLO");
  }

  #[test]
  fn test_extract_frame_waits_for_incomplete_data() {
    let payload = json!({"op": "HELLO"});
    let frame = make_raw_frame(1, 1, &payload);

    // Only partial header
    let mut buf = frame[..5].to_vec();
    assert!(extract_frame(&mut buf).is_none());
    assert_eq!(buf.len(), 5);

    // Add rest of frame
    buf.extend_from_slice(&frame[5..]);
    let extracted = extract_frame(&mut buf).expect("complete").expect("ok");
    assert_eq!(extracted.1["op"], "HELLO");
    assert!(buf.is_empty());
  }
}
