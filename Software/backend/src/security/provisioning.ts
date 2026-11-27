import { DeviceIdentityState } from "@prisma/client";
import { env } from "../config/env";

/**
 * Legacy v2 onboarding is a deliberate migration escape hatch. Do not infer
 * enablement from NODE_ENV or from the presence of old identity rows: an
 * operator must opt in explicitly.
 */
export function legacyProvisioningEnabled(): boolean {
  return env.ENABLE_LEGACY_PROVISIONING === true;
}

export function isLegacyIdentity(identity: { identity_version: number; state: DeviceIdentityState }): boolean {
  return identity.identity_version < 3 || identity.state === DeviceIdentityState.LEGACY;
}

export function isReleasedV3Identity(identity: { identity_version: number; state: DeviceIdentityState }): boolean {
  return identity.identity_version >= 3 && identity.state === DeviceIdentityState.READY_TO_SHIP;
}
