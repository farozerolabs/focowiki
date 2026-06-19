export const apiVersion = "v1";
export const fallbackProductVersion = "0.0.0-dev";

const safeReleaseVersionPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

export function readProductReleaseVersion(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.FOCOWIKI_RELEASE_VERSION?.trim();

  if (!value || !safeReleaseVersionPattern.test(value)) {
    return fallbackProductVersion;
  }

  return value;
}
