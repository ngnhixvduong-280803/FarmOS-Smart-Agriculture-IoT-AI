import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Keychain from "react-native-keychain";
import type { UserProfile } from "../types";

const SERVICE = "com.farmos.mobile.session";
const CACHED_USER_KEY = "farmos.cached_user";
const PENDING_PROFILE_SYNC_KEY = "farmos.pending_profile_sync";

export type PendingProfileSync = {
  id: string;
  name: string;
  avatar?: { uri: string; type?: string | null; fileName?: string | null };
};

type TokenListener = (token: string | null) => void;
const tokenListeners = new Set<TokenListener>();

export function onTokenChanged(listener: TokenListener): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

export function notifyTokenChanged(token: string | null): void {
  tokenListeners.forEach((listener) => {
    try {
      listener(token);
    } catch {
      // Non-critical listener error
    }
  });
}

export async function loadMobileToken(): Promise<string | null> {
  const credentials = await Keychain.getGenericPassword({ service: SERVICE });
  return credentials ? credentials.password : null;
}

export async function saveMobileToken(token: string): Promise<void> {
  await Keychain.setGenericPassword("farmos-mobile", token, {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  notifyTokenChanged(token);
}

export async function clearMobileToken(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
  await clearCachedUser();
  await clearPendingProfileSync();
  notifyTokenChanged(null);
}

export async function saveCachedUser(user: UserProfile): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
  } catch {
    // Non-critical cache error
  }
}

export async function loadCachedUser(): Promise<UserProfile | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHED_USER_KEY);
    return raw ? (JSON.parse(raw) as UserProfile) : null;
  } catch {
    return null;
  }
}

export async function clearCachedUser(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CACHED_USER_KEY);
  } catch {
    // Non-critical cache error
  }
}

export async function savePendingProfileSync(update: PendingProfileSync): Promise<void> {
  await AsyncStorage.setItem(PENDING_PROFILE_SYNC_KEY, JSON.stringify(update));
}

export async function loadPendingProfileSync(): Promise<PendingProfileSync | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_PROFILE_SYNC_KEY);
    return raw ? (JSON.parse(raw) as PendingProfileSync) : null;
  } catch {
    return null;
  }
}

export async function clearPendingProfileSync(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_PROFILE_SYNC_KEY);
  } catch {
    // Non-critical cache error
  }
}
