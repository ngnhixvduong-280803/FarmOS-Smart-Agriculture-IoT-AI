import { useEffect, useMemo, useState } from "react";
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

type UserAvatarProps = {
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  size: number;
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  borderWidth?: number;
  textSize?: number;
  style?: StyleProp<ViewStyle>;
  allowLocalUri?: boolean;
};

function initialsFor(name?: string | null, email?: string | null): string {
  const source = name?.trim() || email?.trim() || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
    : source.slice(0, 2).toUpperCase();
}

function usableRemoteUrl(value?: string | null, allowLocalUri = false): string | null {
  const url = value?.trim();
  return url && (/^https:\/\//i.test(url) || (allowLocalUri && /^file:\/\//i.test(url))) ? url : null;
}

/** Uses the Google profile photo received through Supabase, and falls back to initials. */
export function UserAvatar({ name, email, avatarUrl, size, backgroundColor, borderColor, textColor, borderWidth = 1, textSize = Math.round(size * 0.34), style, allowLocalUri = false }: UserAvatarProps) {
  const remoteUrl = useMemo(() => usableRemoteUrl(avatarUrl, allowLocalUri), [allowLocalUri, avatarUrl]);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [remoteUrl]);

  return <View style={[styles.container, { backgroundColor, borderColor, borderRadius: size / 2, borderWidth, height: size, width: size }, style]}>
    {remoteUrl && !imageFailed
      ? <Image accessibilityLabel="Ảnh đại diện" onError={() => setImageFailed(true)} source={{ uri: remoteUrl }} style={styles.image} />
      : <Text style={[styles.initials, { color: textColor, fontSize: textSize }]}>{initialsFor(name, email)}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  container: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  image: { height: "100%", width: "100%" },
  initials: { fontWeight: "700" },
});
