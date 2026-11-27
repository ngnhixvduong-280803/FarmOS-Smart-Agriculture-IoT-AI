import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import maplibreglWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

maplibregl.config.WORKER_URL = maplibreglWorkerUrl;
import {
  Navigation,
  MapPin,
  Plus,
  Minus,
  Layers,
  Search,
  X,
  Compass,
  Cpu,
  Loader2,
  Building2,
  GraduationCap,
  Store,
  Utensils,
  Train,
  Route,
  Copy,
  Check,
  ExternalLink,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { NodeDevice, FarmItem } from "../types";
import {
  searchLocations,
  SearchResultItem,
  PlaceCategory,
  formatDistance,
} from "../services/location-search.service";
import { getStoredMapState, updateStoredMapState } from "../services/map-state.service";
import {
  getCurrentPositionWithFallback,
  getFriendlyGpsErrorMessage,
} from "../services/geolocation.service";
import { useI18n } from "../context/I18nContext";

export type MapLayerType =
  | "google_hybrid"
  | "google_streets"
  | "google_terrain"
  | "esri_satellite"
  | "osm";

export interface MapLayerOption {
  id: MapLayerType;
  name: string;
  thumbnail: string;
}

export const MAP_LAYERS: MapLayerOption[] = [
  {
    id: "google_hybrid",
    name: "Google Vệ Tinh",
    thumbnail: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/6/28/51",
  },
  {
    id: "google_streets",
    name: "Google Đường Phố",
    thumbnail: "https://mt1.google.com/vt/lyrs=m&x=13&y=7&z=4",
  },
  {
    id: "esri_satellite",
    name: "Esri Vệ Tinh",
    thumbnail: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/4/7/12",
  },
  {
    id: "osm",
    name: "Bản Đồ Số OSM",
    thumbnail: "https://a.tile.openstreetmap.org/4/12/7.png",
  },
];

const MAP_SOURCE_ID = "farm-devices";
const CLUSTER_LAYER_ID = "farm-devices-clusters";
const NODE_OUTLINE_LAYER_ID = "farm-devices-outline";
const NODE_LAYER_ID = "farm-devices-points";
const FARM_SOURCE_ID = "farm-overview";
const FARM_OUTLINE_LAYER_ID = "farm-overview-outline";
const FARM_LAYER_ID = "farm-overview-points";
const FARM_LABEL_LAYER_ID = "farm-overview-labels";

type DeviceMapFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { nodeId: string; color: string; selected: boolean };
};

type FarmMapFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { farmId: string; label: string; nodeCount: number };
};

type LocalSearchResult =
  | { kind: "farm"; score: number; farm: FarmItem }
  | { kind: "node"; score: number; node: NodeDevice };

const normalizeSearchText = (value: string | null | undefined) =>
  (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase()
    .trim();

const finiteCoordinate = (value: number | null | undefined, fallback: number) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
};

const LAYER_STYLES: Record<MapLayerType, maplibregl.StyleSpecification> = {
  google_hybrid: {
    version: 8,
    sources: {
      "google-hybrid-base": {
        type: "raster",
        tiles: [
          "https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
          "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
          "https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
          "https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
        ],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 8,
      },
      "google-hybrid": {
        type: "raster",
        tiles: [
          "https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
          "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
          "https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
          "https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
        ],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 22,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": "#0d1b2a",
        },
      },
      {
        id: "google-hybrid-base-layer",
        type: "raster",
        source: "google-hybrid-base",
        paint: {
          "raster-fade-duration": 0,
          "raster-resampling": "linear",
        },
      },
      {
        id: "google-hybrid-layer",
        type: "raster",
        source: "google-hybrid",
        paint: {
          "raster-fade-duration": 250,
          "raster-resampling": "linear",
        },
      },
    ],
  },
  google_streets: {
    version: 8,
    sources: {
      "google-streets-base": {
        type: "raster",
        tiles: [
          "https://mt0.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
          "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
          "https://mt2.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
          "https://mt3.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
        ],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 8,
      },
      "google-streets": {
        type: "raster",
        tiles: [
          "https://mt0.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
          "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
          "https://mt2.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
          "https://mt3.google.com/vt/lyrs=m&x={x}&y={y}&z={z}",
        ],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 22,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": "#f1f3f4",
        },
      },
      {
        id: "google-streets-base-layer",
        type: "raster",
        source: "google-streets-base",
        paint: {
          "raster-fade-duration": 0,
          "raster-resampling": "linear",
        },
      },
      {
        id: "google-streets-layer",
        type: "raster",
        source: "google-streets",
        paint: {
          "raster-fade-duration": 250,
          "raster-resampling": "linear",
        },
      },
    ],
  },
  google_terrain: {
    version: 8,
    sources: {
      "google-terrain-base": {
        type: "raster",
        tiles: [
          "https://mt0.google.com/vt/lyrs=p&x={x}&y={y}&z={z}",
          "https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}",
          "https://mt2.google.com/vt/lyrs=p&x={x}&y={y}&z={z}",
          "https://mt3.google.com/vt/lyrs=p&x={x}&y={y}&z={z}",
        ],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 8,
      },
      "google-terrain": {
        type: "raster",
        tiles: [
          "https://mt0.google.com/vt/lyrs=p&x={x}&y={y}&z={z}",
          "https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}",
          "https://mt2.google.com/vt/lyrs=p&x={x}&y={y}&z={z}",
          "https://mt3.google.com/vt/lyrs=p&x={x}&y={y}&z={z}",
        ],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 20,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": "#e5e3df",
        },
      },
      {
        id: "google-terrain-base-layer",
        type: "raster",
        source: "google-terrain-base",
        paint: {
          "raster-fade-duration": 0,
          "raster-resampling": "linear",
        },
      },
      {
        id: "google-terrain-layer",
        type: "raster",
        source: "google-terrain",
        paint: {
          "raster-fade-duration": 250,
          "raster-resampling": "linear",
        },
      },
    ],
  },
  esri_satellite: {
    version: 8,
    sources: {
      "esri-satellite-base": {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 8,
      },
      "esri-satellite": {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": "#0d1b2a",
        },
      },
      {
        id: "esri-satellite-base-layer",
        type: "raster",
        source: "esri-satellite-base",
        paint: {
          "raster-fade-duration": 0,
          "raster-resampling": "linear",
        },
      },
      {
        id: "esri-satellite-layer",
        type: "raster",
        source: "esri-satellite",
        paint: {
          "raster-fade-duration": 250,
          "raster-resampling": "linear",
        },
      },
    ],
  },
  osm: {
    version: 8,
    sources: {
      "osm-base": {
        type: "raster",
        tiles: [
          "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 8,
      },
      osm: {
        type: "raster",
        tiles: [
          "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": "#f2efe9",
        },
      },
      {
        id: "osm-base-layer",
        type: "raster",
        source: "osm-base",
        paint: {
          "raster-fade-duration": 0,
          "raster-resampling": "linear",
        },
      },
      {
        id: "osm-layer",
        type: "raster",
        source: "osm",
        paint: {
          "raster-fade-duration": 250,
          "raster-resampling": "linear",
        },
      },
    ],
  },
};

interface FarmMapProps {
  farms: FarmItem[];
  selectedNodeId?: string | null;
  editingNodeId?: string | null;
  onSelectNode?: (node: NodeDevice) => void;
  onQuickIrrigate?: (node: NodeDevice) => void;
  pickerMode?: boolean;
  pickerCoords?: { lat: number; lng: number } | null;
  onLocationSelect?: (lat: number, lng: number) => void;
  height?: string;
  onClearNodeSelection?: () => void;
  isActive?: boolean;
}

