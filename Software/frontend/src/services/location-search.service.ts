export type PlaceCategory =
  | "coordinate"
  | "hospital"
  | "school"
  | "shopping"
  | "food"
  | "transit"
  | "road"
  | "place"
  | "general";

export interface SearchResultItem {
  id: string;
  title: string;
  subtitle: string;
  fullAddress: string;
  lat: number;
  lng: number;
  category: PlaceCategory;
  isAdministrative?: boolean;
  recommendedZoom?: number;
  distanceKm?: number;
  source: "gps" | "photon" | "nominatim" | "google";
}

/**
 * Remove Vietnamese accents / diacritics for clean, robust fuzzy matching
 * e.g. "Xã Thạnh Trị" -> "xa thanh tri"
 */
export function stripVietnameseDiacritics(str: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .trim();
}

/**
 * Haversine formula to compute distance between two coordinates in kilometers
 */
export function calculateDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

/**
 * Format distance string nicely (e.g. "850 m" or "4.2 km")
 */
export function formatDistance(km?: number): string | null {
  if (km == null || Number.isNaN(km)) return null;
  if (km < 1) {
    return `${Math.round(km * 1000)} m`;
  }
  return `${km.toFixed(1)} km`;
}

/**
 * Try parsing raw GPS coordinates from string input
 */
