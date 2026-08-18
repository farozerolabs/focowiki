export const SUPPORTED_RUNTIME_ROLES = [
  "api",
  "worker",
  "migrate",
  "search-init"
] as const;

export type SupportedRuntimeRole = (typeof SUPPORTED_RUNTIME_ROLES)[number];

export class UnsupportedRuntimeRoleError extends Error {
  public constructor(public readonly role: string) {
    super(`Unsupported runtime role for this Focowiki release: ${role}`);
    this.name = "UnsupportedRuntimeRoleError";
  }
}

export function assertSupportedRuntimeRole(
  role: string
): asserts role is SupportedRuntimeRole {
  if (!SUPPORTED_RUNTIME_ROLES.includes(role as SupportedRuntimeRole)) {
    throw new UnsupportedRuntimeRoleError(role);
  }
}
