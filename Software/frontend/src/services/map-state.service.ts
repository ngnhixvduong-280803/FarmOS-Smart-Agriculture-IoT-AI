import { MapLayerType } from "../components/FarmMap";
import { SearchResultItem } from "./location-search.service";

export interface StoredMapState {
  center: [number, number] | null; // [lng, lat]
  zoom: number | null;
  mapType: MapLayerType;
  selectedNodeId: string | null;
  activeSearchPlace: SearchResultItem | null;
  userLocation: { lat: number; lng: number; accuracy?: number; heading?: number | null } | null;
  hasInitialLocated: boolean;
}

const STORAGE_KEY = "farmos_map_view_state";

const defaultState: StoredMapState = {
  center: null,
  zoom: null,
  mapType: "google_hybrid",
  selectedNodeId: null,
  activeSearchPlace: null,
  userLocation: null,
  hasInitialLocated: false,
};

let memoryState: StoredMapState = { ...defaultState };

// Try loading from sessionStorage on module load
try {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    memoryState = { ...defaultState, ...parsed };
  }
} catch (e) {
  // ignore storage errors
}

export const getStoredMapState = (): StoredMapState => {
  return { ...memoryState };
};

export const updateStoredMapState = (partial: Partial<StoredMapState>) => {
  memoryState = { ...memoryState, ...partial };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memoryState));
  } catch (e) {
    // ignore storage errors
  }
};
