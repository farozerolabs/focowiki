export function buildDockerLiveFaultServiceStartArguments(service) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(service)) {
    throw new Error("Invalid Docker Compose service name.");
  }
  return ["up", "--no-deps", "-d", service];
}
