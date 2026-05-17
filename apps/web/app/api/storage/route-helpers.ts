import type { GcsAuthMode, NotebookSource, StorageProvider } from "@waml/shared";

export type DiscoverySourceRouteInput = Pick<
  NotebookSource,
  "provider" | "awsProfile" | "gcpProject" | "authMode" | "serviceAccountKeyPath"
>;

export function parseDiscoverySourceFromSearchParams(searchParams: URLSearchParams) {
  const providerParam = searchParams.get("provider");
  const provider: StorageProvider = providerParam === "gcs" ? "gcs" : "s3";

  return {
    provider,
    awsProfile: searchParams.get("awsProfile")?.trim() ?? "",
    gcpProject: searchParams.get("gcpProject")?.trim() ?? "",
    authMode:
      (searchParams.get("authMode")?.trim() as GcsAuthMode | null) ===
      "service_account"
        ? "service_account"
        : "adc",
    serviceAccountKeyPath:
      searchParams.get("serviceAccountKeyPath")?.trim() ?? "",
  } satisfies DiscoverySourceRouteInput;
}
