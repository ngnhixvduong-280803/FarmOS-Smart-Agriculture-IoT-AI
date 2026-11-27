import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fontWeight } from "../theme/typography";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ActivityIndicator, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Camera, Map, Marker, NativeUserLocation, type CameraRef, type TrackUserLocation } from "@maplibre/maplibre-react-native";
import Geolocation from "react-native-geolocation-service";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon } from "../components/Icon";
import { api } from "../services/api";
import { usePreferences } from "../context/PreferencesContext";
import type { MapFarm, MapNode } from "../types";

const DEFAULT_LOCATION = { latitude: 10.854886, longitude: 106.786523 };
const MAP_VIEW_STORAGE_KEY = "farmos_mobile_map_view_v1";
const MAP_STYLES = [
  { id: "bright", icon: "sun", url: "https://tiles.openfreemap.org/styles/bright", preview: { background: "#f8f1e7", water: "#79d4e8", road: "#f7a24c", minorRoad: "#f7cf88" } },
  { id: "positron", icon: "map", url: "https://tiles.openfreemap.org/styles/positron", preview: { background: "#eef2f4", water: "#a6d5e7", road: "#9aaab5", minorRoad: "#cbd5dc" } },
  { id: "liberty", icon: "layers", url: "https://tiles.openfreemap.org/styles/liberty", preview: { background: "#dce8c8", water: "#7bc8e4", road: "#e9b65d", minorRoad: "#cbd89f" } },
  { id: "dark", icon: "cloud", url: "https://tiles.openfreemap.org/styles/dark", preview: { background: "#1d2d3d", water: "#276582", road: "#d6974a", minorRoad: "#405468" } },
] as const;

type SearchHit =
  | { kind: "farm"; farm: MapFarm; score: number }
  | { kind: "node"; farm: MapFarm; node: MapNode; score: number };

type PersistedMapView = {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
};

const normalize = (value?: string | null) => (value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLowerCase().trim();
const coordinate = (value: number | null | undefined, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;

async function requestLocationPermission(): Promise<void> {
  if (Platform.OS === "android") {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
      title: "Cho phép FarmOS dùng vị trí",
      message: "FarmOS cần vị trí để hiển thị bạn trên bản đồ và theo hướng nhìn.",
      buttonPositive: "Cho phép",
      buttonNegative: "Không cho phép",
    });
    if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error("Bạn chưa cho phép vị trí. Bạn vẫn có thể tìm Farm hoặc Node thủ công.");
    return;
  }

  const result = await Geolocation.requestAuthorization("whenInUse");
  if (result !== "granted") throw new Error("Bạn chưa cho phép vị trí. Hãy cấp quyền trong Cài đặt để dùng định vị.");
}

function getCurrentLocation(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    Geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
      (error) => reject(new Error(error.code === 1 ? "Bạn chưa cho phép vị trí. Hãy cấp quyền trong Cài đặt để dùng định vị." : error.message || "Không thể xác định vị trí của bạn.")),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}

function parseStoredMapView(raw: string | null): PersistedMapView | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedMapView>;
    if (!Array.isArray(value.center) || value.center.length !== 2 || !Number.isFinite(value.center[0]) || !Number.isFinite(value.center[1]) || !Number.isFinite(value.zoom)) return null;
    const longitude = Number(value.center[0]);
    const latitude = Number(value.center[1]);
    return { center: [longitude, latitude], zoom: Number(value.zoom), bearing: Number.isFinite(value.bearing) ? Number(value.bearing) : 0, pitch: Number.isFinite(value.pitch) ? Number(value.pitch) : 0 };
  } catch {
    return null;
  }
}

function MapStylePreview({ style, compact = false }: { style: (typeof MAP_STYLES)[number]; compact?: boolean }) {
  return <View style={[styles.stylePreview, compact && styles.stylePreviewCompact, { backgroundColor: style.preview.background }]}>
    <View style={[styles.previewWater, { backgroundColor: style.preview.water }]} />
    <View style={[styles.previewRoad, { backgroundColor: style.preview.road }]} />
    <View style={[styles.previewMinorRoad, { backgroundColor: style.preview.minorRoad }]} />
    {!compact && <View style={styles.previewBadge}><Icon name={style.icon} size={13} color="#ffffff" /></View>}
  </View>;
}

