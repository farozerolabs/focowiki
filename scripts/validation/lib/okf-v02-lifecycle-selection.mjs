export function createOkfV02MutationScope(prefix) {
  if (typeof prefix !== "string") {
    throw new Error("The OKF 0.2 lifecycle mutation prefix is invalid.");
  }
  const normalized = prefix.trim().replaceAll("\\", "/");
  if (!normalized) return () => true;
  if (
    normalized.startsWith("/")
    || !normalized.endsWith("/")
    || normalized.split("/").some((segment, index, all) =>
      index < all.length - 1 && (!segment || segment === "." || segment === ".."))
  ) {
    throw new Error("The OKF 0.2 lifecycle mutation prefix is unsafe.");
  }
  return (resource) => typeof resource?.relativePath === "string"
    && resource.relativePath.startsWith(normalized);
}
