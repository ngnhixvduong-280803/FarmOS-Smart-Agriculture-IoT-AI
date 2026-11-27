import React from "react";
import { Platform, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { SFSymbol } from "react-native-sfsymbols";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

export type IconName =
  | "home"
  | "cpu"
  | "bell"
  | "shield"
  | "user"
  | "mail"
  | "lock"
  | "eye"
  | "eyeOff"
  | "droplet"
  | "thermometer"
  | "wind"
  | "power"
  | "refresh"
  | "plus"
  | "qrCode"
  | "check"
  | "chevronRight"
  | "chevronLeft"
  | "chevronDown"
  | "cog"
  | "dotsHorizontal"
  | "translate"
  | "palette"
  | "helpCircle"
  | "sun"
  | "cloud"
  | "cloudRain"
  | "alertTriangle"
  | "logout"
  | "wifi"
  | "sprout"
  | "search"
  | "map"
  | "location"
  | "navigation"
  | "compass"
  | "layers"
  | "minus";

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle | TextStyle>;
}

// Use each platform's native symbol system—not image assets. iOS renders
// UIImage(systemName:) SF Symbols and Android renders Material Design icons.
const symbolNames: Record<IconName, { ios: string; android: string }> = {
  home: { ios: "house.fill", android: "home" },
  cpu: { ios: "cpu", android: "cpu-64-bit" },
  bell: { ios: "bell.fill", android: "bell" },
  shield: { ios: "shield.fill", android: "shield" },
  user: { ios: "person.fill", android: "account" },
  mail: { ios: "envelope.fill", android: "email" },
  lock: { ios: "lock.fill", android: "lock" },
  eye: { ios: "eye.fill", android: "eye" },
  eyeOff: { ios: "eye.slash.fill", android: "eye-off" },
  droplet: { ios: "drop.fill", android: "water" },
  thermometer: { ios: "thermometer.medium", android: "thermometer" },
  wind: { ios: "wind", android: "weather-windy" },
  power: { ios: "power", android: "power" },
  refresh: { ios: "arrow.clockwise", android: "refresh" },
  plus: { ios: "plus", android: "plus" },
  qrCode: { ios: "qrcode", android: "qrcode" },
  check: { ios: "checkmark", android: "check" },
  chevronRight: { ios: "chevron.right", android: "chevron-right" },
  chevronLeft: { ios: "chevron.left", android: "chevron-left" },
  chevronDown: { ios: "chevron.down", android: "chevron-down" },
  cog: { ios: "gearshape.fill", android: "cog" },
  dotsHorizontal: { ios: "ellipsis", android: "dots-horizontal" },
  translate: { ios: "character.bubble.fill", android: "translate" },
  palette: { ios: "paintpalette.fill", android: "palette" },
  helpCircle: { ios: "questionmark.circle.fill", android: "help-circle" },
  sun: { ios: "sun.max.fill", android: "weather-sunny" },
  cloud: { ios: "cloud.fill", android: "weather-cloudy" },
  cloudRain: { ios: "cloud.rain.fill", android: "weather-rainy" },
  alertTriangle: { ios: "exclamationmark.triangle.fill", android: "alert" },
  logout: { ios: "rectangle.portrait.and.arrow.right", android: "logout" },
  wifi: { ios: "wifi", android: "wifi" },
  sprout: { ios: "leaf.fill", android: "sprout" },
  search: { ios: "magnifyingglass", android: "magnify" },
  map: { ios: "map.fill", android: "map" },
  location: { ios: "location.fill", android: "crosshairs-gps" },
  navigation: { ios: "location.north.fill", android: "navigation" },
  compass: { ios: "safari.fill", android: "compass" },
  layers: { ios: "square.3.layers.3d.fill", android: "layers" },
  minus: { ios: "minus", android: "minus" },
};

export function Icon({ name, size = 20, color = "#1c2922", style }: IconProps) {
  const symbols = symbolNames[name];

  if (Platform.OS === "ios") {
    return (
      <SFSymbol
        name={symbols.ios}
        size={size}
        color={color}
        weight="semibold"
        style={[{ width: size, height: size }, style] as StyleProp<ViewStyle>}
      />
    );
  }

  return (
    <MaterialDesignIcons
      name={symbols.android as never}
      size={size}
      color={color}
      style={style as StyleProp<TextStyle>}
    />
  );
}
