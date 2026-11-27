export type FactoryVersion = {
  id: string; version: string; deviceType: string; firmwareTarget?: string | null;
  flashStatus: string; factoryReady: boolean;
};
const active = (release: FactoryVersion) => release.flashStatus === "ACTIVE" && release.factoryReady;
export function selectedFactoryReleaseId(releases: FactoryVersion[], selectedId: string): string {
  const selected = releases.find((release) => release.id === selectedId);
  if (!selected || !active(selected) || selected.version.endsWith("-secure")) {
    throw new Error("Hãy chọn gói firmware USB thông thường đang hoạt động.");
  }
  return selected.id;
}
export function visibleFactoryVersions<T extends FactoryVersion>(releases: T[]): T[] {
  return releases.filter(active).filter((release) => !release.version.endsWith("-secure"));
}