function score(query: string, values: Array<string | null | undefined>) {
  const candidates = values.map(normalize).filter(Boolean);
  if (candidates.some((value) => value === query)) return 100;
  if (candidates.some((value) => value.startsWith(query))) return 80;
  return candidates.some((value) => value.includes(query)) ? 55 : 0;
}

export function FarmMapScreen() {
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const mapRef = useRef<CameraRef>(null);
  const hasInitialLocationAttemptRef = useRef(false);
  const canPersistViewportRef = useRef(false);
  const [farms, setFarms] = useState<MapFarm[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [styleId, setStyleId] = useState<(typeof MAP_STYLES)[number]["id"]>("bright");
  const [showLayers, setShowLayers] = useState(false);
  const [userTracking, setUserTracking] = useState<TrackUserLocation | null>(null);
  const [hasUserLocation, setHasUserLocation] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [mapBearing, setMapBearing] = useState(0);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [storedView, setStoredView] = useState<PersistedMapView | null>(null);

  const getStyleLabel = useCallback((id: string) => {
    switch (id) {
      case "bright": return t("map.styleBright");
      case "positron": return t("map.stylePositron");
      case "liberty": return t("map.styleLiberty");
      case "dark": return t("map.styleDark");
      default: return id;
    }
  }, [t]);

  const load = useCallback(async (isRefresh = false) => {
    isRefresh ? setRefreshing(true) : setLoading(true);
    try {
      setError(null);
      setFarms(await api.mapOverview());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("map.failedToLoadMap"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => { load().catch(() => undefined); }, [load]);

  // Status notices acknowledge a map action but must never block the map or
  // remain on-screen after the action is understood.
  useEffect(() => {
    if (!locationNotice) return;
    const timeout = setTimeout(() => setLocationNotice(null), 2_800);
    return () => clearTimeout(timeout);
  }, [locationNotice]);

  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(MAP_VIEW_STORAGE_KEY)
      .then((raw) => mounted && setStoredView(parseStoredMapView(raw)))
      .catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  const initialLocation = useMemo(() => {
    const farm = farms.find((item) => item.latitude != null && item.longitude != null);
    return farm ? { latitude: coordinate(farm.latitude, DEFAULT_LOCATION.latitude), longitude: coordinate(farm.longitude, DEFAULT_LOCATION.longitude) } : DEFAULT_LOCATION;
  }, [farms]);

  // This is deliberately shared by the first-open flow and the map control:
  // the first tab visit and a later "my location" tap must use exactly the
  // same high-accuracy GPS path.
  const focusOnMyLocation = useCallback(async (noticeKey: "locatedCurrent" | "centeredOnYou") => {
    if (isLocating) return;

    setIsLocating(true);
    try {
      setLocationNotice(t("map.locating"));
      await requestLocationPermission();
      const location = await getCurrentLocation();
      setHasUserLocation(true);
      // Tracking the position must not rotate the map. The native puck still
      // shows its heading, while the map's bearing remains under the person's
      // direct control.
      setUserTracking("default");
      canPersistViewportRef.current = true;

      // The camera can be attached a frame after the native location layer.
      // Deferring makes the initial tab open as reliable as pressing the
      // location button after the map has already been displayed.
      requestAnimationFrame(() => {
        mapRef.current?.easeTo({
          center: [location.longitude, location.latitude],
          zoom: 16.5,
          duration: 480,
        });
      });
      setLocationNotice(t(`map.${noticeKey}`));
    } catch (cause) {
      setLocationNotice(cause instanceof Error ? cause.message : t("map.locationUndetermined"));
      throw cause;
    } finally {
      setIsLocating(false);
    }
  }, [isLocating, t]);

  // Opening Map always prioritises the person's live location, not a previous
  // farm/viewport. The persisted viewport is only a graceful fallback when
  // location access is unavailable.
  useEffect(() => {
    if (!mapReady || hasInitialLocationAttemptRef.current) return;
    hasInitialLocationAttemptRef.current = true;

    void (async () => {
      try {
        await focusOnMyLocation("locatedCurrent");
      } catch (cause) {
        canPersistViewportRef.current = true;
        if (storedView) {
          mapRef.current?.jumpTo({ center: storedView.center, zoom: storedView.zoom, bearing: storedView.bearing, pitch: storedView.pitch });
        }
        setLocationNotice(cause instanceof Error ? cause.message : t("map.locationUndetermined"));
      }
    })();
  }, [focusOnMyLocation, mapReady, storedView, t]);

  const hits = useMemo<SearchHit[]>(() => {
    const normalized = normalize(query);
    if (!normalized) return [];
    const found: SearchHit[] = [];
    farms.forEach((farm) => {
      const ownerTerms = (farm.owners || []).flatMap((owner) => [owner.name, owner.email]);
      const farmScore = score(normalized, [farm.name, farm.location, farm.address, farm.id, ...ownerTerms]);
      if (farmScore) found.push({ kind: "farm", farm, score: farmScore });
      (farm.nodes || []).forEach((node) => {
        const nodeScore = score(normalized, [node.name, node.id, node.serial_number, node.type, node.zone?.name, node.zone?.crop_type, node.owner?.name, node.owner?.email, farm.name, ...ownerTerms]);
        if (nodeScore) found.push({ kind: "node", farm, node, score: nodeScore });
      });
    });
    return found.sort((a, b) => b.score - a.score || (a.kind === "farm" ? -1 : 1)).slice(0, 10);
  }, [farms, query]);

  const focus = (latitude: number | null | undefined, longitude: number | null | undefined) => {
    mapRef.current?.easeTo({ center: [coordinate(longitude, DEFAULT_LOCATION.longitude), coordinate(latitude, DEFAULT_LOCATION.latitude)], zoom: 15, duration: 360 });
    setQuery("");
    setUserTracking(null);
  };

  const selectedStyle = MAP_STYLES.find((style) => style.id === styleId) || MAP_STYLES[0];

  const handleMyLocation = async () => {
    try {
      await focusOnMyLocation("centeredOnYou");
    } catch {
      // focusOnMyLocation already shows a concrete permission/GPS error.
    }
  };

  const resetMapBearing = () => {
    mapRef.current?.setStop({ bearing: 0, pitch: 0, duration: 320 }).catch(() => undefined);
    setMapBearing(0);
    setLocationNotice(t("map.rotatedNorth"));
  };

  return <View style={[styles.screen, { backgroundColor: colors.background }]}>
    <SafeAreaView edges={["top"]} style={[styles.safeHeader, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}><View style={[styles.header, { backgroundColor: colors.surface }]}>
      <View><Text style={[styles.headerTitle, { color: colors.text }]}>{t("map.title")}</Text><Text style={[styles.headerSubtitle, { color: colors.textMuted }]}>{t("map.subtitle")}</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel={t("map.refreshA11y")} accessibilityState={{ busy: refreshing }} disabled={refreshing} onPress={() => load(true)} hitSlop={10} style={[styles.refresh, { backgroundColor: colors.primarySoft }, refreshing && styles.refreshDisabled]}>{refreshing ? <ActivityIndicator size="small" color={colors.primary} /> : <Icon name="refresh" size={19} color={colors.primary} />}</Pressable>
    </View></SafeAreaView>

    <Map
      style={styles.map}
      mapStyle={selectedStyle.url}
      logo={false}
      compass={false}
      scaleBar
      onDidFinishLoadingMap={() => setMapReady(true)}
      onRegionDidChange={(event) => {
        const { center, zoom, bearing, pitch } = event.nativeEvent;
        if (Number.isFinite(bearing)) setMapBearing(bearing);
        if (canPersistViewportRef.current && center && Number.isFinite(center[0]) && Number.isFinite(center[1])) {
          void AsyncStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify({ center, zoom, bearing, pitch })).catch(() => undefined);
        }
        if (event.nativeEvent.userInteraction && userTracking) {
          setUserTracking(null);
          setLocationNotice(t("map.stoppedTracking"));
        }
      }}
    >
      <Camera ref={mapRef} initialViewState={{ center: [initialLocation.longitude, initialLocation.latitude], zoom: 11 }} trackUserLocation={userTracking === "heading" ? "default" : userTracking || undefined} />
      {hasUserLocation ? <NativeUserLocation mode="heading" androidPreferredFramesPerSecond={30} /> : null}
      {farms.map((farm) => {
        const latitude = coordinate(farm.latitude, DEFAULT_LOCATION.latitude);
        const longitude = coordinate(farm.longitude, DEFAULT_LOCATION.longitude);
        return <React.Fragment key={farm.id}>
          <Marker lngLat={[longitude, latitude]} anchor="bottom" onPress={() => focus(latitude, longitude)}><View style={styles.farmMarker}><Icon name="sprout" size={16} color="#fff" /></View></Marker>
          {(farm.nodes || []).map((node) => <Marker key={node.id} lngLat={[coordinate(node.longitude, longitude), coordinate(node.latitude, latitude)]} anchor="bottom" onPress={() => focus(node.latitude, node.longitude)}><View style={[styles.nodeMarker, node.online ? styles.nodeMarkerOnline : styles.nodeMarkerOffline]} /></Marker>)}
        </React.Fragment>;
      })}
    </Map>

    <View style={styles.searchPanel}>
      <View style={styles.searchBox}><Icon name="search" size={20} color="#64748b" /><TextInput accessibilityLabel={t("map.searchA11y")} value={query} onChangeText={setQuery} placeholder={t("map.searchPlaceholder")} placeholderTextColor="#94a3b8" style={styles.searchInput} autoCorrect={false} returnKeyType="search" />{query ? <Pressable accessibilityRole="button" accessibilityLabel={t("map.clearSearchA11y")} onPress={() => setQuery("")}><Text style={styles.clear}>{t("map.clearSearch")}</Text></Pressable> : null}</View>
      {hits.length > 0 && <ScrollView keyboardShouldPersistTaps="handled" style={styles.results}><Text style={styles.resultLabel}>{t("map.topResults")}</Text>{hits.map((hit) => <Pressable key={hit.kind === "farm" ? `farm-${hit.farm.id}` : `node-${hit.node.id}`} accessibilityRole="button" accessibilityLabel={t("map.openHitA11y", { kind: hit.kind === "farm" ? "farm" : "node", name: hit.kind === "farm" ? hit.farm.name : hit.node.name || hit.node.id })} onPress={() => focus(hit.kind === "farm" ? hit.farm.latitude : hit.node.latitude, hit.kind === "farm" ? hit.farm.longitude : hit.node.longitude)} style={styles.result}><View style={[styles.resultIcon, hit.kind === "farm" ? styles.farmIcon : styles.nodeIcon]}><Icon name={hit.kind === "farm" ? "sprout" : "cpu"} size={16} color={hit.kind === "farm" ? "#16704a" : "#2563eb"} /></View><View style={styles.resultText}><Text style={styles.resultTitle} numberOfLines={1}>{hit.kind === "farm" ? hit.farm.name : hit.node.name || hit.node.id}</Text><Text style={styles.resultSubtitle} numberOfLines={1}>{hit.kind === "farm" ? `${(hit.farm.owners || []).map((owner) => owner.name || owner.email).filter(Boolean).join(", ") || t("map.unassignedOwner")} · ${t("map.devicesCount", { count: hit.farm.nodes?.length || 0 })}` : `${hit.farm.name} · ${hit.node.zone?.name || t("map.unassignedZone")}`}</Text></View></Pressable>)}</ScrollView>}
    </View>

    <View style={styles.layerControl}>
      {showLayers ? <View style={styles.layerSheet}>{MAP_STYLES.map((style) => <Pressable key={style.id} accessibilityRole="radio" accessibilityState={{ checked: styleId === style.id }} accessibilityLabel={t("map.layerLabel", { label: getStyleLabel(style.id) })} onPress={() => { setStyleId(style.id); setShowLayers(false); setLocationNotice(t("map.switchedToLayer", { label: getStyleLabel(style.id) })); }} style={[styles.layerOption, styleId === style.id && styles.layerOptionSelected]}><MapStylePreview style={style} /><View style={styles.layerCopy}><Text style={[styles.layerOptionText, styleId === style.id && styles.layerOptionTextSelected]}>{getStyleLabel(style.id)}</Text></View></Pressable>)}</View> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={t("map.layerButtonA11y", { label: getStyleLabel(selectedStyle.id) })} accessibilityState={{ expanded: showLayers }} onPress={() => setShowLayers((current) => !current)} style={styles.layerToggle}><MapStylePreview style={selectedStyle} compact /><View style={styles.layerToggleLabel}><Icon name="map" size={13} color="#ffffff" /><Text style={styles.layerToggleText}>{t("map.layerButtonText")}</Text></View></Pressable>
    </View>

    {locationNotice ? <Pressable accessibilityRole="button" accessibilityLabel={t("map.hideNoticeA11y")} accessibilityLiveRegion="polite" onPress={() => setLocationNotice(null)} style={styles.notice}><Text style={styles.noticeText}>{locationNotice}</Text></Pressable> : null}

    <View style={styles.mapActions}>
      {Math.abs(mapBearing) > 1 ? <Pressable accessibilityRole="button" accessibilityLabel={t("map.rotateNorth")} onPress={resetMapBearing} style={styles.mapAction}><Icon name="compass" size={20} color="#16704a" /></Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={t("map.toCurrentLocation")} accessibilityState={{ busy: isLocating }} disabled={isLocating} onPress={handleMyLocation} style={[styles.mapAction, isLocating && styles.mapActionDisabled]}><Icon name="location" size={21} color="#16704a" /></Pressable>
    </View>

    {loading && <View style={styles.state}><ActivityIndicator size="large" color="#16704a" /><Text style={styles.stateText}>{t("map.loadingMap")}</Text></View>}
    {error && !loading && <View style={styles.state}><Text style={styles.errorTitle}>{t("map.failedToLoadMap")}</Text><Text style={styles.stateText}>{error}</Text><Pressable accessibilityRole="button" onPress={() => load()} style={styles.retry}><Text style={styles.retryText}>{t("map.retry")}</Text></Pressable></View>}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f8fafc" },
  safeHeader: { backgroundColor: "#ffffff", borderBottomColor: "#e2e8f0", borderBottomWidth: 1 },
  header: { alignItems: "center", backgroundColor: "#ffffff", flexDirection: "row", gap: 10, minHeight: 64, paddingHorizontal: 16, paddingTop: Platform.OS === "android" ? 8 : 0 },
  headerTitle: { color: "#0f172a", fontSize: 17, fontWeight: fontWeight.bold }, headerSubtitle: { color: "#64748b", fontSize: 11, fontWeight: fontWeight.semibold, marginTop: 2 },
  refresh: { alignItems: "center", backgroundColor: "#eaf8ee", borderRadius: 18, height: 36, justifyContent: "center", marginLeft: "auto", width: 36 }, refreshDisabled: { opacity: 0.6 }, map: { flex: 1 },
  farmMarker: { alignItems: "center", backgroundColor: "#0f8b5f", borderColor: "#fff", borderRadius: 16, borderWidth: 2, height: 32, justifyContent: "center", width: 32 },
  nodeMarker: { borderColor: "#fff", borderRadius: 8, borderWidth: 2, height: 16, width: 16 }, nodeMarkerOnline: { backgroundColor: "#2563eb" }, nodeMarkerOffline: { backgroundColor: "#64748b" },
  searchPanel: { left: 14, position: "absolute", right: 14, top: Platform.OS === "ios" ? 128 : 96 },
  searchBox: { alignItems: "center", backgroundColor: "#ffffff", borderColor: "#dbe5df", borderRadius: 14, borderWidth: 1, elevation: 4, flexDirection: "row", gap: 9, minHeight: 52, paddingHorizontal: 14, shadowColor: "#0f172a", shadowOpacity: 0.14, shadowRadius: 9 },
  searchInput: { color: "#0f172a", flex: 1, fontSize: 14, fontWeight: fontWeight.semibold, paddingVertical: 0 }, clear: { color: "#16704a", fontSize: 12, fontWeight: fontWeight.bold },
  results: { backgroundColor: "#ffffff", borderColor: "#dbe5df", borderRadius: 14, borderWidth: 1, elevation: 4, marginTop: 8, maxHeight: 290, shadowColor: "#0f172a", shadowOpacity: 0.1, shadowRadius: 9 },
  resultLabel: { color: "#64748b", fontSize: 11, fontWeight: fontWeight.bold, letterSpacing: 0.4, paddingHorizontal: 14, paddingTop: 12, textTransform: "uppercase" },
  result: { alignItems: "center", borderBottomColor: "#f1f5f9", borderBottomWidth: 1, flexDirection: "row", gap: 10, minHeight: 60, paddingHorizontal: 14 }, resultIcon: { alignItems: "center", borderRadius: 10, height: 34, justifyContent: "center", width: 34 }, farmIcon: { backgroundColor: "#eaf8ee" }, nodeIcon: { backgroundColor: "#eff6ff" }, resultText: { flex: 1 }, resultTitle: { color: "#0f172a", fontSize: 14, fontWeight: fontWeight.bold }, resultSubtitle: { color: "#64748b", fontSize: 12, fontWeight: fontWeight.medium, marginTop: 2 },
  layerControl: { bottom: 18, left: 14, position: "absolute" },
  layerSheet: { backgroundColor: "#ffffff", borderColor: "#dbe5df", borderRadius: 16, borderWidth: 1, bottom: 68, elevation: 6, gap: 7, padding: 8, shadowColor: "#0f172a", shadowOpacity: 0.16, shadowRadius: 10, width: 148 },
  layerOption: { alignItems: "center", borderColor: "transparent", borderRadius: 11, borderWidth: 2, flexDirection: "row", gap: 8, padding: 5, width: 130 }, layerOptionSelected: { backgroundColor: "#eaf8ee", borderColor: "#0f8b5f" }, layerCopy: { flex: 1, minWidth: 0 }, layerOptionText: { color: "#334155", fontSize: 12, fontWeight: fontWeight.bold, lineHeight: 15 }, layerOptionTextSelected: { color: "#087c52" },
  stylePreview: { borderColor: "rgba(15, 23, 42, 0.12)", borderRadius: 8, borderWidth: 1, height: 50, overflow: "hidden", width: 52 }, stylePreviewCompact: { borderRadius: 0, borderWidth: 0, height: "100%", width: "100%" }, previewWater: { borderRadius: 20, height: 60, position: "absolute", right: -26, top: -22, transform: [{ rotate: "-20deg" }], width: 38 }, previewRoad: { height: 5, left: -10, position: "absolute", top: 27, transform: [{ rotate: "-26deg" }], width: 82 }, previewMinorRoad: { height: 3, left: -6, opacity: 0.94, position: "absolute", top: 16, transform: [{ rotate: "42deg" }], width: 72 }, previewBadge: { alignItems: "center", backgroundColor: "rgba(15, 23, 42, 0.64)", borderRadius: 10, bottom: 4, height: 20, justifyContent: "center", left: 4, position: "absolute", width: 20 },
  layerToggle: { backgroundColor: "#ffffff", borderColor: "#dbe5df", borderRadius: 14, borderWidth: 1, elevation: 5, height: 58, overflow: "hidden", shadowColor: "#0f172a", shadowOpacity: 0.14, shadowRadius: 8, width: 58 }, layerToggleLabel: { alignItems: "center", backgroundColor: "rgba(15, 23, 42, 0.72)", bottom: 0, flexDirection: "row", gap: 2, justifyContent: "center", left: 0, paddingVertical: 4, position: "absolute", right: 0 }, layerToggleText: { color: "#ffffff", fontSize: 9, fontWeight: fontWeight.bold },
  notice: { backgroundColor: "rgba(15, 23, 42, 0.92)", borderRadius: 12, bottom: 80, left: 94, maxWidth: 260, paddingHorizontal: 12, paddingVertical: 9, position: "absolute", right: 72 }, noticeText: { color: "#ffffff", fontSize: 12, fontWeight: fontWeight.medium, lineHeight: 17, textAlign: "center" },
  mapActions: { alignItems: "center", bottom: 18, gap: 10, position: "absolute", right: 14 },
  mapAction: { alignItems: "center", backgroundColor: "#ffffff", borderColor: "#dbe5df", borderRadius: 14, borderWidth: 1, elevation: 5, height: 46, justifyContent: "center", shadowColor: "#0f172a", shadowOpacity: 0.14, shadowRadius: 8, width: 46 },
  mapActionDisabled: { opacity: 0.55 },
  state: { alignItems: "center", backgroundColor: "#ffffff", borderRadius: 16, left: 28, padding: 20, position: "absolute", right: 28, top: "43%" }, stateText: { color: "#64748b", fontSize: 13, fontWeight: fontWeight.semibold, marginTop: 10, textAlign: "center" }, errorTitle: { color: "#b91c1c", fontSize: 16, fontWeight: fontWeight.bold }, retry: { backgroundColor: "#16704a", borderRadius: 10, marginTop: 14, paddingHorizontal: 16, paddingVertical: 10 }, retryText: { color: "#ffffff", fontSize: 13, fontWeight: fontWeight.bold },
});
