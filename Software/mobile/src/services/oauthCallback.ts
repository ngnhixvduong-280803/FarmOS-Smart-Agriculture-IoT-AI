export function oauthCode(callbackUrl: string): string {
  const url = new URL(callbackUrl);
  if (url.protocol !== "farmos:" || url.hostname !== "auth" || url.pathname !== "/callback") {
    throw new Error("Đường dẫn đăng nhập không hợp lệ");
  }
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.has("error")) throw new Error("Đăng nhập chưa hoàn tất, hãy thử lại.");
  return code;
}
