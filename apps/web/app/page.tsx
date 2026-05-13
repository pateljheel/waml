"use client";

import { useEffect, useRef, useState } from "react";

type Notebook = {
  id: string;
  title: string;
  status: "running" | "idle";
  awsProfile: string;
  bucket: string;
  rootPrefix: string;
  query: string;
  range: string;
  updatedAt: string;
};

const initialNotebooks: Notebook[] = [
  {
    id: "checkout-errors",
    title: "Checkout errors",
    status: "running",
    awsProfile: "prod-observability",
    bucket: "company-prod-logs",
    rootPrefix: "apps/checkout/prod/",
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

export default function HomePage() {
  const bucketPickerRef = useRef<HTMLDivElement | null>(null);
  const prefixPickerRef = useRef<HTMLDivElement | null>(null);
  const [notebooks, setNotebooks] = useState(initialNotebooks);
  const [activeNotebookId, setActiveNotebookId] = useState(initialNotebooks[0].id);
  const [draftTitle, setDraftTitle] = useState(initialNotebooks[0].title);
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [availableBuckets, setAvailableBuckets] = useState<string[]>([]);
  const [availablePrefixes, setAvailablePrefixes] = useState<string[]>([]);
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
        setNotebooks(parsed);
        setActiveNotebookId(parsed[0].id);
        setDraftTitle(parsed[0].title);
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
                ? { ...notebook, bucket: buckets[0], rootPrefix: "", updatedAt: "Just now" }
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
              {loadingProfiles ? "Loading profiles..." : "Profiles from ~/.aws"}
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
          <div className="field search-root-hint">
            <label>Search root</label>
            <div className="hint-box">
              <strong>
                s3://{activeNotebook.bucket}/{activeNotebook.rootPrefix}
              </strong>
              <span>
                WAML infers partitions and files relative to this prefix.
              </span>
            </div>
            {awsError ? <p className="field-error">{awsError}</p> : null}
          </div>
        </section>
      </section>
    </main>
  );
}
