import { MIMEType } from "node:util";

export function areContentTypesEquivalent(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  try {
    const leftType = new MIMEType(left);
    const rightType = new MIMEType(right);
    return leftType.essence === rightType.essence
      && serializeParameters(leftType) === serializeParameters(rightType);
  } catch {
    return false;
  }
}

function serializeParameters(type: MIMEType): string {
  return [...type.params.entries()]
    .map(([name, value]) => [
      name.toLowerCase(),
      name.toLowerCase() === "charset" ? value.toLowerCase() : value
    ] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join(";");
}
