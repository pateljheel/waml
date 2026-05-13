"use client";

import { useEffect, useRef, useState } from "react";

type Notebook = {
  id: string;
  title: string;
  status: "running" | "idle";
  awsProfile: string;
  bucket: string;
  rootPrefix: string;
  customPathPattern: string;
  partitionOverrides: Record<
    string,
    {
      label: string;
      kind: "category" | "range";
      hidden: boolean;
    }
  >;
  partitionFilters: Record<string, string>;
  query: string;
  range: string;
  updatedAt: string;
};

type PartitionDefinition = {
  key: string;
  values: string[];
  kind: "category" | "range";
  source: "hive" | "custom";
  level: number;
  order: number;
};

const initialNotebooks: Notebook[] = [
  {
    id: "checkout-errors",
    title: "Checkout errors",
    status: "running",
    awsProfile: "prod-observability",
    bucket: "company-prod-logs",
    rootPrefix: "apps/checkout/prod/",
    customPathPattern: "",
    partitionOverrides: {},
    partitionFilters: {},
    query: 'timeout while awaiting headers service="checkout-api"',
    range: "Last 90 min",
    updatedAt: "2 min ago",
  },
  {
    id: "auth-refresh",
    title: "Auth refresh",
    status: "idle",
    awsProfile: "prod-observability",
    bucket: "company-prod-logs",
    rootPrefix: "apps/auth/prod/",
    customPathPattern: "",
    partitionOverrides: {},
    partitionFilters: {},
    query: 'token refresh failed service="auth-service"',
    range: "Today",
    updatedAt: "14 min ago",
  },
  {
    id: "queue-latency",
    title: "Queue latency",
    status: "idle",
    awsProfile: "stage-observability",
    bucket: "company-stage-logs",
    rootPrefix: "workers/ingest/staging/",
    customPathPattern: "",
    partitionOverrides: {},
    partitionFilters: {},
    query: 'consumer lag service="worker-ingest"',
    range: "May 2026",
    updatedAt: "Yesterday",
  },
];

const profileOptions = [
  "prod-observability",
  "stage-observability",
  "dev-observability",
];

const storageKey = "waml.notebooks";

function statusLabel(status: Notebook["status"]) {
  return status === "running" ? "Running" : "Idle";
}

function getPrefixLabel(currentPrefix: string, candidatePrefix: string) {
  const current = currentPrefix.trim();

  if (!current) {
    return candidatePrefix.replace(/\/+$/, "");
  }

  const suffix = candidatePrefix.startsWith(current)
    ? candidatePrefix.slice(current.length)
    : candidatePrefix;

  return suffix.replace(/\/+$/, "");
}

function normalizeNotebook(notebook: Partial<Notebook> & Pick<Notebook, "id" | "title">) {
  return {
    status: "idle" as Notebook["status"],
    awsProfile: "",
    bucket: "",
    rootPrefix: "",
    customPathPattern: "",
    partitionOverrides: {},
    partitionFilters: {},
    query: "",
    range: "",
    updatedAt: "Just now",
    ...notebook,
    customPathPattern: notebook.customPathPattern ?? "",
    partitionOverrides: notebook.partitionOverrides ?? {},
    partitionFilters: notebook.partitionFilters ?? {},
  } satisfies Notebook;
}