export const FarmMap: React.FC<FarmMapProps> = ({
  farms,
  selectedNodeId,
  editingNodeId,
  onSelectNode,
  onQuickIrrigate,
  pickerMode = false,
  pickerCoords,
  onLocationSelect,
  height = "100%",
  onClearNodeSelection,
  isActive = true,
}) => {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;

  const getLayerName = useCallback(
    (id: MapLayerType) => {
      switch (id) {
        case "google_hybrid":
          return t.farmMap.layerGoogleSat;
        case "google_streets":
          return t.farmMap.layerGoogleStreet;
        case "esri_satellite":
          return t.farmMap.layerEsriSat;
        case "osm":
          return t.farmMap.layerOsm;
        default:
          return id;
      }
    },
    [t]
  );

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapShellRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<maplibregl.Map | null>(null);
  const pickerMarkerRef = useRef<maplibregl.Marker | null>(null);
  const isDraggingPickerMarkerRef = useRef(false);
  const nodeIndexRef = useRef(new Map<string, NodeDevice>());
  const nodeDataRef = useRef<{ type: "FeatureCollection"; features: DeviceMapFeature[] }>({
    type: "FeatureCollection",
    features: [],
  });
  const farmDataRef = useRef<{ type: "FeatureCollection"; features: FarmMapFeature[] }>({
    type: "FeatureCollection",
    features: [],
  });
  const farmIndexRef = useRef(new Map<string, FarmItem>());
  const onSelectNodeRef = useRef(onSelectNode);
  const onLocationSelectRef = useRef(onLocationSelect);
  const onClearNodeSelectionRef = useRef(onClearNodeSelection);
  const pickerModeRef = useRef(pickerMode);
  const activeMapTypeRef = useRef<MapLayerType>("google_hybrid");
  const lastAutoCenterRef = useRef<string | null>(null);

  const layerMenuRef = useRef<HTMLDivElement>(null);
  const userLocationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const userLocationRef = useRef<{ lat: number; lng: number; accuracy?: number; heading?: number | null } | null>(null);

  const savedState = useMemo(() => getStoredMapState(), []);

  const [mapType, setMapType] = useState<MapLayerType>(() =>
    savedState?.mapType && MAP_LAYERS.some((layer) => layer.id === savedState.mapType)
      ? savedState.mapType
      : "google_hybrid"
  );
  const [showLayerMenu, setShowLayerMenu] = useState(false);
  const [isCenteredOnUser, setIsCenteredOnUser] = useState(false);

  // Compass / device heading tracking & Compass Mode
  const userHeadingRef = useRef<number>(0);
  const currentBeamAngleRef = useRef<number>(0);
  const isCompassModeRef = useRef<boolean>(false);
  const [isCompassMode, setIsCompassMode] = useState<boolean>(false);
  const [mapBearing, setMapBearing] = useState<number>(0);

  // Request compass / device orientation permission (Mandatory for iOS 13+ Safari)
  const requestCompassPermission = async (): Promise<boolean> => {
    if (typeof (DeviceOrientationEvent as any)?.requestPermission === "function") {
      try {
        const res = await (DeviceOrientationEvent as any).requestPermission();
        return res === "granted";
      } catch (err) {
        console.warn("DeviceOrientation requestPermission error:", err);
        return false;
      }
    }
    return true;
  };

  // Apply new heading to marker beam and optionally rotate map camera
  const applyNewHeading = useCallback((headingDeg: number) => {
    if (headingDeg == null || isNaN(headingDeg)) return;
    userHeadingRef.current = headingDeg;

    if (mapInstanceRef.current) {
      const map = mapInstanceRef.current;
      const b = map.getBearing() || 0;

      // Calculate beam angle relative to current map camera rotation
      const targetRelativeAngle = (headingDeg - b + 360) % 360;

      // Smooth low-pass filter to eliminate sensor jitter
      let diff = (targetRelativeAngle - currentBeamAngleRef.current) % 360;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      currentBeamAngleRef.current = (currentBeamAngleRef.current + diff * 0.35 + 360) % 360;

      if (userLocationMarkerRef.current) {
        const el = userLocationMarkerRef.current.getElement();
        const headingEl = el.querySelector(".user-location-heading") as HTMLElement | null;
        if (headingEl) {
          headingEl.style.transform = `rotate(${currentBeamAngleRef.current}deg)`;
          headingEl.style.display = "block";
        }
      }

      // If in Compass Mode (Google Maps style: map dynamically rotates with your facing direction)
      if (isCompassModeRef.current) {
        map.rotateTo(headingDeg, { duration: 150 });
      }
    }
  }, []);

  useEffect(() => {
    isCompassModeRef.current = isCompassMode;
  }, [isCompassMode]);

  useEffect(() => {
    const computeHeading = (e: DeviceOrientationEvent): number | null => {
      // 1. iOS Safari: webkitCompassHeading is exact true North compass heading (0-360 clockwise)
      if ((e as any).webkitCompassHeading != null) {
        const val = (e as any).webkitCompassHeading;
        if (!isNaN(val) && val >= 0) return val;
      }

      // 2. Android: Compute 3D horizontal ground projection from alpha, beta, gamma
      const { alpha, beta, gamma } = e;
      if (alpha != null && !isNaN(alpha)) {
        if (beta != null && gamma != null) {
          const degToRad = Math.PI / 180;
          const radToDeg = 180 / Math.PI;

          const _x = beta * degToRad; // pitch
          const _y = gamma * degToRad; // roll
          const _z = alpha * degToRad; // yaw

          const cX = Math.cos(_x);
          const cY = Math.cos(_y);
          const cZ = Math.cos(_z);
          const sX = Math.sin(_x);
          const sY = Math.sin(_y);
          const sZ = Math.sin(_z);

          // Vector pointing out of the top of the phone projected onto horizontal plane
          const vX = -cZ * sY - sZ * sX * cY;
          const vY = -sZ * sY + cZ * sX * cY;

          let heading = Math.atan2(vX, vY) * radToDeg;
          if (heading < 0) heading += 360;

          // Screen rotation compensation (Portrait vs Landscape)
          const screenAngle =
            typeof window !== "undefined"
              ? window.screen?.orientation?.angle || (window.orientation as number) || 0
              : 0;

          return (heading + screenAngle) % 360;
        }

        return (360 - alpha) % 360;
      }

      return null;
    };

    const handleOrientation = (e: DeviceOrientationEvent) => {
      const heading = computeHeading(e);
      if (heading != null && !isNaN(heading)) {
        applyNewHeading(heading);
      }
    };

    window.addEventListener("deviceorientationabsolute", handleOrientation, true);
    window.addEventListener("deviceorientation", handleOrientation, true);

    // Generic Sensor API support (Chrome on Android)
    let sensor: any = null;
    if (typeof window !== "undefined" && "AbsoluteOrientationSensor" in window) {
      try {
        sensor = new (window as any).AbsoluteOrientationSensor({ frequency: 60 });
        sensor.addEventListener("reading", () => {
          const q = sensor.quaternion;
          if (q && q.length === 4) {
            const heading =
              Math.atan2(
                2 * (q[0] * q[1] + q[2] * q[3]),
                1 - 2 * (q[1] * q[1] + q[2] * q[2])
              ) * (180 / Math.PI);
            const deg = (heading + 360) % 360;
            applyNewHeading(deg);
          }
        });
        sensor.start();
      } catch (e) {}
    }

    return () => {
      window.removeEventListener("deviceorientationabsolute", handleOrientation, true);
      window.removeEventListener("deviceorientation", handleOrientation, true);
      if (sensor) {
        try {
          sensor.stop();
        } catch (e) {}
      }
    };
  }, [applyNewHeading]);

  // Search & Places State
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchingAddress, setSearchingAddress] = useState(false);
  const [activeSearchPlace, setActiveSearchPlace] = useState<SearchResultItem | null>(null);
  const [copiedCoords, setCopiedCoords] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [showDropdown, setShowDropdown] = useState(false);
  const [gpsLocating, setGpsLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const showLocationNotice = useCallback((msg: string | null, autoDismissMs = 6000) => {
    if (noticeTimeoutRef.current) {
      clearTimeout(noticeTimeoutRef.current);
      noticeTimeoutRef.current = null;
    }
    setLocationNotice(msg);
    if (msg && autoDismissMs > 0) {
      noticeTimeoutRef.current = setTimeout(() => {
        setLocationNotice(null);
      }, autoDismissMs);
    }
  }, []);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const searchMarkerRef = useRef<maplibregl.Marker | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  // Close search dropdown when clicking outside
  useEffect(() => {
    const handleSearchClickOutside = (e: MouseEvent | TouchEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleSearchClickOutside);
    document.addEventListener("touchstart", handleSearchClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleSearchClickOutside);
      document.removeEventListener("touchstart", handleSearchClickOutside);
    };
  }, []);

  // Real-time debounced location search with proximity bias
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearchingAddress(false);
      setShowDropdown(false);
      setSelectedIndex(-1);
      return;
    }

    setShowDropdown(true);

    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
    }
    const abortController = new AbortController();
    searchAbortRef.current = abortController;

    const timer = setTimeout(async () => {
      setSearchingAddress(true);
      try {
        const center = mapInstanceRef.current?.getCenter();
        const centerLat = center ? center.lat : (farms[0]?.latitude || defaultLat);
        const centerLng = center ? center.lng : (farms[0]?.longitude || defaultLng);

        const results = await searchLocations(trimmed, centerLat, centerLng, abortController.signal);
        setSearchResults(results);
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("Lỗi tìm kiếm vị trí:", err);
        }
      } finally {
        setSearchingAddress(false);
      }
    }, 280);

    return () => {
      clearTimeout(timer);
    };
  }, [searchQuery, farms]);

  const defaultLat = 10.854886;
  const defaultLng = 106.786523;

  // Handle click outside layer menu to close it
  useEffect(() => {
    if (!showLayerMenu) return;

    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (layerMenuRef.current && !layerMenuRef.current.contains(event.target as Node)) {
        setShowLayerMenu(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowLayerMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showLayerMenu]);

  onSelectNodeRef.current = onSelectNode;
  onLocationSelectRef.current = onLocationSelect;
  onClearNodeSelectionRef.current = onClearNodeSelection;
  pickerModeRef.current = pickerMode;

  // Flatten all nodes from farms
  const allNodes: NodeDevice[] = useMemo(() => {
    const list: NodeDevice[] = [];
    farms.forEach((f) => {
      if (f.nodes) {
        f.nodes.forEach((n) => list.push({ ...n, farm: f }));
      }
    });
    return list;
  }, [farms]);

  // Local search is instant and accent-insensitive. External place search remains debounced below.
  const localSearchResults = useMemo<LocalSearchResult[]>(() => {
    const query = normalizeSearchText(searchQuery);
    if (!query) return [];
    const score = (values: Array<string | null | undefined>) => {
      const candidates = values.map(normalizeSearchText).filter(Boolean);
      if (candidates.some((value) => value === query)) return 100;
      if (candidates.some((value) => value.startsWith(query))) return 80;
      if (candidates.some((value) => value.includes(query))) return 55;
      return 0;
    };

    const farmsFound = farms.flatMap((farm) => {
      const ownerTerms = (farm.owners || []).flatMap((owner) => [owner.name, owner.email]);
      const zoneTerms = (farm.zones || []).flatMap((zone) => [zone.name, zone.crop_type]);
      const resultScore = score([farm.name, farm.id, farm.location, farm.address, ...ownerTerms, ...zoneTerms]);
      return resultScore ? [{ kind: "farm" as const, score: resultScore, farm }] : [];
    });
    const nodesFound = allNodes.flatMap((node) => {
      const farm = farms.find((item) => item.id === node.farm?.id);
      const ownerTerms = [
        node.owner?.name,
        node.owner?.email,
        ...(farm?.owners || []).flatMap((owner) => [owner.name, owner.email]),
      ];
      const resultScore = score([
        node.name,
        node.id,
        node.serial_number,
        node.type,
        node.zone?.name,
        node.zone?.crop_type,
        node.farm?.name,
        ...ownerTerms,
      ]);
      return resultScore ? [{ kind: "node" as const, score: resultScore, node }] : [];
    });

    return [...farmsFound, ...nodesFound]
      .sort((a, b) => b.score - a.score || (a.kind === "farm" ? -1 : 1))
      .slice(0, 12);
  }, [allNodes, farms, searchQuery]);

  const nodeData = useMemo(() => {
    const nodeIndex = new Map<string, NodeDevice>();
    // Exclude device being positioned from background circle dots so it is represented purely by the interactive draggable pin
    const targetEditingId = editingNodeId || (pickerMode ? selectedNodeId : null);
    const filteredNodes = targetEditingId
      ? allNodes.filter((n) => n.id !== targetEditingId)
      : allNodes;

    const features = filteredNodes.map((node) => {
      nodeIndex.set(node.id, node);
      const moisture = node.latest_telemetry?.soil_moisture;
      const color = !node.online
        ? "#64748b"
        : node.type === "GATEWAY"
          ? "#2563eb"
          : moisture !== undefined && moisture !== null && moisture < 45
            ? "#f59e0b"
            : moisture !== undefined && moisture !== null && moisture > 80
              ? "#0284c7"
              : "#059669";

      return {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [
            finiteCoordinate(node.longitude, defaultLng),
            finiteCoordinate(node.latitude, defaultLat),
          ] as [number, number],
        },
        properties: {
          nodeId: node.id,
          color,
          selected: node.id === selectedNodeId,
        },
      };
    });

    nodeIndexRef.current = nodeIndex;
    return { type: "FeatureCollection" as const, features };
  }, [allNodes, selectedNodeId, editingNodeId, pickerMode]);

  nodeDataRef.current = nodeData;

  const farmData = useMemo(() => {
    const index = new Map<string, FarmItem>();
    const features = farms.map((farm) => {
      index.set(farm.id, farm);
      return {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [
            finiteCoordinate(farm.longitude, defaultLng),
            finiteCoordinate(farm.latitude, defaultLat),
          ] as [number, number],
        },
        properties: { farmId: farm.id, label: farm.name, nodeCount: farm.nodes?.length || 0 },
      };
    });
    farmIndexRef.current = index;
    return { type: "FeatureCollection" as const, features };
  }, [farms]);

  farmDataRef.current = farmData;

  const syncDeviceSource = useCallback((map: maplibregl.Map) => {
    const source = map.getSource(MAP_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(nodeDataRef.current);
  }, []);

  const syncFarmSource = useCallback((map: maplibregl.Map) => {
    const source = map.getSource(FARM_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData(farmDataRef.current);
  }, []);

  const installDeviceLayers = useCallback((map: maplibregl.Map) => {
    if (!map.getSource(MAP_SOURCE_ID)) {
      map.addSource(MAP_SOURCE_ID, {
        type: "geojson",
        data: nodeDataRef.current,
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 48,
      });
    }

    if (!map.getLayer(CLUSTER_LAYER_ID)) {
      map.addLayer({
        id: CLUSTER_LAYER_ID,
        type: "circle",
        source: MAP_SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#047857",
          "circle-radius": ["step", ["get", "point_count"], 18, 20, 22, 100, 27],
          "circle-opacity": 0.94,
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: NODE_OUTLINE_LAYER_ID,
        type: "circle",
        source: MAP_SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["case", ["get", "selected"], 13, 10],
          "circle-color": "#ffffff",
          "circle-opacity": 0.95,
        },
      });
      map.addLayer({
        id: NODE_LAYER_ID,
        type: "circle",
        source: MAP_SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["case", ["get", "selected"], 10, 7],
          "circle-color": ["get", "color"],
          "circle-stroke-width": ["case", ["get", "selected"], 3, 1],
          "circle-stroke-color": "#0f172a",
        },
      });
    }

    syncDeviceSource(map);
  }, [syncDeviceSource]);

  const installFarmLayers = useCallback((map: maplibregl.Map) => {
    if (!map.getSource(FARM_SOURCE_ID)) {
      map.addSource(FARM_SOURCE_ID, { type: "geojson", data: farmDataRef.current });
    }
    if (!map.getLayer(FARM_OUTLINE_LAYER_ID)) {
      map.addLayer({
        id: FARM_OUTLINE_LAYER_ID, type: "circle", source: FARM_SOURCE_ID,
        paint: { "circle-radius": 15, "circle-color": "#ffffff", "circle-opacity": 0.96, "circle-stroke-width": 3, "circle-stroke-color": "#065f46" },
      });
      map.addLayer({
        id: FARM_LAYER_ID, type: "circle", source: FARM_SOURCE_ID,
        paint: { "circle-radius": 9, "circle-color": "#059669", "circle-stroke-width": 2, "circle-stroke-color": "#d1fae5" },
      });
      map.addLayer({
        id: FARM_LABEL_LAYER_ID, type: "symbol", source: FARM_SOURCE_ID, minzoom: 12,
        layout: { "text-field": ["get", "label"], "text-size": 12, "text-offset": [0, 2], "text-anchor": "top", "text-max-width": 12 },
        paint: { "text-color": "#064e3b", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
      });
    }
    syncFarmSource(map);
  }, [syncFarmSource]);

  const updateUserLocationMarker = useCallback(
    (
      map: maplibregl.Map,
      coords: { lat: number; lng: number; accuracy?: number; heading?: number | null }
    ) => {
      const { lat, lng, accuracy, heading } = coords;

      const formatPopupHTML = (acc?: number) => `
        <div style="font-family: inherit; font-size: 11px; font-weight: 700; color: #1e293b; padding: 4px 8px; display: flex; align-items: center; gap: 6px; white-space: nowrap;">
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#1a73e8; box-shadow: 0 0 0 2px #93c5fd;"></span>
          <span>${tRef.current.farmMap.myLocation}</span>
          ${acc ? `<span style="font-size: 10px; font-weight: 500; color: #64748b;">(±${Math.round(acc)}m)</span>` : ""}
        </div>
      `;

      if (!userLocationMarkerRef.current) {
        const container = document.createElement("div");
        container.className = "user-location-marker-container";
        container.setAttribute("title", tRef.current.farmMap.myLocation);

        // Direction beam / cone (Google Maps style)
        const headingEl = document.createElement("div");
        headingEl.className = "user-location-heading";

        const beamEl = document.createElement("div");
        beamEl.className = "user-location-beam";
        headingEl.appendChild(beamEl);

        const mapBearing = map.getBearing() || 0;
        const currentHeading = heading != null && !isNaN(heading) ? heading : (userHeadingRef.current || 0);
        const relativeAngle = (currentHeading - mapBearing + 360) % 360;
        headingEl.style.transform = `rotate(${relativeAngle}deg)`;
        headingEl.style.display = "block";

        // Radar pulse
        const pulseEl = document.createElement("div");
        pulseEl.className = "user-location-pulse";

        // Ambient halo
        const haloEl = document.createElement("div");
        haloEl.className = "user-location-halo";

        // Core blue dot
        const dotEl = document.createElement("div");
        dotEl.className = "user-location-dot";

        container.appendChild(headingEl);
        container.appendChild(pulseEl);
        container.appendChild(haloEl);
        container.appendChild(dotEl);

        const popup = new maplibregl.Popup({
          offset: 14,
          closeButton: false,
          closeOnClick: false,
          className: "user-location-popup",
        });
        popup.setHTML(formatPopupHTML(accuracy));

        const marker = new maplibregl.Marker({
          element: container,
          anchor: "center",
        })
          .setLngLat([lng, lat])
          .setPopup(popup)
          .addTo(map);

        container.addEventListener("mouseenter", () => {
          const p = marker.getPopup();
          if (p && !p.isOpen()) marker.togglePopup();
        });
        container.addEventListener("mouseleave", () => {
          const p = marker.getPopup();
          if (p && p.isOpen()) marker.togglePopup();
        });

        userLocationMarkerRef.current = marker;
      } else {
        const marker = userLocationMarkerRef.current;
        marker.setLngLat([lng, lat]);

        const markerEl = marker.getElement();
        if (!markerEl.parentElement) {
          marker.addTo(map);
        }

        const headingEl = markerEl.querySelector(".user-location-heading") as HTMLElement | null;
        if (headingEl) {
          if (!headingEl.querySelector(".user-location-beam")) {
            const beamEl = document.createElement("div");
            beamEl.className = "user-location-beam";
            headingEl.appendChild(beamEl);
          }
        const mapBearing = map.getBearing() || 0;
        const currentHeading = heading != null && !isNaN(heading) ? heading : (userHeadingRef.current || 0);
        const relativeAngle = (currentHeading - mapBearing + 360) % 360;
        headingEl.style.transform = `rotate(${relativeAngle}deg)`;
        headingEl.style.display = "block";
        }

        const popup = marker.getPopup();
        if (popup) {
          popup.setHTML(formatPopupHTML(accuracy));
        }
      }
    },
    []
  );

  // The base map and device points are rendered by a single WebGL canvas. This keeps panning,
  // zooming and telemetry refreshes off the DOM layout path and lets the browser pick the client GPU.
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const saved = getStoredMapState();

    const initLat =
      pickerCoords?.lat != null && !Number.isNaN(Number(pickerCoords.lat))
        ? Number(pickerCoords.lat)
        : saved?.center
          ? saved.center[1]
          : farms[0]?.latitude != null && !Number.isNaN(Number(farms[0].latitude))
            ? Number(farms[0].latitude)
            : defaultLat;
    const initLng =
      pickerCoords?.lng != null && !Number.isNaN(Number(pickerCoords.lng))
        ? Number(pickerCoords.lng)
        : saved?.center
          ? saved.center[0]
          : farms[0]?.longitude != null && !Number.isNaN(Number(farms[0].longitude))
            ? Number(farms[0].longitude)
            : defaultLng;

    const initZoom = pickerMode
      ? (pickerCoords?.lat != null ? 17 : (saved?.zoom != null ? saved.zoom : 15.5))
      : (saved?.zoom != null ? saved.zoom : 15);
    const initialMapType = saved?.mapType && MAP_LAYERS.some((layer) => layer.id === saved.mapType)
      ? saved.mapType
      : mapType;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: LAYER_STYLES[initialMapType],
      center: [initLng, initLat],
      zoom: initZoom,
      maxZoom: 22,
      minZoom: 2,
      trackResize: true,
      renderWorldCopies: true,
      fadeDuration: 200,
      maxTileCacheZoomLevels: 8,
    });

    const resizeObserver = new ResizeObserver(() => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.resize();
      }
    });
    if (mapContainerRef.current) {
      resizeObserver.observe(mapContainerRef.current);
    }

    const onStyleLoad = () => {
      map.resize();
      installDeviceLayers(map);
      installFarmLayers(map);
      if (!pickerModeRef.current && saved?.activeSearchPlace) {
        setActiveSearchPlace(saved.activeSearchPlace);
        updateSearchMarker(map, saved.activeSearchPlace);
      }
      if (saved?.userLocation) {
        userLocationRef.current = saved.userLocation;
        updateUserLocationMarker(map, saved.userLocation);
      } else if (userLocationRef.current) {
        updateUserLocationMarker(map, userLocationRef.current);
      }
    };
    const onDragStart = () => {
      setIsCenteredOnUser(false);
      setIsCompassMode(false);
    };
    const onRotateStart = () => {
      setIsCompassMode(false);
    };
    const onRotate = () => {
      const b = map.getBearing();
      setMapBearing(b);
      applyNewHeading(userHeadingRef.current);
    };
    const onMoveEnd = () => {
      if (!pickerModeRef.current) {
        const c = map.getCenter();
        updateStoredMapState({
          center: [c.lng, c.lat],
          zoom: map.getZoom(),
        });
      }
    };
    const onMapClick = (event: maplibregl.MapMouseEvent) => {
      if (pickerModeRef.current) {
        onLocationSelectRef.current?.(event.lngLat.lat, event.lngLat.lng);
        pickerMarkerRef.current?.setLngLat([event.lngLat.lng, event.lngLat.lat]);
        return;
      }

      const nodeFeature = map.queryRenderedFeatures(event.point, { layers: [NODE_LAYER_ID] })[0];
      const farmFeature = map.queryRenderedFeatures(event.point, { layers: [FARM_LAYER_ID] })[0];
      const clusterFeature = map.queryRenderedFeatures(event.point, { layers: [CLUSTER_LAYER_ID] })[0];

      if (nodeFeature) {
        setIsCenteredOnUser(false);
        setIsCompassMode(false);
        const node = nodeIndexRef.current.get(String(nodeFeature.properties?.nodeId));
        if (!node) return;
        onSelectNodeRef.current?.(node);
        map.flyTo({ center: nodeFeature.geometry.type === "Point" ? nodeFeature.geometry.coordinates as [number, number] : map.getCenter(), zoom: 18.5, speed: 1.3, curve: 1.35, essential: true });
        return;
      }

      if (farmFeature) {
        const farm = farmIndexRef.current.get(String(farmFeature.properties?.farmId));
        if (!farm || farmFeature.geometry.type !== "Point") return;
        setIsCenteredOnUser(false);
        const coordinates = farmFeature.geometry.coordinates as [number, number];
        const ownerNames = (farm.owners || []).map((owner) => owner.name || owner.email).join(", ");
        const popupContent = document.createElement("div");
        popupContent.style.cssText = "font:600 12px system-ui;color:#0f172a;padding:3px 5px";
        const title = document.createElement("strong");
        title.textContent = farm.name;
        const detail = document.createElement("span");
        detail.style.cssText = "display:block;font-weight:400;color:#475569";
        detail.textContent = `${farm.nodes?.length || 0} thiết bị${ownerNames ? ` · ${ownerNames}` : ""}`;
        popupContent.append(title, detail);
        new maplibregl.Popup({ offset: 16, closeButton: false })
          .setLngLat(coordinates)
          .setDOMContent(popupContent)
          .addTo(map);
        map.flyTo({ center: coordinates, zoom: Math.max(map.getZoom(), 16), speed: 1.15, essential: true });
        return;
      }

      if (clusterFeature) {
        setIsCenteredOnUser(false);
        setIsCompassMode(false);
        const source = map.getSource(MAP_SOURCE_ID) as maplibregl.GeoJSONSource;
        const clusterId = Number(clusterFeature.properties?.cluster_id);
        source.getClusterExpansionZoom(clusterId).then((zoom) => {
          const coordinates: [number, number] = clusterFeature.geometry.type === "Point"
            ? clusterFeature.geometry.coordinates as [number, number]
            : [event.lngLat.lng, event.lngLat.lat];
          map.easeTo({ center: coordinates, zoom, duration: 350 });
        });
        return;
      }
    };
    const onMouseMove = (event: maplibregl.MapMouseEvent) => {
      const interactive = map.queryRenderedFeatures(event.point, { layers: [CLUSTER_LAYER_ID, NODE_LAYER_ID] }).length > 0;
      map.getCanvas().style.cursor = interactive ? "pointer" : "";
    };

    map.on("load", () => {
      map.resize();
    });
    map.on("style.load", onStyleLoad);
    map.on("click", onMapClick);
    map.on("mousemove", onMouseMove);
    map.on("dragstart", onDragStart);
    map.on("rotatestart", onRotateStart);
    map.on("rotate", onRotate);
    map.on("moveend", onMoveEnd);
    mapInstanceRef.current = map;
    activeMapTypeRef.current = initialMapType;

    // On the very first map visit, request the user's location and make it the
    // starting viewport. Later visits must keep the viewport they deliberately
    // panned or zoomed to, which is already persisted by `onMoveEnd` above.
    if (!pickerMode && !saved?.hasInitialLocated && !saved?.center && navigator.geolocation) {
      getCurrentPositionWithFallback({
        highAccuracyTimeout: 6000,
        lowAccuracyTimeout: 10000,
        maximumAge: 60000,
      })
        .then((loc) => {
          const location = { lat: loc.latitude, lng: loc.longitude, accuracy: loc.accuracy, heading: loc.heading };
          userLocationRef.current = location;
          updateStoredMapState({
            userLocation: location,
            hasInitialLocated: true,
            center: [loc.longitude, loc.latitude],
            zoom: 16.5,
          });
          if (mapInstanceRef.current) {
            updateUserLocationMarker(mapInstanceRef.current, location);
            mapInstanceRef.current.flyTo({ center: [loc.longitude, loc.latitude], zoom: 16.5, speed: 1.25, essential: true });
          }
          setIsCenteredOnUser(true);
          showLocationNotice(tRef.current.farmMap.locatedUserNotice, 5000);
        })
        .catch(() => {
          // Do not repeatedly show the browser permission prompt during this
          // session. The explicit location button remains available to retry.
          updateStoredMapState({ hasInitialLocated: true });
        });
    }

    // Staggered resize checks ensure WebGL canvas matches modal and layout after CSS transitions
    const resizeTimers = [50, 150, 300, 600, 1000].map((delay) =>
      setTimeout(() => {
        if (mapInstanceRef.current) {
          mapInstanceRef.current.resize();
        }
      }, delay)
    );

    return () => {
      if (noticeTimeoutRef.current) {
        clearTimeout(noticeTimeoutRef.current);
      }
      resizeTimers.forEach(clearTimeout);
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      resizeObserver.disconnect();
      userLocationMarkerRef.current?.remove();
      userLocationMarkerRef.current = null;
      searchMarkerRef.current?.remove();
      searchMarkerRef.current = null;
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [installDeviceLayers, installFarmLayers, showLocationNotice, updateUserLocationMarker]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || activeMapTypeRef.current === mapType) return;
    activeMapTypeRef.current = mapType;
    map.setStyle(LAYER_STYLES[mapType]);
    updateStoredMapState({ mapType });
  }, [mapType]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const frame = requestAnimationFrame(() => {
      syncDeviceSource(map);
      syncFarmSource(map);
    });
    return () => cancelAnimationFrame(frame);
  }, [nodeData, farmData, syncDeviceSource, syncFarmSource]);

  useEffect(() => {
    if (isActive && mapInstanceRef.current) {
      mapInstanceRef.current.resize();
      const af = requestAnimationFrame(() => {
        mapInstanceRef.current?.resize();
      });
      const t = setTimeout(() => {
        mapInstanceRef.current?.resize();
      }, 50);
      return () => {
        cancelAnimationFrame(af);
        clearTimeout(t);
      };
    }
  }, [isActive]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (!pickerMode) {
      pickerMarkerRef.current?.remove();
      pickerMarkerRef.current = null;
      return;
    }

    const lat =
      pickerCoords?.lat != null && !Number.isNaN(Number(pickerCoords.lat))
        ? Number(pickerCoords.lat)
        : farms[0]?.latitude != null && !Number.isNaN(Number(farms[0].latitude))
          ? Number(farms[0].latitude)
          : defaultLat;
    const lng =
      pickerCoords?.lng != null && !Number.isNaN(Number(pickerCoords.lng))
        ? Number(pickerCoords.lng)
        : farms[0]?.longitude != null && !Number.isNaN(Number(farms[0].longitude))
          ? Number(farms[0].longitude)
          : defaultLng;

    if (!pickerMarkerRef.current) {
      const element = document.createElement("div");
      element.className = "cursor-grab active:cursor-grabbing select-none group";
      element.innerHTML = `
        <div class="relative flex flex-col items-center">
          <div class="absolute -bottom-1 w-4 h-1.5 bg-black/40 rounded-full blur-[1px]"></div>
          <div class="relative z-10 w-9 h-9 rounded-full bg-rose-600 border-2 border-white shadow-xl flex items-center justify-center text-white ring-4 ring-rose-500/30 transition-transform group-hover:scale-110">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
          </div>
          <div class="w-2.5 h-2.5 bg-rose-600 rotate-45 -mt-1.5 border-r border-b border-white shadow-xs"></div>
        </div>
      `;
      const marker = new maplibregl.Marker({ element, draggable: true, anchor: "bottom" })
        .setLngLat([lng, lat])
        .addTo(map);

      marker.on("dragstart", () => {
        isDraggingPickerMarkerRef.current = true;
      });
      marker.on("drag", () => {
        const position = marker.getLngLat();
        onLocationSelectRef.current?.(position.lat, position.lng);
      });
      marker.on("dragend", () => {
        const position = marker.getLngLat();
        onLocationSelectRef.current?.(position.lat, position.lng);
        setTimeout(() => {
          isDraggingPickerMarkerRef.current = false;
        }, 100);
      });
      pickerMarkerRef.current = marker;
    } else {
      pickerMarkerRef.current.setLngLat([lng, lat]);
    }
  }, [pickerMode, pickerCoords?.lat, pickerCoords?.lng, farms]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !pickerMode || isDraggingPickerMarkerRef.current) return;
    const target =
      pickerCoords && !Number.isNaN(Number(pickerCoords.lat)) && !Number.isNaN(Number(pickerCoords.lng))
        ? { lat: Number(pickerCoords.lat), lng: Number(pickerCoords.lng) }
        : null;
    const targetKey = target ? `${target.lat.toFixed(6)},${target.lng.toFixed(6)}` : null;
    if (!target || targetKey === lastAutoCenterRef.current) return;
    lastAutoCenterRef.current = targetKey;
    const currentZoom = map.getZoom();
    const targetZoom = currentZoom ? Math.max(currentZoom, 16) : 17;
    map.easeTo({ center: [target.lng, target.lat], zoom: targetZoom, duration: 300 });
  }, [pickerMode, pickerCoords?.lat, pickerCoords?.lng]);

  // Clear Search Pin
  const clearSearchPin = useCallback(() => {
    if (searchMarkerRef.current) {
      searchMarkerRef.current.remove();
      searchMarkerRef.current = null;
    }
    setActiveSearchPlace(null);
    updateStoredMapState({ activeSearchPlace: null });
  }, []);

  // Update Search Pin Marker on Map
  const updateSearchMarker = useCallback((map: maplibregl.Map, place: SearchResultItem) => {
    if (searchMarkerRef.current) {
      searchMarkerRef.current.remove();
      searchMarkerRef.current = null;
    }

    const element = document.createElement("div");
    element.className = "cursor-pointer select-none group";
    element.innerHTML = `
      <div class="relative flex flex-col items-center">
        <div class="absolute -top-2 w-10 h-10 rounded-full bg-rose-500/30 animate-ping pointer-events-none"></div>
        <div class="relative z-10 w-9 h-9 rounded-full bg-rose-600 border-2 border-white shadow-2xl flex items-center justify-center text-white ring-4 ring-rose-500/30 transition-transform group-hover:scale-110">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        </div>
        <div class="w-3 h-3 bg-rose-600 rotate-45 -mt-1.5 border-r border-b border-white shadow-md"></div>
      </div>
    `;

    const marker = new maplibregl.Marker({ element, anchor: "bottom" })
      .setLngLat([place.lng, place.lat])
      .addTo(map);

    element.addEventListener("click", () => {
      setActiveSearchPlace(place);
    });

    searchMarkerRef.current = marker;
  }, []);

  // Select Location from Search
  const handleSelectLocation = (place: SearchResultItem) => {
    setIsCenteredOnUser(false);
    setActiveSearchPlace(place);
    setSearchQuery("");
    setShowDropdown(false);
    setSearchResults([]);
    setSelectedIndex(-1);
    updateStoredMapState({ activeSearchPlace: place, selectedNodeId: null });

    if (mapInstanceRef.current) {
      updateSearchMarker(mapInstanceRef.current, place);
      mapInstanceRef.current.flyTo({
        center: [place.lng, place.lat],
        zoom: place.recommendedZoom || (place.isAdministrative ? 14 : 17),
        speed: 1.25,
        curve: 1.3,
        essential: true,
      });
    }

    if (pickerMode && onLocationSelect) {
      onLocationSelect(place.lat, place.lng);
    }
    onClearNodeSelectionRef.current?.();
  };

  // Select IoT Device / Node
  const handleSelectNode = (node: NodeDevice) => {
    setIsCenteredOnUser(false);
    clearSearchPin();
    if (!pickerMode) {
      updateStoredMapState({ selectedNodeId: node.id, activeSearchPlace: null });
    }
    const nLat = node.latitude || defaultLat;
    const nLng = node.longitude || defaultLng;

    if (mapInstanceRef.current) {
      mapInstanceRef.current.flyTo({ center: [nLng, nLat], zoom: 18, speed: 1.25, curve: 1.3, essential: true });
    }

    if (pickerMode && onLocationSelect && node.latitude && node.longitude) {
      onLocationSelect(node.latitude, node.longitude);
      pickerMarkerRef.current?.setLngLat([nLng, nLat]);
    }

    if (onSelectNode) onSelectNode(node);
    setSearchQuery("");
    setShowDropdown(false);
    setSearchResults([]);
    setSelectedIndex(-1);
  };

  const handleSelectFarm = (farm: FarmItem) => {
    setIsCenteredOnUser(false);
    clearSearchPin();
    const latitude = finiteCoordinate(farm.latitude, defaultLat);
    const longitude = finiteCoordinate(farm.longitude, defaultLng);
    mapInstanceRef.current?.flyTo({
      center: [longitude, latitude],
      zoom: 16,
      speed: 1.2,
      curve: 1.25,
      essential: true,
    });
    setSearchQuery("");
    setShowDropdown(false);
    setSearchResults([]);
    setSelectedIndex(-1);
  };

  // Copy GPS Coordinates
  const handleCopyCoords = (lat: number, lng: number) => {
    navigator.clipboard.writeText(`${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    setCopiedCoords(true);
    setTimeout(() => setCopiedCoords(false), 2000);
  };

  // Keyboard navigation
  const totalDropdownItems = localSearchResults.length + searchResults.length;

  const handleKeyDownInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown || totalDropdownItems === 0) {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSearchSubmit(e);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % totalDropdownItems);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev <= 0 ? totalDropdownItems - 1 : prev - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < totalDropdownItems) {
        if (selectedIndex < localSearchResults.length) {
          const result = localSearchResults[selectedIndex];
          if (result.kind === "farm") handleSelectFarm(result.farm);
          else handleSelectNode(result.node);
        } else {
          const placeIdx = selectedIndex - localSearchResults.length;
          handleSelectLocation(searchResults[placeIdx]);
        }
      } else {
        handleSearchSubmit(e);
      }
    } else if (e.key === "Escape") {
      setShowDropdown(false);
    }
  };

  // Submit Search
  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    if (localSearchResults.length > 0) {
      const result = localSearchResults[0];
      if (result.kind === "farm") handleSelectFarm(result.farm);
      else handleSelectNode(result.node);
      return;
    }

    if (searchResults.length > 0) {
      handleSelectLocation(searchResults[0]);
      return;
    }
  };

  // Render category icon for POIs
  const renderCategoryIcon = (category: PlaceCategory) => {
    switch (category) {
      case "hospital":
        return (
          <div className="w-6 h-6 rounded-lg bg-rose-100 dark:bg-rose-950/60 flex items-center justify-center shrink-0">
            <Building2 className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
          </div>
        );
      case "school":
        return (
          <div className="w-6 h-6 rounded-lg bg-indigo-100 dark:bg-indigo-950/60 flex items-center justify-center shrink-0">
            <GraduationCap className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
          </div>
        );
      case "shopping":
        return (
          <div className="w-6 h-6 rounded-lg bg-amber-100 dark:bg-amber-950/60 flex items-center justify-center shrink-0">
            <Store className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
          </div>
        );
      case "food":
        return (
          <div className="w-6 h-6 rounded-lg bg-orange-100 dark:bg-orange-950/60 flex items-center justify-center shrink-0">
            <Utensils className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />
          </div>
        );
      case "transit":
        return (
          <div className="w-6 h-6 rounded-lg bg-cyan-100 dark:bg-cyan-950/60 flex items-center justify-center shrink-0">
            <Train className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
          </div>
        );
      case "road":
        return (
          <div className="w-6 h-6 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center shrink-0">
            <Route className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
          </div>
        );
      case "coordinate":
        return (
          <div className="w-6 h-6 rounded-lg bg-violet-100 dark:bg-violet-950/60 flex items-center justify-center shrink-0">
            <Compass className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
          </div>
        );
      default:
        return (
          <div className="w-6 h-6 rounded-lg bg-blue-100 dark:bg-blue-950/60 flex items-center justify-center shrink-0">
            <MapPin className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          </div>
        );
    }
  };

  // Google Maps My Location GPS Button with 3 states:
  // 1. Uncentered -> Center map on user (North Up)
  // 2. Centered -> Compass Tracking Mode (Map rotates with user facing direction)
  // 3. In Compass Mode -> Reset to North Up (bearing: 0)
  const handleFlyToMyLocation = async () => {
    if (!navigator.geolocation) {
      showLocationNotice(t.farmMap.gpsUnsupported, 5000);
      return;
    }

    // If already centered and user taps again -> Toggle Compass Mode!
    if (isCenteredOnUser && !isCompassMode) {
      // iOS only permits the orientation request inside a direct tap. Do not ask
      // for it until the user explicitly turns on heading-follow mode.
      const compassAllowed = await requestCompassPermission();
      if (!compassAllowed) {
        showLocationNotice(t.farmMap.compassPermission, 5000);
        return;
      }
      setIsCompassMode(true);
      showLocationNotice(t.farmMap.followingHeading, 5000);
      if (mapInstanceRef.current) {
        mapInstanceRef.current.easeTo({
          bearing: userHeadingRef.current || 0,
          pitch: 35,
          duration: 400,
        });
      }
      return;
    }

    // If in Compass Mode and user taps again -> Reset to North up
    if (isCenteredOnUser && isCompassMode) {
      setIsCompassMode(false);
      showLocationNotice(t.farmMap.northReset, 4000);
      if (mapInstanceRef.current) {
        mapInstanceRef.current.easeTo({
          bearing: 0,
          pitch: 0,
          duration: 400,
        });
      }
      return;
    }

    setGpsLocating(true);
    setIsCenteredOnUser(true);
    setIsCompassMode(false);
    showLocationNotice(t.farmMap.findingLocation, 0);

    // If we already have the user position, fly there immediately
    if (userLocationRef.current && mapInstanceRef.current) {
      mapInstanceRef.current.flyTo({
        center: [userLocationRef.current.lng, userLocationRef.current.lat],
        zoom: 16.5,
        bearing: 0,
        pitch: 0,
        speed: 1.25,
        essential: true,
      });
    }

    try {
      const pos = await getCurrentPositionWithFallback({
        highAccuracyTimeout: 7000,
        lowAccuracyTimeout: 12000,
        maximumAge: 30000,
      });

      const { latitude, longitude, accuracy, heading } = pos;
      const locationData = { lat: latitude, lng: longitude, accuracy, heading };
      userLocationRef.current = locationData;
      setGpsLocating(false);
      setIsCenteredOnUser(true);
      showLocationNotice(
        pos.isFallbackLowAccuracy
          ? t.farmMap.locatedWifi
          : t.farmMap.locatedGps,
        5000
      );
      updateStoredMapState({ userLocation: locationData, hasInitialLocated: true });

      if (heading != null && !isNaN(heading) && heading >= 0) {
        applyNewHeading(heading);
      }

      if (mapInstanceRef.current) {
        updateUserLocationMarker(mapInstanceRef.current, locationData);
        mapInstanceRef.current.flyTo({
          center: [longitude, latitude],
          zoom: 16.5,
          bearing: 0,
          pitch: 0,
          speed: 1.25,
          essential: true,
        });
      }

      if (pickerMode && onLocationSelect) {
        onLocationSelect(latitude, longitude);
      }

      // Live real-time position tracking
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      watchIdRef.current = navigator.geolocation.watchPosition(
        (watchPos) => {
          const { latitude: wLat, longitude: wLng, accuracy: wAcc, heading: wHead } = watchPos.coords;
          const updatedLocation = { lat: wLat, lng: wLng, accuracy: wAcc, heading: wHead };
          userLocationRef.current = updatedLocation;

          if (wHead != null && !isNaN(wHead) && wHead >= 0) {
            applyNewHeading(wHead);
          }

          if (mapInstanceRef.current) {
            updateUserLocationMarker(mapInstanceRef.current, updatedLocation);
            if (isCompassModeRef.current) {
              mapInstanceRef.current.easeTo({
                center: [wLng, wLat],
                bearing: wHead != null && !isNaN(wHead) && wHead >= 0 ? wHead : userHeadingRef.current,
                duration: 300,
              });
            }
          }
        },
        (watchErr) => {
          console.warn("Lỗi cập nhật GPS thời gian thực:", watchErr);
        },
        { enableHighAccuracy: !pos.isFallbackLowAccuracy, maximumAge: 10000 }
      );
    } catch (err: any) {
      setGpsLocating(false);
      const friendlyMsg = err?.message || getFriendlyGpsErrorMessage(err || { code: 3 });
      if (userLocationRef.current) {
        setIsCenteredOnUser(true);
        showLocationNotice(t.farmMap.gpsInterrupted, 6000);
      } else {
        setIsCenteredOnUser(false);
        showLocationNotice(friendlyMsg, 8000);
      }
    }
  };

  // Reset Center
  const handleResetCenter = () => {
    setIsCenteredOnUser(false);
    setIsCompassMode(false);
    showLocationNotice(null);
    const fLat = farms[0]?.latitude || defaultLat;
    const fLng = farms[0]?.longitude || defaultLng;
    if (mapInstanceRef.current) {
      mapInstanceRef.current.flyTo({ center: [fLng, fLat], zoom: 17.5, speed: 1.2, essential: true });
    }
  };

  const handleZoomIn = () => {
    mapInstanceRef.current?.zoomIn();
  };

  const handleZoomOut = () => {
    mapInstanceRef.current?.zoomOut();
  };

  const handleToggleFullscreen = async () => {
    const shell = mapShellRef.current;
    if (!shell) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await shell.requestFullscreen();
      }
    } catch {
      showLocationNotice(t.farmMap.fullscreenUnsupported, 4000);
    }
  };

  useEffect(() => {
    const syncFullscreen = () => {
      const active = document.fullscreenElement === mapShellRef.current;
      setIsFullscreen(active);
      requestAnimationFrame(() => mapInstanceRef.current?.resize());
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  return (
    <div
      ref={mapShellRef}
      className="relative w-full h-full overflow-hidden select-none font-sans bg-[#111d28]"
      style={{ height, minHeight: pickerMode ? "170px" : "300px" }}
    >
      {/* WebGL map canvas */}
      <div
        ref={mapContainerRef}
        className="absolute inset-0 w-full h-full z-0 cursor-grab active:cursor-grabbing"
      />

      {/* Top-right is deliberately reserved for viewport-wide actions, matching
          the spatial separation used by familiar consumer map applications. */}
      <div className="absolute top-3.5 right-3.5 z-[990] hidden sm:flex">
        <button
          type="button"
          onClick={handleToggleFullscreen}
          aria-label={isFullscreen ? t.farmMap.exitFullscreen : t.farmMap.enterFullscreen}
          title={isFullscreen ? t.farmMap.exitFullscreen : t.farmMap.enterFullscreen}
          className="grid h-11 w-11 place-items-center rounded-xl border border-slate-200/90 bg-white/95 text-slate-700 shadow-[0_2px_7px_rgba(15,23,42,0.18)] backdrop-blur-md transition hover:bg-slate-50 active:scale-[0.96] dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-100 dark:hover:bg-slate-800"
        >
          {isFullscreen ? <Minimize2 className="h-[18px] w-[18px]" /> : <Maximize2 className="h-[18px] w-[18px]" />}
        </button>
      </div>

      {/* 1. TOP-LEFT: Google Maps Official Style Search Box & Connected Dropdown */}
      <div
        ref={searchBoxRef}
        className="absolute top-3.5 left-3.5 z-[1050] w-[392px] max-w-[calc(100vw-1.75rem)] font-sans"
      >
        <div
          className={`bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 shadow-[0_2px_4px_rgba(0,0,0,0.2),0_-1px_0px_rgba(0,0,0,0.02)] transition-all ${
            showDropdown && searchQuery.trim() ? "rounded-2xl shadow-xl" : "rounded-3xl"
          }`}
        >
          {/* Main Input Row (Height: 48px, pure Google Maps layout) */}
          <form onSubmit={handleSearchSubmit} className="relative flex items-center h-12 px-3 pl-4">
            <input
              type="text"
              placeholder={t.farmMap.searchPlaceholder}
              value={searchQuery}
              onFocus={() => {
                if (searchQuery.trim()) setShowDropdown(true);
                onClearNodeSelectionRef.current?.();
              }}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyDownInput}
              className="w-full bg-transparent text-[15px] font-normal text-slate-800 dark:text-white placeholder:text-slate-500 focus:outline-none"
            />

            {/* Spinner or Clear Button */}
            {searchingAddress && (
              <Loader2 className="w-4 h-4 text-emerald-500 animate-spin mr-1.5 shrink-0" />
            )}
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  setSearchResults([]);
                  setShowDropdown(false);
                  setSelectedIndex(-1);
                }}
                className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors mr-1 shrink-0"
                title={t.farmMap.clearSearch}
              >
                <X className="w-4 h-4" />
              </button>
            )}

            {/* Search Icon Button (Magnifying Glass) */}
            <button
              type="submit"
              className="p-2 text-slate-600 dark:text-slate-300 hover:text-[#1a73e8] rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
              title={t.farmMap.searchTooltip}
            >
              <Search className="w-5 h-5" />
            </button>

            {/* Vertical Hairline Divider */}
            <div className="w-[1px] h-6 bg-slate-200 dark:bg-slate-700 mx-1 shrink-0"></div>

            {/* Google Maps Directions Icon (Blue Diamond with Arrow) */}
            <button
              type="button"
              onClick={() => {
                if (activeSearchPlace) {
                  window.open(
                    `https://www.google.com/maps/dir/?api=1&destination=${activeSearchPlace.lat},${activeSearchPlace.lng}`,
                    "_blank"
                  );
                } else if (userLocationRef.current) {
                  window.open(
                    `https://www.google.com/maps/dir/?api=1&origin=${userLocationRef.current.lat},${userLocationRef.current.lng}`,
                    "_blank"
                  );
                } else {
                  window.open("https://www.google.com/maps/dir/?api=1", "_blank");
                }
              }}
              className="p-2 text-[#1a73e8] hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded-full transition-colors shrink-0"
              title={t.farmMap.directionsTooltip}
            >
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                <path d="M21.71 11.29l-9-9a1 1 0 0 0-1.42 0l-9 9a1 1 0 0 0 0 1.42l9 9a1 1 0 0 0 1.42 0l9-9a1 1 0 0 0 0-1.42zm-10.71 6.3l-6.59-6.59 6.59-6.59 6.59 6.59-6.59 6.59zm1-10.59v3h-3a1 1 0 0 0-1 1v4h2v-3h2v3l3.5-3.5-3.5-3.5z" />
              </svg>
            </button>
          </form>

          {/* Unified Dropdown List (Seamlessly connected under the input) */}
          {showDropdown && searchQuery.trim() && (
            <div className="border-t border-slate-100 dark:border-slate-800 max-h-80 overflow-y-auto py-1">
              {/* Local system results are ranked before remote places, with no per-keystroke request. */}
              {localSearchResults.length > 0 && (
                <div className="pb-1 border-b border-slate-100 dark:border-slate-800/60">
                  <div className="px-4 py-1.5 bg-slate-50 dark:bg-slate-800/60 text-[11px] font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Search className="w-3.5 h-3.5 text-emerald-500" />
                    {t.farmMap.systemResults.replace("{{count}}", String(localSearchResults.length))}
                  </div>
                  {localSearchResults.map((result, idx) => {
                    const isSelected = selectedIndex === idx;
                    const isFarm = result.kind === "farm";
                    const node = isFarm ? null : result.node;
                    const farm = isFarm ? result.farm : null;
                    const owners = farm ? (farm.owners || []).map((owner) => owner.name || owner.email).filter(Boolean).join(", ") : "";
                    return (
                      <div
                        key={isFarm ? `farm-${farm!.id}` : `node-${node!.id}`}
                        onClick={() => isFarm ? handleSelectFarm(farm!) : handleSelectNode(node!)}
                        className={`px-4 py-2.5 cursor-pointer flex items-center justify-between transition-colors ${
                          isSelected
                            ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200"
                            : "text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {isFarm ? (
                            <div className="w-7 h-7 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center shrink-0">
                              <Building2 className="w-4 h-4 text-emerald-700 dark:text-emerald-300" />
                            </div>
                          ) : (
                            <div className={`w-2.5 h-2.5 rounded-full ${node!.online ? "bg-emerald-500" : "bg-slate-400"}`} />
                          )}
                          <div>
                            <div className="font-medium text-sm text-slate-900 dark:text-white">{isFarm ? farm!.name : node!.name || node!.id}</div>
                            <div className="text-xs text-slate-400 truncate max-w-[245px]">
                              {isFarm
                                ? `${owners || t.farmMap.unassignedOwner} • ${t.farmMap.devicesCount.replace("{{count}}", String(farm!.nodes?.length || 0))}`
                                : `${node!.farm?.name || t.farmMap.unassignedFarm} • ${node!.zone?.name || t.farmMap.unassignedArea}`}
                            </div>
                          </div>
                        </div>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                          {isFarm ? t.farmMap.farmBadge : node!.type}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Places & Addresses Section (Google Maps Clean Style) */}
              {searchResults.length > 0 && (
                <div>
                  {searchResults.map((item, idx) => {
                    const globalIdx = localSearchResults.length + idx;
                    const isSelected = selectedIndex === globalIdx;

                    return (
                      <div
                        key={item.id}
                        onClick={() => handleSelectLocation(item)}
                        className={`px-4 py-3 cursor-pointer flex items-center gap-4 transition-colors ${
                          isSelected
                            ? "bg-[#f1f3f4] dark:bg-slate-800"
                            : "hover:bg-[#f1f3f4] dark:hover:bg-slate-800/70"
                        }`}
                      >
                        <MapPin className="w-5 h-5 text-slate-500 dark:text-slate-400 shrink-0" />
                        <div className="min-w-0 flex-1 flex items-baseline gap-2 truncate">
                          <span className="font-normal text-[15px] text-[#202124] dark:text-white shrink-0">
                            {item.title}
                          </span>
                          {item.subtitle && (
                            <span className="text-[13px] text-[#70757a] dark:text-slate-400 font-normal truncate">
                              {item.subtitle}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Empty state while typing */}
              {!searchingAddress && localSearchResults.length === 0 && searchResults.length === 0 && (
                <div className="px-4 py-4 text-center text-slate-500 text-xs">
                  {t.farmMap.noResults.replace("{{query}}", searchQuery)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Floating Selected Place Card (Google Maps Style) */}
      {activeSearchPlace && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000] w-[calc(100vw-2rem)] sm:w-[420px] max-w-lg bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-3.5 transition-all animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-start gap-2.5 min-w-0">
              {renderCategoryIcon(activeSearchPlace.category)}
              <div className="min-w-0">
                <h4 className="font-bold text-xs text-slate-900 dark:text-white truncate">
                  {activeSearchPlace.title}
                </h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 mt-0.5 leading-relaxed">
                  {activeSearchPlace.subtitle}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={clearSearchPin}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
              title={t.farmMap.closePin}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 font-mono text-[10px] text-slate-500 dark:text-slate-400">
              <span>📍 {activeSearchPlace.lat.toFixed(5)}, {activeSearchPlace.lng.toFixed(5)}</span>
              <button
                type="button"
                onClick={() => handleCopyCoords(activeSearchPlace.lat, activeSearchPlace.lng)}
                className="p-1 text-slate-400 hover:text-emerald-500 rounded transition-colors"
                title={t.farmMap.copyCoords}
              >
                {copiedCoords ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${activeSearchPlace.lat},${activeSearchPlace.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-semibold text-[10px] transition-colors"
              >
                <ExternalLink className="w-2.5 h-2.5" />
                {t.farmMap.directions}
              </a>

              {pickerMode && onLocationSelect && (
                <button
                  type="button"
                  onClick={() => {
                    onLocationSelect(activeSearchPlace.lat, activeSearchPlace.lng);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] shadow-sm transition-colors"
                >
                  <Check className="w-2.5 h-2.5" />
                  {t.farmMap.setCoords}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. BOTTOM-LEFT: familiar Google Maps-style layer picker */}
      <div className="absolute bottom-6 left-4 z-[990]">
        <div ref={layerMenuRef} className="relative">
          {(() => {
            const selectedLayer = MAP_LAYERS.find((l) => l.id === mapType) || MAP_LAYERS[0];
            return (
              <button
                type="button"
                onClick={() => setShowLayerMenu((prev) => !prev)}
                aria-label={t.farmMap.selectLayer}
                aria-expanded={showLayerMenu}
                className="group relative flex flex-col items-center justify-center w-16 h-16 rounded-2xl overflow-hidden border-2 border-white dark:border-slate-700 shadow-2xl transition-transform active:scale-95 bg-slate-800 focus:outline-none"
                title={t.farmMap.selectLayer}
              >
                <img
                  src={selectedLayer.thumbnail}
                  alt={getLayerName(selectedLayer.id)}
                  className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent flex items-end justify-center pb-1 pointer-events-none">
                  <span className="text-[10px] font-extrabold text-white tracking-tight flex items-center gap-0.5 drop-shadow">
                    <Layers className="w-3 h-3" />
                    {t.farmMap.layerButton}
                  </span>
                </div>
              </button>
            );
          })()}

          {/* Layer Selection Popover */}
          {showLayerMenu && (
            <div className="absolute bottom-20 left-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-3 flex flex-wrap gap-2.5 animate-in fade-in zoom-in duration-150 z-50 max-w-[340px]" role="menu" aria-label={t.farmMap.layerMenu}>
              {MAP_LAYERS.map((layer) => {
                const isSelected = mapType === layer.id;
                return (
                  <button
                    key={layer.id}
                    type="button"
                    onClick={() => {
                      setMapType(layer.id);
                      setShowLayerMenu(false);
                      showLocationNotice(t.farmMap.switchedLayerNotice.replace("{{name}}", getLayerName(layer.id)), 3000);
                    }}
                    role="menuitemradio"
                    aria-checked={isSelected}
                    className={`cursor-pointer flex flex-col items-center gap-1.5 p-1.5 rounded-xl transition-all ${
                      isSelected
                        ? "ring-2 ring-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/40"
                        : "hover:bg-slate-100 dark:hover:bg-slate-800"
                    }`}
                  >
                    <div
                      className="w-14 h-12 rounded-lg bg-cover bg-center border border-slate-200 dark:border-slate-700 shadow-xs"
                      style={{ backgroundImage: `url('${layer.thumbnail}')` }}
                    />
                    <span
                      className={`text-[10px] font-bold ${
                        isSelected
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-slate-800 dark:text-slate-200"
                      }`}
                    >
                      {getLayerName(layer.id)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 3. BOTTOM-RIGHT: Floating Controls */}
      <div className="absolute bottom-6 right-4 z-[990] flex flex-col items-center gap-2.5">
        {locationNotice && (
          <div
            role="status"
            className="group relative max-w-[240px] rounded-xl bg-slate-900/95 px-3 py-2 text-center text-[11px] font-medium leading-snug text-white shadow-xl backdrop-blur-md border border-slate-700/50 flex items-center justify-between gap-2 animate-in fade-in zoom-in-95 duration-150"
          >
            <span className="flex-1 text-left">{locationNotice}</span>
            <button
              type="button"
              onClick={() => showLocationNotice(null)}
              className="text-slate-400 hover:text-white p-0.5 rounded transition-colors shrink-0"
              aria-label={t.farmMap.closeNotice}
              title={t.farmMap.closeNotice}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {/* Google Maps Compass Needle Button (Active when map is rotated away from North) */}
        {Math.abs(mapBearing) > 0.5 && (
          <button
            type="button"
            onClick={() => {
              setIsCompassMode(false);
              showLocationNotice(t.farmMap.northReset, 4000);
              mapInstanceRef.current?.easeTo({ bearing: 0, pitch: 0, duration: 400 });
            }}
            aria-label={t.farmMap.resetNorth}
            className="w-10 h-10 rounded-xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200 dark:border-slate-700/80 shadow-xl flex items-center justify-center active:scale-95 transition-all animate-in fade-in zoom-in duration-150"
            title={t.farmMap.resetNorth}
          >
            <div
              className="w-5 h-5 relative flex items-center justify-center transition-transform duration-100"
              style={{ transform: `rotate(${-mapBearing}deg)` }}
            >
              {/* Red North Needle */}
              <div className="absolute top-0 w-0 h-0 border-l-[3.5px] border-l-transparent border-r-[3.5px] border-r-transparent border-b-[9px] border-b-rose-600" />
              {/* Slate South Needle */}
              <div className="absolute bottom-0 w-0 h-0 border-l-[3.5px] border-l-transparent border-r-[3.5px] border-r-transparent border-t-[9px] border-t-slate-400 dark:border-t-slate-300" />
              {/* Center Dot */}
              <div className="w-1.5 h-1.5 rounded-full bg-slate-700 dark:bg-white z-10 shadow-xs" />
            </div>
          </button>
        )}

        {/* Reset Center button */}
        <button
          type="button"
          onClick={handleResetCenter}
          aria-label={t.farmMap.resetFarmCenter}
          className="w-10 h-10 rounded-xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200 dark:border-slate-700/80 shadow-xl flex items-center justify-center text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 active:scale-95 transition-all"
          title={t.farmMap.resetFarmCenter}
        >
          <Compass className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        </button>

        {/* My Location GPS Button (Google Maps 3-Mode Compass & Heading Tracking) */}
        <button
          type="button"
          onClick={handleFlyToMyLocation}
          aria-label={
            isCompassMode
              ? t.farmMap.stopHeadingFollow
              : isCenteredOnUser
                ? t.farmMap.startHeadingFollow
                : t.farmMap.findMyLocation
          }
          className={`w-10 h-10 rounded-xl backdrop-blur-md border shadow-xl flex items-center justify-center active:scale-95 transition-all ${
            isCompassMode
              ? "bg-blue-600 border-blue-400 text-white shadow-blue-500/40 ring-2 ring-blue-400"
              : isCenteredOnUser
              ? "bg-blue-600 border-blue-500 text-white shadow-blue-500/30 ring-2 ring-blue-400/40"
              : "bg-white/95 dark:bg-slate-900/95 border-slate-200 dark:border-slate-700/80 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          }`}
          title={
            isCompassMode
              ? t.farmMap.compassModeActive
              : isCenteredOnUser
              ? t.farmMap.compassModeTurnOn
              : t.farmMap.myLocationGps
          }
        >
          {isCompassMode ? (
            <Compass className="w-5 h-5 text-white animate-spin [animation-duration:6s]" />
          ) : (
            <Navigation
              className={`w-4 h-4 transition-all ${
                isCenteredOnUser ? "text-white fill-white" : "text-blue-600"
              } ${gpsLocating ? "animate-spin text-blue-500" : ""}`}
            />
          )}
        </button>

        {/* Zoom In & Out */}
        <div className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md rounded-xl border border-slate-200 dark:border-slate-700/80 shadow-xl flex flex-col overflow-hidden">
          <button
            type="button"
            onClick={handleZoomIn}
            aria-label={t.farmMap.zoomIn}
            className="w-10 h-10 flex items-center justify-center text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border-b border-slate-200 dark:border-slate-800 active:scale-90 transition-all font-bold"
            title={t.farmMap.zoomIn}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleZoomOut}
            aria-label={t.farmMap.zoomOut}
            className="w-10 h-10 flex items-center justify-center text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-all font-bold"
            title={t.farmMap.zoomOut}
          >
            <Minus className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
