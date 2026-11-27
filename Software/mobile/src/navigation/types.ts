import type { NavigatorScreenParams } from "@react-navigation/native";

export type MainTabParamList = {
  Overview: undefined;
  Farms: undefined;
  Map: undefined;
  Devices: undefined;
  Settings: undefined;
  Assistant: undefined;
};

export type RootStackParamList = {
  Auth: undefined;
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
  Onboarding: undefined;
  Admin: undefined;
  FarmOperations: { farmId: string };
  Alerts: undefined;
  Profile: undefined;
};