export function parseGpsCoordinates(query: string): { lat: number; lng: number } | null {
  const text = query.trim();
  if (!text) return null;

  // 1. Decimal format: lat, lng or lat lng
  const decimalRegex = /^([+-]?\d{1,2}(?:\.\d+)?)[,\s]+([+-]?\d{1,3}(?:\.\d+)?)$/;
  const matchDec = text.match(decimalRegex);
  if (matchDec) {
    const lat = parseFloat(matchDec[1]);
    const lng = parseFloat(matchDec[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
  }

  // 2. DMS format (e.g. 10°51'17.6"N 106°47'11.5"E)
  const dmsRegex =
    /(\d{1,2})[°\s]+(\d{1,2})['\s]+([0-9.]+)?["\s]*([NSns])[,\s]+(\d{1,3})[°\s]+(\d{1,2})['\s]+([0-9.]+)?["\s]*([EWew])/;
  const matchDms = text.match(dmsRegex);
  if (matchDms) {
    let lat = parseInt(matchDms[1], 10) + parseInt(matchDms[2], 10) / 60 + (parseFloat(matchDms[3]) || 0) / 3600;
    if (matchDms[4].toUpperCase() === "S") lat = -lat;

    let lng = parseInt(matchDms[5], 10) + parseInt(matchDms[6], 10) / 60 + (parseFloat(matchDms[7]) || 0) / 3600;
    if (matchDms[8].toUpperCase() === "W") lng = -lng;

    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
  }

  return null;
}

/**
 * Determine category of location for UI icons
 */
function determineCategory(osmKey?: string, osmVal?: string, name?: string): PlaceCategory {
  const n = (name || "").toLowerCase();
  const k = (osmKey || "").toLowerCase();
  const v = (osmVal || "").toLowerCase();

  if (
    k === "boundary" ||
    v === "administrative" ||
    k === "place" ||
    v === "village" ||
    v === "town" ||
    v === "city" ||
    n.startsWith("xã ") ||
    n.startsWith("phường ") ||
    n.startsWith("quận ") ||
    n.startsWith("huyện ") ||
    n.startsWith("thị trấn ") ||
    n.startsWith("thị xã ") ||
    n.startsWith("tỉnh ") ||
    n.startsWith("thành phố ")
  ) {
    return "place";
  }

  if (
    (k === "amenity" && (v === "hospital" || v === "clinic" || v === "pharmacy" || v === "doctors")) ||
    n.includes("bệnh viện") ||
    n.includes("phòng khám") ||
    n.includes("trung tâm y tế")
  ) {
    return "hospital";
  }

  if (
    (k === "amenity" && (v === "school" || v === "university" || v === "college" || v === "kindergarten")) ||
    n.includes("trường") ||
    n.includes("đại học") ||
    n.includes("học viện") ||
    n.includes("cao đẳng") ||
    n.includes("tiểu học") ||
    n.includes("thcs") ||
    n.includes("thpt")
  ) {
    return "school";
  }

  if (
    k === "shop" ||
    v === "supermarket" ||
    v === "mall" ||
    v === "department_store" ||
    n.includes("vincom") ||
    n.includes("chợ") ||
    n.includes("siêu thị") ||
    n.includes("plaza") ||
    n.includes("co.op") ||
    n.includes("aeon")
  ) {
    return "shopping";
  }

  if (
    v === "restaurant" ||
    v === "cafe" ||
    v === "fast_food" ||
    v === "bar" ||
    n.includes("cà phê") ||
    n.includes("coffee") ||
    n.includes("quán ăn") ||
    n.includes("nhà hàng")
  ) {
    return "food";
  }

  if (
    k === "railway" ||
    v === "bus_station" ||
    v === "station" ||
    v === "subway" ||
    v === "aeroway" ||
    n.includes("bến xe") ||
    n.includes("ga ") ||
    n.includes("trạm xe") ||
    n.includes("sân bay")
  ) {
    return "transit";
  }

  if (k === "highway" || n.startsWith("đường ") || n.startsWith("phố ") || n.includes("ngã tư") || n.includes("cầu ")) {
    return "road";
  }

  return "general";
}

const ADMIN_KEYWORDS = new Set([
  "xa", "phuong", "quan", "huyen", "tinh", "tp", "thanh", "pho", "thi", "tran", "tx"
]);

const GENERIC_PREFIXES = new Set([
  ...ADMIN_KEYWORDS,
  "duong", "pho", "ngo", "hem", "cau", "khu", "ap", "thon", "ban"
]);

interface CandidateItem {
  title: string;
  subtitle: string;
  fullAddress: string;
  lat: number;
  lng: number;
  category: PlaceCategory;
  isAdministrative: boolean;
  distanceKm: number;
  osmKey?: string;
  osmVal?: string;
  source: "photon" | "nominatim" | "google";
}

/**
 * Fetch Photon API
 */
async function fetchPhoton(
  query: string,
  centerLat?: number,
  centerLng?: number,
  limit = 12,
  signal?: AbortSignal
): Promise<CandidateItem[]> {
  try {
    let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=${limit}`;
    if (centerLat != null && centerLng != null) {
      url += `&lat=${centerLat}&lon=${centerLng}`;
    }

    const resp = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!resp.ok) return [];

    const data = await resp.json();
    const features = data.features || [];

    return features.map((f: any) => {
      const p = f.properties || {};
      const [lon, lat] = f.geometry?.coordinates || [0, 0];
      const name = p.name || p.street || query;

      const subParts: string[] = [];
      if (p.street && p.street !== name) subParts.push(p.street);
      if (p.district && p.district !== name && !subParts.includes(p.district)) subParts.push(p.district);
      if (p.city && p.city !== name && !subParts.includes(p.city)) subParts.push(p.city);
      if (p.state && p.state !== name && !subParts.includes(p.state)) subParts.push(p.state);

      const subtitle = subParts.join(", ") || (p.country || "Việt Nam");
      const fullAddress = `${name}, ${subtitle}`;
      const category = determineCategory(p.osm_key, p.osm_value, name);

      const isAdmin =
        category === "place" ||
        p.osm_key === "boundary" ||
        p.osm_value === "administrative" ||
        p.osm_value === "village" ||
        p.osm_value === "town";

      return {
        title: name,
        subtitle,
        fullAddress,
        lat,
        lng: lon,
        category,
        isAdministrative: isAdmin,
        distanceKm: centerLat != null && centerLng != null ? calculateDistanceKm(centerLat, centerLng, lat, lon) : 0,
        osmKey: p.osm_key,
        osmVal: p.osm_value,
        source: "photon" as const,
      };
    });
  } catch (e) {
    return [];
  }
}

/**
 * Fetch Nominatim API (OpenStreetMap Vietnam)
 */
async function fetchNominatim(
  query: string,
  centerLat: number,
  centerLng: number,
  limit = 8,
  signal?: AbortSignal
): Promise<CandidateItem[]> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
      query
    )}&countrycodes=vn&addressdetails=1&limit=${limit}`;

    const resp = await fetch(url, {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "FarmOS-Web/1.0",
      },
    });
    if (!resp.ok) return [];

    const list = await resp.json();
    if (!Array.isArray(list)) return [];

    return list.map((item: any) => {
      const lat = parseFloat(item.lat);
      const lng = parseFloat(item.lon);
      const addr = item.address || {};

      const name =
        item.name ||
        addr.village ||
        addr.quarter ||
        addr.suburb ||
        addr.town ||
        (item.display_name || "").split(",")[0].trim();

      const subParts: string[] = [];
      const keys = ["quarter", "suburb", "city_district", "district", "city", "state"];
      for (const k of keys) {
        if (addr[k] && addr[k] !== name && !subParts.includes(addr[k])) {
          subParts.push(addr[k]);
        }
      }

      const subtitle = subParts.join(", ") || "Việt Nam";
      const fullAddress = item.display_name || `${name}, ${subtitle}`;
      const category = determineCategory(item.class, item.type, name);

      const isAdmin =
        category === "place" ||
        item.class === "boundary" ||
        item.type === "administrative" ||
        item.type === "village";

      return {
        title: name,
        subtitle,
        fullAddress,
        lat,
        lng,
        category,
        isAdministrative: isAdmin,
        distanceKm: calculateDistanceKm(centerLat, centerLng, lat, lng),
        osmKey: item.class,
        osmVal: item.type,
        source: "nominatim" as const,
      };
    });
  } catch (e) {
    return [];
  }
}

/**
 * Google Places API fallback (if VITE_GOOGLE_MAPS_API_KEY is configured)
 */
async function fetchGooglePlaces(
  query: string,
  centerLat: number,
  centerLng: number,
  apiKey: string,
  signal?: AbortSignal
): Promise<CandidateItem[]> {
  try {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(
      query
    )}&location=${centerLat},${centerLng}&radius=40000&language=vi&key=${apiKey}`;

    const resp = await fetch(url, { signal });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.results || !Array.isArray(data.results)) return [];

    return data.results.slice(0, 8).map((item: any) => {
      const lat = item.geometry?.location?.lat || 0;
      const lng = item.geometry?.location?.lng || 0;
      const title = item.name || query;
      const subtitle = item.formatted_address || "";

      return {
        title,
        subtitle,
        fullAddress: `${title}, ${subtitle}`,
        lat,
        lng,
        category: "general" as PlaceCategory,
        isAdministrative: false,
        distanceKm: calculateDistanceKm(centerLat, centerLng, lat, lng),
        source: "google" as const,
      };
    });
  } catch (e) {
    return [];
  }
}

/**
 * Smart Google Maps-grade Scoring & Ranking Engine
 * - Strict core keyword filtering (eliminates irrelevant words matching stop-words)
 * - Administrative boundary priority when user searches for communes/districts/provinces
 * - Subtle proximity tie-breaker without overriding textual relevance
 */
function scoreAndRankCandidates(
  candidates: CandidateItem[],
  query: string,
  centerLat: number,
  centerLng: number
): SearchResultItem[] {
  const queryNorm = stripVietnameseDiacritics(query);
  const words = queryNorm.split(/\s+/).filter(Boolean);

  const isAdministrativeQuery = words.some((w) => ADMIN_KEYWORDS.has(w));
  const coreTokens = words.filter((w) => !GENERIC_PREFIXES.has(w));

  const scoredList: { score: number; item: SearchResultItem }[] = [];

  for (const c of candidates) {
    const titleNorm = stripVietnameseDiacritics(c.title);
    const subNorm = stripVietnameseDiacritics(c.subtitle);
    const fullNorm = `${titleNorm} ${subNorm}`;

    // 1. STRICT CORE KEYWORD FILTER:
    // If the query has core words (e.g. "thạnh", "trị"), ALL of them MUST be present in either title or subtitle!
    // This immediately eliminates "Trạm Xe Bus Bình Long - Ngã 4 Bốn Xã", "Ký túc xá...", "Chợ Ngã tư Bốn Xã"!
    if (coreTokens.length > 0) {
      const hasAllCore = coreTokens.every((t) => fullNorm.includes(t));
      if (!hasAllCore) continue;
    }

    let score = 0;

    // 2. Exact or Prefix Title Matching
    if (titleNorm === queryNorm) {
      score += 2600;
    } else if (titleNorm.startsWith(queryNorm)) {
      score += 1900;
    } else if (titleNorm.includes(queryNorm)) {
      score += 1500;
    }

    // 3. Core token containment in Title
    if (coreTokens.length > 0) {
      if (coreTokens.every((t) => titleNorm.includes(t))) {
        score += 800;
      }
    }

    // 4. Administrative Query Boost
    if (isAdministrativeQuery) {
      if (c.isAdministrative) {
        score += 1000;
      } else if (titleNorm.includes("ubnd")) {
        score += 650;
      }
    }

    // 5. Proximity Bonus (Gentle tie-breaker)
    // Distance does NOT override a bad text match!
    const dist = c.distanceKm;
    if (isAdministrativeQuery) {
      // In administrative mode, national accuracy matters most
      score += Math.max(0, 80 - dist * 0.08);
    } else {
      // In POI / local mode, closer places get a reasonable boost
      score += Math.max(0, 300 - dist * 12);
    }

    const recommendedZoom = c.isAdministrative ? 14 : 17.5;

    scoredList.push({
      score,
      item: {
        id: `${c.source}-${c.lat.toFixed(5)}-${c.lng.toFixed(5)}-${stripVietnameseDiacritics(c.title)}`,
        title: c.title,
        subtitle: c.subtitle,
        fullAddress: c.fullAddress,
        lat: c.lat,
        lng: c.lng,
        category: c.category,
        isAdministrative: c.isAdministrative,
        recommendedZoom,
        distanceKm: dist,
        source: c.source,
      },
    });
  }

  // Sort by score descending
  scoredList.sort((a, b) => b.score - a.score);

  // Deduplicate by normalized title + state/province or proximity (< 150m)
  const seenKeys = new Set<string>();
  const finalResults: SearchResultItem[] = [];

  for (const entry of scoredList) {
    const it = entry.item;
    const titleKey = stripVietnameseDiacritics(it.title);
    const subKey = stripVietnameseDiacritics(it.subtitle).slice(0, 18);
    const uniqueKey = `${titleKey}__${subKey}`;

    const isDuplicate =
      seenKeys.has(uniqueKey) ||
      finalResults.some(
        (existing) =>
          calculateDistanceKm(existing.lat, existing.lng, it.lat, it.lng) < 0.15 &&
          stripVietnameseDiacritics(existing.title) === titleKey
      );

    if (!isDuplicate) {
      seenKeys.add(uniqueKey);
      finalResults.push(it);
      if (finalResults.length >= 7) break;
    }
  }

  return finalResults;
}

/**
 * Main Location Search function:
 * Produces Google Maps-grade search results with multi-engine fallback and smart relevance ranking.
 */
export async function searchLocations(
  query: string,
  centerLat: number = 10.854886,
  centerLng: number = 106.786523,
  signal?: AbortSignal
): Promise<SearchResultItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // 1. Direct GPS coordinates check
  const parsedCoords = parseGpsCoordinates(trimmed);
  if (parsedCoords) {
    const dist = calculateDistanceKm(centerLat, centerLng, parsedCoords.lat, parsedCoords.lng);
    return [
      {
        id: `coord-${parsedCoords.lat}-${parsedCoords.lng}`,
        title: `Tọa độ GPS: ${parsedCoords.lat.toFixed(6)}, ${parsedCoords.lng.toFixed(6)}`,
        subtitle: "Bấm để bay tới vị trí tọa độ chính xác trên bản đồ",
        fullAddress: `${parsedCoords.lat}, ${parsedCoords.lng}`,
        lat: parsedCoords.lat,
        lng: parsedCoords.lng,
        category: "coordinate",
        recommendedZoom: 18,
        distanceKm: dist,
        source: "gps",
      },
    ];
  }

  try {
    // 2. Optional Google Places API if key exists
    const googleApiKey = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY;
    if (googleApiKey) {
      const gCandidates = await fetchGooglePlaces(trimmed, centerLat, centerLng, googleApiKey, signal);
      if (gCandidates.length > 0) {
        return scoreAndRankCandidates(gCandidates, trimmed, centerLat, centerLng);
      }
    }

    const norm = stripVietnameseDiacritics(trimmed);
    const words = norm.split(/\s+/).filter(Boolean);
    const isAdministrative = words.some((w) => ADMIN_KEYWORDS.has(w));

    // 3. Parallel multi-engine fetching
    // For administrative searches (e.g. "xã thạnh trị", "huyện cần giờ"), countrywide search is prioritized!
    const fetchPromises: Promise<CandidateItem[]>[] = [];

    if (isAdministrative) {
      fetchPromises.push(fetchPhoton(trimmed, undefined, undefined, 15, signal));
      fetchPromises.push(fetchNominatim(trimmed, centerLat, centerLng, 8, signal));
      fetchPromises.push(fetchPhoton(trimmed, centerLat, centerLng, 10, signal));
    } else {
      fetchPromises.push(fetchPhoton(trimmed, centerLat, centerLng, 12, signal));
      fetchPromises.push(fetchNominatim(trimmed, centerLat, centerLng, 6, signal));
      fetchPromises.push(fetchPhoton(trimmed, undefined, undefined, 8, signal));
    }

    const settled = await Promise.allSettled(fetchPromises);
    const allCandidates: CandidateItem[] = [];

    for (const res of settled) {
      if (res.status === "fulfilled" && Array.isArray(res.value)) {
        allCandidates.push(...res.value);
      }
    }

    // 4. Score and Rank with Google Maps-grade algorithm
    return scoreAndRankCandidates(allCandidates, trimmed, centerLat, centerLng);
  } catch (err: any) {
    if (err.name === "AbortError") return [];
    console.error("Lỗi tìm kiếm địa điểm:", err);
    return [];
  }
}