export default function HomePage() {
  const bucketPickerRef = useRef<HTMLDivElement | null>(null);
  const prefixPickerRef = useRef<HTMLDivElement | null>(null);
  const [notebooks, setNotebooks] = useState(initialNotebooks);
  const [activeNotebookId, setActiveNotebookId] = useState(initialNotebooks[0].id);
  const [draftTitle, setDraftTitle] = useState(initialNotebooks[0].title);
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [availableBuckets, setAvailableBuckets] = useState<string[]>([]);
  const [availablePrefixes, setAvailablePrefixes] = useState<string[]>([]);
  const [partitionDefinitions, setPartitionDefinitions] = useState<
    PartitionDefinition[]
  >([]);
  const [bucketSearch, setBucketSearch] = useState("");
  const [bucketPage, setBucketPage] = useState(1);
  const [bucketTotalPages, setBucketTotalPages] = useState(1);
  const [bucketTotalItems, setBucketTotalItems] = useState(0);
  const [prefixCursor, setPrefixCursor] = useState<string | null>(null);
  const [prefixCursorStack, setPrefixCursorStack] = useState<string[]>([]);
  const [nextPrefixCursor, setNextPrefixCursor] = useState<string | null>(null);
  const [bucketPickerOpen, setBucketPickerOpen] = useState(false);
  const [prefixPickerOpen, setPrefixPickerOpen] = useState(false);
  const [awsError, setAwsError] = useState<string | null>(null);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingBuckets, setLoadingBuckets] = useState(false);
  const [loadingPrefixes, setLoadingPrefixes] = useState(false);
  const [loadingPartitions, setLoadingPartitions] = useState(false);
  const [bucketReloadToken, setBucketReloadToken] = useState(0);

  const activeNotebook =
    notebooks.find((notebook) => notebook.id === activeNotebookId) ?? notebooks[0];

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (!saved) {
        return;
      }

      const parsed = JSON.parse(saved) as Notebook[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const normalized = parsed.map((notebook) =>
          normalizeNotebook(notebook),
        );
        setNotebooks(normalized);
        setActiveNotebookId(normalized[0].id);
        setDraftTitle(normalized[0].title);
      }
    } catch {
      // Ignore malformed local state and keep defaults.
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(notebooks));
  }, [notebooks]);

  useEffect(() => {
    setDraftTitle(activeNotebook.title);
  }, [activeNotebook.id, activeNotebook.title]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      if (
        bucketPickerRef.current &&
        !bucketPickerRef.current.contains(target)
      ) {
        setBucketPickerOpen(false);
      }

      if (
        prefixPickerRef.current &&
        !prefixPickerRef.current.contains(target)
      ) {
        setPrefixPickerOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  function updateActiveNotebook<K extends keyof Notebook>(
    field: K,
    value: Notebook[K],
  ) {
    setNotebooks((currentNotebooks) =>
      currentNotebooks.map((notebook) =>
        notebook.id === activeNotebookId
          ? { ...notebook, [field]: value, updatedAt: "Just now" }
          : notebook,
      ),
    );
  }

  function createNotebook() {
    const newNotebook: Notebook = {
      id: crypto.randomUUID(),
      title: `Notebook ${notebooks.length + 1}`,
      status: "idle",
      awsProfile: activeNotebook.awsProfile,
      bucket: activeNotebook.bucket,
      rootPrefix: activeNotebook.rootPrefix,
      customPathPattern: activeNotebook.customPathPattern,
      partitionOverrides: activeNotebook.partitionOverrides ?? {},
      partitionFilters: activeNotebook.partitionFilters ?? {},
      query: "",
      range: "Last 60 min",
      updatedAt: "Just now",
    };

    setNotebooks((current) => [newNotebook, ...current]);
    setActiveNotebookId(newNotebook.id);
  }

  function renameNotebook() {
    const nextTitle = draftTitle.trim();

    if (!nextTitle) {
      setDraftTitle(activeNotebook.title);
      return;
    }

    updateActiveNotebook("title", nextTitle);
  }

  function duplicateNotebook() {
    const duplicate: Notebook = {
      ...activeNotebook,
      id: crypto.randomUUID(),
      title: `${activeNotebook.title} copy`,
      updatedAt: "Just now",
    };

    setNotebooks((current) => [duplicate, ...current]);
    setActiveNotebookId(duplicate.id);
  }

  function deleteNotebook() {
    if (notebooks.length <= 1) {
      return;
    }

    const remaining = notebooks.filter((notebook) => notebook.id !== activeNotebookId);
    setNotebooks(remaining);
    setActiveNotebookId(remaining[0].id);
  }

  function selectPrefixPage(nextCursor: string | null) {
    if (nextCursor === null) {
      setPrefixCursorStack([]);
      setPrefixCursor(null);
      return;
    }

    setPrefixCursorStack((current) =>
      prefixCursor ? [...current, prefixCursor] : current,
    );
    setPrefixCursor(nextCursor);
  }

  function goToPreviousPrefixPage() {
    setPrefixCursorStack((current) => {
      const previousCursor = current.at(-1) ?? null;
      setPrefixCursor(previousCursor);
      return current.slice(0, -1);
    });
  }

  useEffect(() => {
    let cancelled = false;

    async function loadProfiles() {
      setLoadingProfiles(true);
      setAwsError(null);

      try {
        const response = await fetch("/api/aws/profiles");
        const payload = (await response.json()) as {
          profiles?: string[];
          error?: string;
        };

        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to load AWS profiles");
        }

        if (cancelled) {
          return;
        }

        const profiles = payload.profiles ?? [];
        setAvailableProfiles(profiles);

        if (
          profiles.length > 0 &&
          !profiles.includes(activeNotebook.awsProfile)
        ) {
          setNotebooks((currentNotebooks) =>
            currentNotebooks.map((notebook) =>
              notebook.id === activeNotebookId
                ? {
                    ...notebook,
                    awsProfile: profiles[0],
                    updatedAt: notebook.updatedAt,
                  }
                : notebook,
            ),
          );
        }
      } catch (error) {
        if (!cancelled) {
          setAwsError(
            error instanceof Error ? error.message : "Failed to load AWS profiles",
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingProfiles(false);
        }
      }
    }

    void loadProfiles();

    return () => {
      cancelled = true;
    };
  }, [activeNotebook.awsProfile, activeNotebookId]);

  useEffect(() => {
    if (!activeNotebook.awsProfile) {
      setAvailableBuckets([]);
      setBucketTotalPages(1);
      setBucketTotalItems(0);
      return;
    }

    let cancelled = false;

    async function loadBuckets() {
      setLoadingBuckets(true);
      setAwsError(null);

      try {
        const response = await fetch(
          `/api/aws/buckets?profile=${encodeURIComponent(
            activeNotebook.awsProfile,
          )}&search=${encodeURIComponent(bucketSearch)}&page=${bucketPage}&pageSize=12`,
        );
        const payload = (await response.json()) as {
          buckets?: string[];
          page?: number;
          totalPages?: number;
          total?: number;
          error?: string;
        };

        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to load S3 buckets");
        }

        if (cancelled) {
          return;
        }

        const buckets = payload.buckets ?? [];
        setAvailableBuckets(buckets);
        setBucketTotalPages(payload.totalPages ?? 1);
        setBucketTotalItems(payload.total ?? 0);

        if (buckets.length > 0 && !buckets.includes(activeNotebook.bucket)) {
          setNotebooks((currentNotebooks) =>
            currentNotebooks.map((notebook) =>
              notebook.id === activeNotebookId
                ? {
                    ...notebook,
                    bucket: buckets[0],
                    rootPrefix: "",
                    partitionOverrides: {},
                    partitionFilters: {},
                    updatedAt: "Just now",
                  }
                : notebook,
            ),
          );
        }
      } catch (error) {
        if (!cancelled) {
          setAwsError(
            error instanceof Error ? error.message : "Failed to load S3 buckets",
          );
          setAvailableBuckets([]);
          setBucketTotalPages(1);
          setBucketTotalItems(0);
        }
      } finally {
        if (!cancelled) {
          setLoadingBuckets(false);
        }
      }
    }

    void loadBuckets();

    return () => {
      cancelled = true;
    };
  }, [
    activeNotebook.awsProfile,
    activeNotebook.bucket,
    activeNotebookId,
    bucketPage,
    bucketSearch,
    bucketReloadToken,
  ]);

  useEffect(() => {
    if (!activeNotebook.awsProfile || !activeNotebook.bucket) {
      setAvailablePrefixes([]);
      setNextPrefixCursor(null);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      setLoadingPrefixes(true);
      setAwsError(null);

      try {
        const response = await fetch(
          `/api/aws/prefixes?profile=${encodeURIComponent(
            activeNotebook.awsProfile,
          )}&bucket=${encodeURIComponent(
            activeNotebook.bucket,
          )}&prefix=${encodeURIComponent(
            activeNotebook.rootPrefix,
          )}&maxKeys=25${
            prefixCursor
              ? `&continuationToken=${encodeURIComponent(prefixCursor)}`
              : ""
          }`,
        );
        const payload = (await response.json()) as {
          prefixes?: string[];
          nextContinuationToken?: string | null;
          error?: string;
        };

        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to load S3 prefixes");
        }

        if (!cancelled) {
          setAvailablePrefixes(payload.prefixes ?? []);
          setNextPrefixCursor(payload.nextContinuationToken ?? null);
        }
      } catch (error) {
        if (!cancelled) {
          setAwsError(
            error instanceof Error ? error.message : "Failed to load S3 prefixes",
          );
          setAvailablePrefixes([]);
          setNextPrefixCursor(null);
        }
      } finally {
        if (!cancelled) {
          setLoadingPrefixes(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    activeNotebook.awsProfile,
    activeNotebook.bucket,
    activeNotebook.rootPrefix,
    activeNotebookId,
    prefixCursor,
  ]);

  useEffect(() => {
    if (!activeNotebook.awsProfile || !activeNotebook.bucket) {
      setPartitionDefinitions([]);
      return;
    }

    let cancelled = false;
    setPartitionDefinitions([]);
    const timeoutId = window.setTimeout(async () => {
      setLoadingPartitions(true);

      try {
        const response = await fetch(
          `/api/aws/partitions?profile=${encodeURIComponent(
            activeNotebook.awsProfile,
          )}&bucket=${encodeURIComponent(
            activeNotebook.bucket,
          )}&rootPrefix=${encodeURIComponent(
            activeNotebook.rootPrefix,
          )}&pathPattern=${encodeURIComponent(activeNotebook.customPathPattern)}`,
        );
        const payload = (await response.json()) as {
          partitions?: PartitionDefinition[];
          error?: string;
        };

        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to infer Hive partitions");
        }

        if (cancelled) {
          return;
        }

        const nextDefinitions = payload.partitions ?? [];
        setPartitionDefinitions(nextDefinitions);

        const nextKeys = new Set(nextDefinitions.map((partition) => partition.key));

        setNotebooks((currentNotebooks) =>
          currentNotebooks.map((notebook) => {
            if (notebook.id !== activeNotebookId) {
              return notebook;
            }

            const nextFilters = Object.fromEntries(
              Object.entries(notebook.partitionFilters ?? {}).filter(([key, value]) => {
                const definition = nextDefinitions.find(
                  (partition) => partition.key === key,
                );

                return Boolean(definition && definition.values.includes(value));
              }),
            );

            for (const key of Object.keys(nextFilters)) {
              if (!nextKeys.has(key)) {
                delete nextFilters[key];
              }
            }

            return {
              ...notebook,
              partitionOverrides: Object.fromEntries(
                Object.entries(notebook.partitionOverrides ?? {}).filter(([key]) =>
                  nextKeys.has(key),
                ),
              ),
              partitionFilters: nextFilters,
            };
          }),
        );
      } catch (error) {
        if (!cancelled) {
          setAwsError(
            error instanceof Error ? error.message : "Failed to infer Hive partitions",
          );
          setPartitionDefinitions([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingPartitions(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    activeNotebook.awsProfile,
    activeNotebook.bucket,
    activeNotebook.rootPrefix,
    activeNotebook.customPathPattern,
    activeNotebookId,
  ]);

  useEffect(() => {
    setBucketPage(1);
  }, [bucketSearch, activeNotebook.awsProfile]);

  useEffect(() => {
    setPrefixCursor(null);
    setPrefixCursorStack([]);
    setNextPrefixCursor(null);
  }, [activeNotebook.awsProfile, activeNotebook.bucket, activeNotebook.rootPrefix]);

  const profileChoices =
    availableProfiles.length > 0 ? availableProfiles : profileOptions;
  const bucketChoices = availableBuckets.includes(activeNotebook.bucket)
    ? availableBuckets
    : activeNotebook.bucket
      ? [activeNotebook.bucket, ...availableBuckets]
      : availableBuckets;
  const prefixPage = prefixCursorStack.length + 1;
  const prefixParts = activeNotebook.rootPrefix.split("/").filter(Boolean);
  const prefixLabel =
    activeNotebook.rootPrefix.trim() === "" ? "/" : activeNotebook.rootPrefix;
  const hasCustomPattern = activeNotebook.customPathPattern.trim().length > 0;
  const editablePartitions = [...partitionDefinitions]
    .sort((left, right) =>
      left.level === right.level
        ? left.order === right.order
          ? left.key.localeCompare(right.key)
          : left.order - right.order
        : left.level - right.level,
    )
    .map((partition) => {
      const override = activeNotebook.partitionOverrides?.[partition.key];
      return {
        ...partition,
        label: override?.label || partition.key,
        kind: override?.kind || partition.kind,
        hidden: override?.hidden ?? false,
        selectedValue: activeNotebook.partitionFilters?.[partition.key] ?? "",
      };
    });

  function updatePartitionFilter(key: string, value: string) {
    setNotebooks((currentNotebooks) =>
      currentNotebooks.map((notebook) => {
        if (notebook.id !== activeNotebookId) {
          return notebook;
        }

        const nextFilters = { ...notebook.partitionFilters };

        if (!value) {
          delete nextFilters[key];
        } else {
          nextFilters[key] = value;
        }

        return {
          ...notebook,
          partitionFilters: nextFilters,
          updatedAt: "Just now",
        };
      }),
    );
  }

  function updatePartitionOverride(
    key: string,
    patch: Partial<Notebook["partitionOverrides"][string]>,
  ) {
    setNotebooks((currentNotebooks) =>
      currentNotebooks.map((notebook) => {
        if (notebook.id !== activeNotebookId) {
          return notebook;
        }

        const currentOverride = notebook.partitionOverrides?.[key] ?? {
          label: key,
          kind:
            partitionDefinitions.find((partition) => partition.key === key)?.kind ??
            "category",
          hidden: false,
        };

        return {
          ...notebook,
          partitionOverrides: {
            ...notebook.partitionOverrides,
            [key]: {
              ...currentOverride,
              ...patch,
            },
          },
          updatedAt: "Just now",
        };
      }),
    );
  }

  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">WAML</p>
            <h1>Notebooks</h1>
          </div>
          <button className="secondary-button" type="button" onClick={createNotebook}>
            New
          </button>
        </div>

        <div className="notebook-list">
          {notebooks.map((notebook) => (
            <button
              key={notebook.id}
              className={`notebook-item${
                notebook.id === activeNotebook.id ? " is-active" : ""
              }`}
              type="button"
              onClick={() => setActiveNotebookId(notebook.id)}
            >
              <div className="notebook-row">
                <h2>{notebook.title}</h2>
                <span className={`status status-${notebook.status}`}>
                  {statusLabel(notebook.status)}
                </span>
              </div>
              <p className="notebook-query">{notebook.query}</p>
              <div className="notebook-meta">
                <span>{notebook.range}</span>
                <span>{notebook.updatedAt}</span>
              </div>
              <p className="notebook-source">
                {notebook.awsProfile} · {notebook.bucket}/{notebook.rootPrefix}
              </p>
            </button>
          ))}
        </div>
      </aside>

      <section className="content">
        <header className="content-header">
          <div>
            <p className="eyebrow">Notebook</p>
            <input
              className="title-input"
              aria-label="Notebook title"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={renameNotebook}
            />
          </div>
          <div className="notebook-actions">
            <button className="secondary-button" type="button" onClick={duplicateNotebook}>
              Duplicate
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={deleteNotebook}
              disabled={notebooks.length <= 1}
            >
              Delete
            </button>
          </div>
        </header>

        <section className="search-bar">
          <div className="field field-profile">
            <label htmlFor="aws-profile">AWS profile</label>
            <select
              className="control"
              id="aws-profile"
              value={activeNotebook.awsProfile}
              onChange={(event) =>
                updateActiveNotebook("awsProfile", event.target.value)
              }
            >
              {profileChoices.map((profile) => (
                <option key={profile} value={profile}>
                  {profile}
                </option>
              ))}
            </select>
            <span className="field-state">
              {loadingProfiles
                ? "Loading profiles..."
                : `s3://${activeNotebook.bucket}/${activeNotebook.rootPrefix}`}
            </span>
          </div>
          <div className="field field-bucket">
            <label>Bucket</label>
            <div className="picker" ref={bucketPickerRef}>
              <button
                className="picker-trigger"
                type="button"
                onClick={() => {
                  setBucketPickerOpen((open) => !open);
                  setPrefixPickerOpen(false);
                }}
              >
                <span>{activeNotebook.bucket || "Select bucket"}</span>
                <span className="picker-chevron">▾</span>
              </button>
              {bucketPickerOpen ? (
                <div className="picker-menu">
                  <div className="picker-toolbar">
                    <input
                      value={bucketSearch}
                      placeholder="Search buckets"
                      onChange={(event) => setBucketSearch(event.target.value)}
                    />
                    <button
                      className="secondary-button picker-refresh"
                      type="button"
                      disabled={loadingBuckets}
                      onClick={() => setBucketReloadToken((value) => value + 1)}
                    >
                      Refresh
                    </button>
                  </div>
                  <div className="picker-list">
                    {bucketChoices.map((bucket) => (
                      <button
                        key={bucket}
                        type="button"
                        className={`picker-option${
                          bucket === activeNotebook.bucket ? " is-selected" : ""
                        }`}
                        onClick={() => {
                          updateActiveNotebook("bucket", bucket);
                          setBucketPickerOpen(false);
                        }}
                      >
                        {bucket}
                      </button>
                    ))}
                    {bucketChoices.length === 0 && !loadingBuckets ? (
                      <div className="picker-empty">No buckets found</div>
                    ) : null}
                  </div>
                  <div className="picker-footer">
                    <span className="field-state">
                      {loadingBuckets
                        ? "Loading buckets..."
                        : `${bucketTotalItems} buckets · page ${bucketPage} of ${bucketTotalPages}`}
                    </span>
                    <div className="pager-row">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={bucketPage <= 1 || loadingBuckets}
                        onClick={() =>
                          setBucketPage((page) => Math.max(1, page - 1))
                        }
                      >
                        Prev
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={bucketPage >= bucketTotalPages || loadingBuckets}
                        onClick={() =>
                          setBucketPage((page) =>
                            Math.min(bucketTotalPages, page + 1),
                          )
                        }
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="field field-prefix">
            <label>Root prefix</label>
            <div className="picker" ref={prefixPickerRef}>
              <button
                className="picker-trigger"
                type="button"
                onClick={() => {
                  setPrefixPickerOpen((open) => !open);
                  setBucketPickerOpen(false);
                }}
              >
                <span>{activeNotebook.rootPrefix || "Select root prefix"}</span>
                <span className="picker-chevron">▾</span>
              </button>
              {prefixPickerOpen ? (
                <div className="picker-menu">
                  <div className="browser-header">
                    <div className="browser-path">
                      <button
                        type="button"
                        className={`breadcrumb breadcrumb-root${
                          activeNotebook.rootPrefix === "" ? " is-current" : ""
                        }`}
                        onClick={() => updateActiveNotebook("rootPrefix", "")}
                      >
                        /
                      </button>
                      {prefixParts.map((part, index) => {
                        const nextPrefix = `${prefixParts
                          .slice(0, index + 1)
                          .join("/")}/`;

                        return (
                          <button
                            key={nextPrefix}
                            type="button"
                            className={`breadcrumb${
                              nextPrefix === activeNotebook.rootPrefix
                                ? " is-current"
                                : ""
                            }`}
                            onClick={() => updateActiveNotebook("rootPrefix", nextPrefix)}
                          >
                            {part}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <input
                    value={activeNotebook.rootPrefix}
                    placeholder="Jump to prefix"
                    onChange={(event) =>
                      updateActiveNotebook("rootPrefix", event.target.value)
                    }
                  />
                  <div className="picker-list">
                    <div className="picker-current">
                      <span className="picker-current-label">Current</span>
                      <strong>{prefixLabel}</strong>
                    </div>
                    {availablePrefixes.map((prefix) => (
                      <button
                        key={prefix}
                        type="button"
                        className={`picker-option browser-entry${
                          prefix === activeNotebook.rootPrefix ? " is-selected" : ""
                        }`}
                        onClick={() => updateActiveNotebook("rootPrefix", prefix)}
                      >
                        <span className="browser-entry-main">
                          <span className="browser-folder">/</span>
                          <span>{getPrefixLabel(activeNotebook.rootPrefix, prefix)}</span>
                        </span>
                        <span className="browser-entry-arrow">›</span>
                      </button>
                    ))}
                    {availablePrefixes.length === 0 &&
                    activeNotebook.rootPrefix.trim() !== "" &&
                    !loadingPrefixes ? (
                      <div className="picker-current picker-current-compact">
                        <span className="picker-current-label">Using current path</span>
                        <strong>{prefixLabel}</strong>
                      </div>
                    ) : null}
                    {availablePrefixes.length === 0 && !loadingPrefixes ? (
                      <div className="picker-empty">No prefixes found</div>
                    ) : null}
                  </div>
                  <div className="picker-footer">
                    <span className="field-state">
                      {loadingPrefixes
                        ? "Loading prefixes..."
                        : nextPrefixCursor
                          ? `Page ${prefixPage} · more available`
                          : `Page ${prefixPage}`}
                    </span>
                    <div className="pager-row">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={prefixCursorStack.length === 0 || loadingPrefixes}
                        onClick={goToPreviousPrefixPage}
                      >
                        Prev
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={!nextPrefixCursor || loadingPrefixes}
                        onClick={() => selectPrefixPage(nextPrefixCursor)}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          {awsError ? (
            <div className="field search-root-hint">
              <p className="field-error">{awsError}</p>
            </div>
          ) : null}
          <div className="field search-root-hint">
            <label htmlFor="custom-path-pattern">Custom path pattern</label>
            <input
              id="custom-path-pattern"
              value={activeNotebook.customPathPattern ?? ""}
              placeholder="Optional. Example: env={category:env}/year={range:year}/month={range:month} or year={range:year}/{range:day}-{range:hour}-{category:file_id}.log"
              onChange={(event) =>
                updateActiveNotebook("customPathPattern", event.target.value)
              }
            />
            <p className="field-state">
              Use captures like <code>{`{category:name}`}</code> and{" "}
              <code>{`{range:name}`}</code> relative to the selected root prefix.
              You can match both directory segments and filenames.
            </p>
          </div>
          {partitionDefinitions.length > 0 || loadingPartitions ? (
            <div className="partition-section">
              <div className="partition-header">
                <div>
                  <label>Dynamic filters</label>
                  <p className="field-state">
                    {loadingPartitions
                      ? "Inspecting prefixes for partition keys..."
                      : hasCustomPattern
                        ? "Filters inferred from Hive partitions plus the active custom path pattern."
                        : "Filters inferred from Hive-style key=value path segments under the selected root."}
                  </p>
                </div>
                {hasCustomPattern ? (
                  <span className="partition-mode-badge">Custom pattern active</span>
                ) : null}
              </div>
              {editablePartitions.length > 0 ? (
                <div className="partition-strip">
                  {editablePartitions.map((partition) => (
                    <div
                      key={partition.key}
                      className={`partition-chip${partition.hidden ? " is-muted" : ""}`}
                    >
                      <div className="partition-chip-header">
                        <input
                          className="partition-chip-title"
                          aria-label={`Label for ${partition.key}`}
                          value={partition.label}
                          onChange={(event) =>
                            updatePartitionOverride(partition.key, {
                              label: event.target.value,
                            })
                          }
                        />
                        <span className={`filter-source-badge source-${partition.source}`}>
                          {partition.source}
                        </span>
                      </div>
                      <div className="partition-chip-controls">
                        <select
                          id={`partition-${partition.key}`}
                          className="control"
                          value={partition.selectedValue}
                          disabled={partition.hidden}
                          onChange={(event) =>
                            updatePartitionFilter(partition.key, event.target.value)
                          }
                        >
                          <option value="">All</option>
                          {partition.values.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                        <select
                          className="control partition-kind-select"
                          value={partition.kind}
                          onChange={(event) =>
                            updatePartitionOverride(partition.key, {
                              kind: event.target.value as "category" | "range",
                            })
                          }
                        >
                          <option value="category">Category</option>
                          <option value="range">Range</option>
                        </select>
                        <label className="partition-toggle">
                          <input
                            type="checkbox"
                            checked={!partition.hidden}
                            onChange={(event) =>
                              updatePartitionOverride(partition.key, {
                                hidden: !event.target.checked,
                              })
                            }
                          />
                          <span>Show</span>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
