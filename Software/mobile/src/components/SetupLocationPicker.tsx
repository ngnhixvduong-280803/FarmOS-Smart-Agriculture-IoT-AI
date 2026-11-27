import { useRef, useState } from "react";
import { fontWeight } from "../theme/typography";
import { ActivityIndicator, Modal, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Camera, Map, type CameraRef } from "@maplibre/maplibre-react-native";
import Geolocation from "react-native-geolocation-service";
import { useTranslation } from "react-i18next";
import { useAppAlert } from "./AppDialog";

const OPEN_FREE_MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const DEFAULT_LOCATION = { latitude: 10.854886, longitude: 106.786523 };
export type SetupLocation = { latitude: number; longitude: number };

function validLocation(value: SetupLocation | null | undefined): value is SetupLocation {
  return Boolean(value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude));
}

async function requestCurrentLocation(permissionDeniedMsg: string, cannotGetLocationMsg: string): Promise<SetupLocation> {
  if (Platform.OS === "android") {
    const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
      title: "Dùng vị trí khi cài đặt thiết bị",
      message: "FarmOS dùng vị trí hiện tại để đặt ghim vị trí board trên bản đồ.",
      buttonPositive: "Cho phép",
      buttonNegative: "Không cho phép",
    });
    if (permission !== PermissionsAndroid.RESULTS.GRANTED) throw new Error(permissionDeniedMsg);
  } else {
    const result = await Geolocation.requestAuthorization("whenInUse");
    if (result !== "granted") throw new Error(permissionDeniedMsg);
  }
  return new Promise((resolve, reject) => Geolocation.getCurrentPosition(
    (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
    (error) => reject(new Error(error.message || cannotGetLocationMsg)),
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 15_000 },
  ));
}

export function SetupLocationPicker({ visible, value, onClose, onSave }: { visible: boolean; value: SetupLocation | null; onClose: () => void; onSave: (location: SetupLocation) => void }) {
  const { t } = useTranslation();
  const appAlert = useAppAlert();
  const cameraRef = useRef<CameraRef>(null);
  const [selected, setSelected] = useState<SetupLocation>(validLocation(value) ? value : DEFAULT_LOCATION);
  const [locating, setLocating] = useState(false);
  const moveTo = (location: SetupLocation) => { setSelected(location); cameraRef.current?.easeTo({ center: [location.longitude, location.latitude], zoom: 17, duration: 450 }); };
  const useMyLocation = async () => {
    try {
      setLocating(true);
      moveTo(await requestCurrentLocation(t("locationPicker.permissionDenied"), t("locationPicker.cannotGetLocation")));
    } catch (error) {
      appAlert(t("locationPicker.cannotGetLocation"), error instanceof Error ? error.message : t("locationPicker.permissionDenied"));
    } finally {
      setLocating(false);
    }
  };
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    <View style={styles.screen}>
      <View style={styles.header}><View><Text style={styles.title}>{t("locationPicker.title")}</Text><Text style={styles.subtitle}>{t("locationPicker.subtitle")}</Text></View><Pressable accessibilityRole="button" accessibilityLabel={t("locationPicker.closeA11y")} onPress={onClose}><Text style={styles.close}>{t("locationPicker.close")}</Text></Pressable></View>
      <Map style={styles.map} mapStyle={OPEN_FREE_MAP_STYLE} logo={false} compass scaleBar onRegionDidChange={(event) => {
        const [longitude, latitude] = event.nativeEvent.center;
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) setSelected({ latitude, longitude });
      }} onPress={(event) => { const [longitude, latitude] = event.nativeEvent.lngLat; setSelected({ latitude, longitude }); }} onLongPress={(event) => { const [longitude, latitude] = event.nativeEvent.lngLat; moveTo({ latitude, longitude }); }}>
        <Camera ref={cameraRef} initialViewState={{ center: [selected.longitude, selected.latitude], zoom: 15 }} />
      </Map>
      <View pointerEvents="none" style={styles.centerPin}><View style={styles.pin}><Text style={styles.pinText}>●</Text></View><View style={styles.pinStem} /></View>
      <Pressable accessibilityRole="button" accessibilityLabel={t("locationPicker.useCurrentLocationA11y")} onPress={useMyLocation} style={styles.locationButton} disabled={locating}>{locating ? <ActivityIndicator color="#fff" /> : <Text style={styles.locationText}>{t("locationPicker.useCurrentLocation")}</Text>}</Pressable>
      <View style={styles.footer}><Text style={styles.coordinate}>{selected.latitude.toFixed(6)}, {selected.longitude.toFixed(6)}</Text><Text style={styles.hint}>{t("locationPicker.coordinateHint")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("locationPicker.saveLocationA11y")} onPress={() => onSave(selected)} style={styles.save}><Text style={styles.saveText}>{t("locationPicker.saveLocation")}</Text></Pressable></View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fff" }, header: { alignItems: "flex-start", borderBottomColor: "#e2e8f0", borderBottomWidth: 1, flexDirection: "row", gap: 12, justifyContent: "space-between", padding: 20 }, title: { color: "#10261c", fontSize: 20, fontWeight: fontWeight.bold }, subtitle: { color: "#64748b", fontSize: 13, lineHeight: 19, marginTop: 4, maxWidth: 275 }, close: { color: "#16704a", fontSize: 14, fontWeight: fontWeight.bold, paddingTop: 4 }, map: { flex: 1 }, centerPin: { alignItems: "center", left: "50%", marginLeft: -18, marginTop: -31, position: "absolute", top: "50%" }, pin: { alignItems: "center", backgroundColor: "#dc3654", borderColor: "#fff", borderRadius: 18, borderWidth: 3, height: 36, justifyContent: "center", width: 36 }, pinText: { color: "#fff", fontSize: 15 }, pinStem: { backgroundColor: "#dc3654", height: 17, marginTop: -2, width: 3 }, locationButton: { alignItems: "center", backgroundColor: "#16704a", borderRadius: 12, bottom: 185, minHeight: 48, justifyContent: "center", left: 20, paddingHorizontal: 18, position: "absolute", right: 20 }, locationText: { color: "#fff", fontSize: 14, fontWeight: fontWeight.bold }, footer: { backgroundColor: "#fff", borderTopColor: "#e2e8f0", borderTopWidth: 1, gap: 8, padding: 18 }, coordinate: { color: "#10261c", fontSize: 14, fontWeight: fontWeight.bold }, hint: { color: "#64748b", fontSize: 12, lineHeight: 17 }, save: { alignItems: "center", backgroundColor: "#0f8b5f", borderRadius: 12, minHeight: 48, justifyContent: "center", marginTop: 3 }, saveText: { color: "#fff", fontSize: 14, fontWeight: fontWeight.bold },
});
