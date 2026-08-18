export function reconcileComprehensiveDockerRuntime(input) {
  const selectedProfile = requireString(input?.selectedProfile, "selected profile");
  if (!new Set(["meilisearch", "opensearch"]).has(selectedProfile)) {
    throw new Error("Comprehensive Docker selected profile is invalid");
  }
  const expectedActive = new Set(uniqueStrings(
    input?.expectedActiveServices,
    "active services"
  ));
  const oneShots = new Set(uniqueStrings(input?.oneShotServices ?? [], "one-shot services"));
  const appRuntime = new Set(uniqueStrings(
    input?.appRuntimeServices ?? [],
    "app runtime services"
  ));
  const resourceLimited = new Set(uniqueStrings(
    input?.resourceLimitedServices ?? [],
    "resource-limited services"
  ));
  const allowedInactive = new Set(uniqueStrings(
    input?.allowedInactiveServices ?? [],
    "inactive services"
  ));
  for (const service of [...oneShots, ...appRuntime, ...resourceLimited]) {
    if (!expectedActive.has(service)) {
      throw new Error("Comprehensive Docker service role is not active");
    }
  }
  if ([...allowedInactive].some((service) => expectedActive.has(service))) {
    throw new Error("Comprehensive Docker active and inactive services overlap");
  }

  const containers = requireArray(input?.containers, "containers")
    .map((value) => inspectContainer(value, {
      expectedActive,
      allowedInactive,
      oneShots,
      appRuntime,
      resourceLimited
    }));
  if (new Set(containers.map((item) => item.service)).size !== containers.length) {
    throw new Error("Comprehensive Docker service containers are duplicated");
  }
  const observedActive = new Set(containers
    .filter((item) => expectedActive.has(item.service))
    .map((item) => item.service));
  if (observedActive.size !== expectedActive.size
    || [...expectedActive].some((service) => !observedActive.has(service))) {
    throw new Error("Comprehensive Docker active service identities do not match");
  }
  const unexpected = containers.filter((item) =>
    !expectedActive.has(item.service) && !allowedInactive.has(item.service));
  if (unexpected.length > 0) {
    throw new Error("Comprehensive Docker unexpected service container remains");
  }
  const activeServices = containers.filter((item) => expectedActive.has(item.service));
  const inactiveServices = containers.filter((item) => allowedInactive.has(item.service));
  return {
    ok: true,
    selectedProfile,
    counts: {
      activeServices: activeServices.length,
      runningServices: activeServices.filter((item) => item.state === "running").length,
      completedOneShots: activeServices.filter((item) =>
        oneShots.has(item.service) && item.state === "exited" && item.exitCode === 0).length,
      inactiveServices: inactiveServices.length,
      restarts: containers.reduce((sum, item) => sum + item.restartCount, 0),
      unsafePorts: containers.reduce((sum, item) => sum + item.unsafePortCount, 0),
      privileged: containers.filter((item) => item.privileged).length
    },
    services: activeServices.sort(byService),
    inactiveServices: inactiveServices.sort(byService)
  };
}

function inspectContainer(value, sets) {
  const item = requireRecord(value, "container");
  const service = requireString(item.service, "container service");
  const active = sets.expectedActive.has(service);
  const inactive = sets.allowedInactive.has(service);
  if (!active && !inactive) {
    return baseContainer(item, service);
  }
  const inspected = baseContainer(item, service);
  if (inspected.privileged || inspected.capAdd.length > 0) {
    throw new Error("Comprehensive Docker container is privileged");
  }
  if (inspected.restartCount !== 0) {
    throw new Error("Comprehensive Docker container restart count is not zero");
  }
  if (inspected.unsafePortCount !== 0) {
    throw new Error("Comprehensive Docker published port is not loopback-only");
  }
  if (inactive) {
    if (inspected.state !== "exited" || !new Set([0, 143]).has(inspected.exitCode)) {
      throw new Error("Comprehensive Docker inactive provider did not stop safely");
    }
    return inspected;
  }
  if (sets.oneShots.has(service)) {
    if (inspected.state !== "exited" || inspected.exitCode !== 0) {
      throw new Error("Comprehensive Docker one-shot service did not complete");
    }
  } else if (inspected.state !== "running" || inspected.health !== "healthy") {
    throw new Error("Comprehensive Docker long-running service is not healthy");
  }
  if (sets.appRuntime.has(service)
    && (!Number.isSafeInteger(inspected.runtimeUid) || inspected.runtimeUid <= 0)) {
    throw new Error("Comprehensive Docker app process is not non-root");
  }
  if (sets.resourceLimited.has(service)
    && (inspected.nanoCpus <= 0 || inspected.memoryBytes <= 0
      || !Number.isSafeInteger(inspected.pidsLimit) || inspected.pidsLimit <= 0)) {
    throw new Error("Comprehensive Docker resource limits are incomplete");
  }
  return inspected;
}

function baseContainer(item, service) {
  const publishedPorts = requireArray(
    item.publishedPorts ?? [],
    "published ports"
  ).map((value) => {
    const port = requireRecord(value, "published port");
    return {
      hostIp: typeof port.hostIp === "string" ? port.hostIp : "",
      hostPort: String(port.hostPort ?? ""),
      containerPort: requireString(port.containerPort, "container port")
    };
  });
  const unsafePortCount = publishedPorts.filter((port) =>
    port.hostPort !== "" && port.hostPort !== "0"
    && !new Set(["127.0.0.1", "::1", "localhost"]).has(port.hostIp)).length;
  const capAdd = requireArray(item.capAdd ?? [], "added capabilities")
    .map((value) => requireString(value, "added capability"));
  return {
    service,
    state: requireString(item.state, "container state"),
    health: item.health === null ? null : requireString(item.health, "container health"),
    exitCode: integer(item.exitCode, "container exit code"),
    restartCount: nonnegativeInteger(item.restartCount, "container restart count"),
    privileged: item.privileged === true,
    readOnlyRootfs: item.readOnlyRootfs === true,
    capAdd,
    nanoCpus: nonnegativeInteger(item.nanoCpus ?? 0, "container CPU limit"),
    memoryBytes: nonnegativeInteger(item.memoryBytes ?? 0, "container memory limit"),
    pidsLimit: item.pidsLimit === null || item.pidsLimit === undefined
      ? null : nonnegativeInteger(item.pidsLimit, "container PID limit"),
    runtimeUid: item.runtimeUid === null || item.runtimeUid === undefined
      ? null : nonnegativeInteger(item.runtimeUid, "container runtime UID"),
    publishedPorts,
    unsafePortCount,
    mounts: requireArray(item.mounts ?? [], "container mounts"),
    environmentNames: uniqueStrings(
      item.environmentNames ?? [],
      "container environment names"
    ),
    pass: true
  };
}

function byService(left, right) {
  return left.service.localeCompare(right.service, "en");
}

function uniqueStrings(value, label) {
  const values = requireArray(value, label).map((item) => requireString(item, label));
  if (new Set(values).size !== values.length) {
    throw new Error(`Comprehensive Docker ${label} are duplicated`);
  }
  return values;
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Comprehensive Docker ${label} is invalid`);
  }
  return number;
}

function nonnegativeInteger(value, label) {
  const number = integer(value, label);
  if (number < 0) throw new Error(`Comprehensive Docker ${label} is invalid`);
  return number;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`Comprehensive Docker ${label} are invalid`);
  }
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Comprehensive Docker ${label} is invalid`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Comprehensive Docker ${label} is invalid`);
  }
  return value;
}
