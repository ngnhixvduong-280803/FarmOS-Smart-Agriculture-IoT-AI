import { useCallback, useEffect, useRef, useState } from "react";
import { fontWeight } from "../theme/typography";
import { AppState, BackHandler, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Camera, useCameraDevice, useCameraPermission, useCodeScanner } from "react-native-vision-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppAlert } from "./AppDialog";

export function cameraPermissionNeedsSettings(status: string): boolean {
  return status === "denied" || status === "restricted";
}

export function cameraPermissionGranted(result: unknown): boolean {
  // Vision Camera 4.x exposes a boolean from useCameraPermission(). Some
  // adapters/native wrappers expose the underlying "granted" status string.
  return result === true || result === "granted";
}

export function QrScanner({ onCode, onClose }: { onCode: (value: string) => void; onClose: () => void }) {
  const appAlert = useAppAlert();
  const device = useCameraDevice("back");
  const insets = useSafeAreaInsets();
  const { hasPermission, requestPermission } = useCameraPermission();
  const consumed = useRef(false);
  const [permissionStatus, setPermissionStatus] = useState(() => Camera.getCameraPermissionStatus());

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setPermissionStatus(Camera.getCameraPermissionStatus());
    });
    return () => subscription.remove();
  }, []);

  const handleRequestPermission = async () => {
    try {
      const result = await requestPermission() as unknown;
      setPermissionStatus(Camera.getCameraPermissionStatus());
      if (!cameraPermissionGranted(result)) return;
    } catch (error) {
      setPermissionStatus(Camera.getCameraPermissionStatus());
      appAlert("Không thể cấp quyền Camera", error instanceof Error ? error.message : "Hãy thử lại trong Cài đặt.");
    }
  };

  const openSettings = async () => {
    await Linking.openSettings().catch(() => undefined);
  };

  const codeScanner = useCodeScanner({
    codeTypes: ["qr"],
    onCodeScanned: useCallback((codes) => {
      const value = codes.find((code) => code.value)?.value;
      if (value && !consumed.current) {
        consumed.current = true;
        onCode(value);
      }
    }, [onCode]),
  });

  if (!hasPermission) {
    const permanentlyDenied = cameraPermissionNeedsSettings(permissionStatus);
    return <View style={styles.center}>
      <Text style={styles.title}>Cho phép Camera để quét QR thiết bị FarmOS</Text>
      <Text style={styles.message}>{permanentlyDenied ? "Quyền Camera đang bị chặn. Hãy mở Cài đặt để cấp quyền cho FarmOS." : "FarmOS cần Camera để đọc mã QR trên thiết bị."}</Text>
      {permanentlyDenied ? <Pressable accessibilityRole="button" accessibilityLabel="Mở Cài đặt để cấp quyền Camera" accessibilityHint="Cấp quyền Camera cho FarmOS rồi quay lại ứng dụng" hitSlop={10} style={styles.button} onPress={openSettings}><Text style={styles.buttonText}>Mở Cài đặt</Text></Pressable> : <Pressable accessibilityRole="button" accessibilityLabel="Cho phép Camera" accessibilityHint="Hiển thị yêu cầu quyền Camera của hệ điều hành" hitSlop={10} style={styles.button} onPress={handleRequestPermission}><Text style={styles.buttonText}>Cho phép Camera</Text></Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel="Đóng trình quét QR" accessibilityHint="Quay lại màn hình thiết bị" hitSlop={10} onPress={onClose}><Text style={styles.close}>Đóng</Text></Pressable>
    </View>;
  }
  if (!device) return <View style={styles.center}><Text style={styles.title}>Không tìm thấy camera sau.</Text><Text style={styles.message}>Thiết bị này không có camera phù hợp để quét QR.</Text><Pressable accessibilityRole="button" accessibilityLabel="Đóng trình quét QR" accessibilityHint="Quay lại màn hình thiết bị" hitSlop={10} onPress={onClose}><Text style={styles.close}>Đóng</Text></Pressable></View>;

  return <View style={StyleSheet.absoluteFill}>
    <Camera style={StyleSheet.absoluteFill} device={device} isActive codeScanner={codeScanner} />
    <View style={[styles.overlay, { paddingTop: 70 + insets.top, paddingBottom: 70 + insets.bottom }]}><Text accessibilityRole="header" style={styles.scanTitle}>Quét QR trên thiết bị</Text><View accessibilityLabel="Khung quét mã QR" style={styles.frame} /><Text style={styles.hint}>Đặt mã QR nằm trọn trong khung</Text><Pressable accessibilityRole="button" accessibilityLabel="Hủy quét QR" accessibilityHint="Dừng camera và quay lại màn hình thiết bị" hitSlop={10} style={styles.cancel} onPress={onClose}><Text style={styles.cancelText}>Huỷ</Text></Pressable></View>
  </View>;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18, padding: 24, backgroundColor: "#ffffff" },
  title: { color: "#1c2922", fontSize: 19, fontWeight: fontWeight.bold, textAlign: "center" },
  message: { color: "#68766e", fontSize: 14, lineHeight: 20, textAlign: "center" },
  button: { backgroundColor: "#19764b", borderRadius: 12, paddingHorizontal: 18, paddingVertical: 13 },
  buttonText: { color: "white", fontWeight: fontWeight.bold }, close: { color: "#19764b", fontWeight: fontWeight.bold },
  overlay: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "space-between", paddingVertical: 70, backgroundColor: "rgba(0,0,0,.28)" },
  scanTitle: { color: "white", fontSize: 22, fontWeight: fontWeight.bold }, frame: { width: 270, height: 270, borderWidth: 3, borderColor: "#8cf0b5", borderRadius: 24 },
  hint: { color: "white", fontWeight: fontWeight.bold }, cancel: { backgroundColor: "rgba(0,0,0,.7)", borderRadius: 99, paddingHorizontal: 24, paddingVertical: 12 }, cancelText: { color: "white", fontWeight: fontWeight.bold },
});
