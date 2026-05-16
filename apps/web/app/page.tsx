"use client";

import type {
  LineTimestampParser,
  PrefixFilterSelection,
  NotebookTimeConfig,
  PrefixFilters,
  QueryMode,
  SearchJob,
  SearchJobStatus,
  SearchMatch,
  TimeComponent,
} from "@waml/shared";
import { normalizePrefixFilters } from "@waml/shared";
import { useEffect, useRef, useState } from "react";

type Notebook = {
  id: string;
  title: string;
  status: "running" | "idle";
  queryMode: QueryMode;
  awsProfile: string;
  bucket: string;
  rootPrefix: string;
  customPathPattern: string;
  searchOptions: {
    caseSensitive: boolean;
  };
  timeConfig: NotebookTimeConfig;
  timeSampleLine: string;
  partitionOverrides: Record<
    string,
    {
      label: string;
      kind: "category" | "range";
      hidden: boolean;
    }
  >;
  partitionFilters: PrefixFilters;
  query: string;
  pageSize: number;
  contextLineCount: number;
  startTime: string;
  endTime: string;
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

type NotebookSearchState = {
  jobId: string | null;
  status: SearchJobStatus | "idle";
  progress: {
    bytesScanned: number;
    objectsScanned: number;
    chunksScanned: number;
    matchesFound: number;
  };
  page: number;
  pageSize: number;
  totalResults: number;
  loadingPage: boolean;
  results: SearchMatch[];
  cache: {
    hits: number;
    misses: number;
    writes: number;
    evictions: number;
    recentEvents: Array<{
      type: "cache.hit" | "cache.miss" | "cache.write" | "cache.evicted";
      objectKey: string;
      chunkId?: string | null;
      detail?: string | null;
    }>;
  };
  errorMessage: string | null;
  connected: boolean;
  contextByResultKey: Record<
    string,
    {
      loading: boolean;
      error: string | null;
      lines: Array<{
        objectKey: string;
        lineNumber: number;
        lineText: string;
        isMatch: boolean;
      }>;
      open: boolean;
      source: "cache" | "s3" | null;
    }
  >;
};

type TimePreviewState = {
  loading: boolean;
  coarseRange: {
    start: string;
    end: string;
  } | null;
  extractedText: string | null;
  lineTimestamp: string | null;
  errors: string[];
};

type PartitionValuePickerState = {
  open: boolean;
  search: string;
  page: number;
  totalPages: number;
  totalItems: number;
  values: string[];
  loading: boolean;
  error: string | null;
};

type CacheInvalidateState = {
  loading: boolean;
  message: string | null;
  error: string | null;
};

const initialNotebooks: Notebook[] = [
  {
    id: "checkout-errors",
    title: "Checkout errors",
    status: "running",
    queryMode: "substring",
    awsProfile: "prod-observability",
    bucket: "company-prod-logs",
    rootPrefix: "apps/checkout/prod/",
    customPathPattern: "",
    searchOptions: {
      caseSensitive: false,
    },
    timeConfig: createDefaultTimeConfig(),
    timeSampleLine: "",
    partitionOverrides: {},
    partitionFilters: {},
    query: 'timeout while awaiting headers service="checkout-api"',
    pageSize: 100,
    contextLineCount: 20,
    startTime: "",
    endTime: "",
    range: "Last 90 min",
    updatedAt: "2 min ago",
  },
  {
    id: "auth-refresh",
    title: "Auth refresh",
    status: "idle",
    queryMode: "substring",
    awsProfile: "prod-observability",
    bucket: "company-prod-logs",
    rootPrefix: "apps/auth/prod/",
    customPathPattern: "",
    searchOptions: {
      caseSensitive: false,
    },
    timeConfig: createDefaultTimeConfig(),
    timeSampleLine: "",
    partitionOverrides: {},
    partitionFilters: {},
    query: 'token refresh failed service="auth-service"',
    pageSize: 100,
    contextLineCount: 20,
    startTime: "",
    endTime: "",
    range: "Today",
    updatedAt: "14 min ago",
  },
  {
    id: "queue-latency",
    title: "Queue latency",
    status: "idle",
    queryMode: "substring",
    awsProfile: "stage-observability",
    bucket: "company-stage-logs",
    rootPrefix: "workers/ingest/staging/",
    customPathPattern: "",
    searchOptions: {
      caseSensitive: false,
    },
    timeConfig: createDefaultTimeConfig(),
    timeSampleLine: "",
    partitionOverrides: {},
    partitionFilters: {},
    query: 'consumer lag service="worker-ingest"',
    pageSize: 100,
    contextLineCount: 20,
    startTime: "",
    endTime: "",
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

function searchStatusLabel(status: NotebookSearchState["status"]) {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "cancelling":
      return "Cancelling";
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

function createEmptySearchState(): NotebookSearchState {
  return {
    jobId: null,
    status: "idle",
    progress: {
      bytesScanned: 0,
      objectsScanned: 0,
      chunksScanned: 0,
      matchesFound: 0,
    },
    page: 1,
    pageSize: 100,
    totalResults: 0,
    loadingPage: false,
    results: [],
    cache: {
      hits: 0,
      misses: 0,
      writes: 0,
      evictions: 0,
      recentEvents: [],
    },
    errorMessage: null,
    connected: false,
    contextByResultKey: {},
  };
}

function createDefaultTimeConfig(): NotebookTimeConfig {
  return {
    timezone: "UTC",
    pathMappings: [],
    lineParser: {
      mode: "none",
    },
  };
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
  const normalizedNotebook = {
    status: "idle" as Notebook["status"],
    awsProfile: "",
    queryMode: "substring" as QueryMode,
    bucket: "",
    rootPrefix: "",
    customPathPattern: "",
    searchOptions: {
      caseSensitive: false,
    },
    timeConfig: createDefaultTimeConfig(),
    timeSampleLine: "",
    partitionOverrides: {},
    partitionFilters: {},
    query: "",
    pageSize: 100,
    contextLineCount: 20,
    startTime: "",
    endTime: "",
    range: "",
    updatedAt: "Just now",
    ...notebook,
  };

  return {
    ...normalizedNotebook,
    customPathPattern: normalizedNotebook.customPathPattern ?? "",
    searchOptions: normalizedNotebook.searchOptions ?? {
      caseSensitive: false,
    },
    timeConfig: normalizedNotebook.timeConfig ?? createDefaultTimeConfig(),
    timeSampleLine: normalizedNotebook.timeSampleLine ?? "",
    partitionOverrides: normalizedNotebook.partitionOverrides ?? {},
    partitionFilters: normalizePrefixFilters(normalizedNotebook.partitionFilters),
    contextLineCount: normalizedNotebook.contextLineCount ?? 20,
  } satisfies Notebook;
}

function clonePrefixFilters(prefixFilters: PrefixFilters) {
  return Object.fromEntries(
    Object.entries(prefixFilters).map(([key, filter]) => [
      key,
      filter.mode === "values"
        ? { mode: "values", values: [...filter.values] }
        : { mode: "range", start: filter.start, end: filter.end },
    ]),
  ) as PrefixFilters;
}

export default function HomePage() {
  const bucketPickerRef = useRef<HTMLDivElement | null>(null);
  const prefixPickerRef = useRef<HTMLDivElement | null>(null);
  const partitionPickerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const eventSourcesRef = useRef<Record<string, EventSource>>({});
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
  const [searchStateByNotebook, setSearchStateByNotebook] = useState<
    Record<string, NotebookSearchState>
  >({});
  const [timePreviewByNotebook, setTimePreviewByNotebook] = useState<
    Record<string, TimePreviewState>
  >({});
  const [partitionPickerState, setPartitionPickerState] = useState<
    Record<string, PartitionValuePickerState>
  >({});
  const [cacheInvalidateByNotebook, setCacheInvalidateByNotebook] = useState<
    Record<string, CacheInvalidateState>
  >({});

  const activeNotebook =
    notebooks.find((notebook) => notebook.id === activeNotebookId) ?? notebooks[0];
  const partitionPickerQueryKey = JSON.stringify(
    Object.entries(partitionPickerState)
      .filter(([, state]) => state.open)
      .map(([key, state]) => ({
        key,
        search: state.search,
        page: state.page,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  );

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

      setPartitionPickerState((current) => {
        let changed = false;
        const nextState: Record<string, PartitionValuePickerState> = {};

        for (const [key, state] of Object.entries(current)) {
          const ref = partitionPickerRefs.current[key];
          const shouldClose = Boolean(
            state.open && ref && !ref.contains(target),
          );
          nextState[key] = shouldClose ? { ...state, open: false } : state;
          changed = changed || shouldClose;
        }

        return changed ? nextState : current;
      });
    }

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  useEffect(() => {
    return () => {
      Object.values(eventSourcesRef.current).forEach((source) => source.close());
      eventSourcesRef.current = {};
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

  function setNotebookStatus(notebookId: string, status: Notebook["status"]) {
    setNotebooks((currentNotebooks) =>
      currentNotebooks.map((notebook) =>
        notebook.id === notebookId ? { ...notebook, status } : notebook,
      ),
    );
  }

  function setSearchState(
    notebookId: string,
    updater:
      | NotebookSearchState
      | ((current: NotebookSearchState) => NotebookSearchState),
  ) {
    setSearchStateByNotebook((current) => {
      const existing = current[notebookId] ?? createEmptySearchState();
      const nextValue =
        typeof updater === "function"
          ? updater(existing)
          : updater;

      return {
        ...current,
        [notebookId]: nextValue,
      };
    });
  }

  function setTimePreviewState(
    notebookId: string,
    updater:
      | TimePreviewState
      | ((current: TimePreviewState) => TimePreviewState),
  ) {
    setTimePreviewByNotebook((current) => {
      const existing = current[notebookId] ?? {
        loading: false,
        coarseRange: null,
        extractedText: null,
        lineTimestamp: null,
        errors: [],
      };
      const nextValue =
        typeof updater === "function" ? updater(existing) : updater;

      return {
        ...current,
        [notebookId]: nextValue,
      };
    });
  }

  function setPartitionPickerEntry(
    key: string,
    updater:
      | PartitionValuePickerState
      | ((current: PartitionValuePickerState) => PartitionValuePickerState),
  ) {
    setPartitionPickerState((current) => {
      const existing = current[key] ?? {
        open: false,
        search: "",
        page: 1,
        totalPages: 1,
        totalItems: 0,
        values: [],
        loading: false,
        error: null,
      };
      const nextValue =
        typeof updater === "function" ? updater(existing) : updater;

      return {
        ...current,
        [key]: nextValue,
      };
    });
  }

  function setCacheInvalidateState(
    notebookId: string,
    updater:
      | CacheInvalidateState
      | ((current: CacheInvalidateState) => CacheInvalidateState),
  ) {
    setCacheInvalidateByNotebook((current) => {
      const existing = current[notebookId] ?? {
        loading: false,
        message: null,
        error: null,
      };
      const nextValue =
        typeof updater === "function" ? updater(existing) : updater;

      return {
        ...current,
        [notebookId]: nextValue,
      };
    });
  }

  function closeSearchStream(notebookId: string) {
    const source = eventSourcesRef.current[notebookId];

    if (source) {
      source.close();
      delete eventSourcesRef.current[notebookId];
    }
  }

  async function fetchResultsPage(
    notebookId: string,
    jobId: string,
    page: number,
    pageSize: number,
  ) {
    setSearchState(notebookId, (current) => ({
      ...current,
      loadingPage: true,
      errorMessage: null,
    }));

    const response = await fetch(
      `/api/search/${jobId}/results?page=${page}&pageSize=${pageSize}`,
      {
        cache: "no-store",
      },
    );
    const payload = (await response.json()) as {
      page?: number;
      pageSize?: number;
      totalResults?: number;
      results?: SearchMatch[];
      job?: SearchJob;
      error?: string;
    };

    if (!response.ok || !payload.job) {
      setSearchState(notebookId, (current) => ({
        ...current,
        loadingPage: false,
        errorMessage: payload.error ?? "Failed to load results",
      }));
      return;
    }

    setSearchState(notebookId, (current) => ({
      ...current,
      progress: payload.job?.progress ?? current.progress,
      status: payload.job?.status ?? current.status,
      page: payload.page ?? page,
      pageSize: payload.pageSize ?? pageSize,
      totalResults: payload.totalResults ?? current.totalResults,
      results: payload.results ?? [],
      loadingPage: false,
    }));
  }

  async function loadNextResultsPage() {
    const currentSearch = searchStateByNotebook[activeNotebook.id];

    if (!currentSearch?.jobId) {
      return;
    }

    const nextPage = currentSearch.page + 1;
    const bufferedResultsNeeded = nextPage * currentSearch.pageSize;

    if (bufferedResultsNeeded <= currentSearch.totalResults) {
      await fetchResultsPage(
        activeNotebook.id,
        currentSearch.jobId,
        nextPage,
        currentSearch.pageSize,
      );
      return;
    }

    const response = await fetch(`/api/search/${currentSearch.jobId}/more`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        additionalResults: currentSearch.pageSize,
      }),
    });
    const payload = (await response.json()) as {
      job?: SearchJob;
      error?: string;
    };

    if (!response.ok || !payload.job) {
      setSearchState(activeNotebook.id, (current) => ({
        ...current,
        errorMessage: payload.error ?? "Failed to request more results",
      }));
      return;
    }

    setSearchState(activeNotebook.id, (current) => ({
      ...current,
      status: payload.job?.status ?? current.status,
      loadingPage: true,
    }));
  }

  async function loadPreviousResultsPage() {
    const currentSearch = searchStateByNotebook[activeNotebook.id];

    if (!currentSearch?.jobId || currentSearch.page <= 1) {
      return;
    }

    await fetchResultsPage(
      activeNotebook.id,
      currentSearch.jobId,
      currentSearch.page - 1,
      currentSearch.pageSize,
    );
  }

  function getResultContextKey(result: SearchMatch) {
    return `${result.objectKey}:${result.etag ?? ""}:${result.lineNumber}`;
  }

  async function toggleResultContext(result: SearchMatch) {
    const currentSearch = searchStateByNotebook[activeNotebook.id];

    if (!currentSearch?.jobId) {
      return;
    }

    const contextKey = getResultContextKey(result);
    const existing = currentSearch.contextByResultKey[contextKey];

    if (existing && existing.open) {
      setSearchState(activeNotebook.id, (current) => ({
        ...current,
        contextByResultKey: {
          ...current.contextByResultKey,
          [contextKey]: {
            ...existing,
            open: false,
          },
        },
      }));
      return;
    }

    if (existing && existing.lines.length > 0) {
      setSearchState(activeNotebook.id, (current) => ({
        ...current,
        contextByResultKey: {
          ...current.contextByResultKey,
          [contextKey]: {
            ...existing,
            open: true,
          },
        },
      }));
      return;
    }

    setSearchState(activeNotebook.id, (current) => ({
      ...current,
      contextByResultKey: {
        ...current.contextByResultKey,
        [contextKey]: {
          loading: true,
          error: null,
          lines: [],
          open: true,
          source: null,
        },
      },
    }));

    const response = await fetch(
      `/api/search/${currentSearch.jobId}/context?objectKey=${encodeURIComponent(
        result.objectKey,
      )}&etag=${encodeURIComponent(result.etag ?? "")}&lineNumber=${
        result.lineNumber
      }&before=${activeNotebook.contextLineCount}&after=${activeNotebook.contextLineCount}`,
      {
        cache: "no-store",
      },
    );
    const payload = (await response.json()) as {
      lines?: Array<{
        objectKey: string;
        lineNumber: number;
        lineText: string;
        isMatch: boolean;
      }>;
      source?: "cache" | "s3";
      error?: string;
    };

    if (!response.ok) {
      setSearchState(activeNotebook.id, (current) => ({
        ...current,
        contextByResultKey: {
          ...current.contextByResultKey,
          [contextKey]: {
            loading: false,
            error: payload.error ?? "Failed to load context",
            lines: [],
            open: true,
            source: null,
          },
        },
      }));
      return;
    }

    setSearchState(activeNotebook.id, (current) => ({
      ...current,
      contextByResultKey: {
        ...current.contextByResultKey,
        [contextKey]: {
          loading: false,
          error: null,
          lines: payload.lines ?? [],
          open: true,
          source: payload.source ?? null,
        },
      },
    }));
  }

  function openSearchStream(notebookId: string, jobId: string) {
    closeSearchStream(notebookId);
    const source = new EventSource(`/api/search/${jobId}/events`);
    eventSourcesRef.current[notebookId] = source;

    source.onopen = () => {
      setSearchState(notebookId, (current) => ({
        ...current,
        connected: true,
      }));
    };

    source.onmessage = (event) => {
      const message = JSON.parse(event.data) as {
        type: string;
        payload: Record<string, unknown>;
      };

      setSearchState(notebookId, (current) => {
        const next = { ...current, connected: true };

        if (message.type === "job.progress") {
          const payloadProgress = message.payload.progress as
            | NotebookSearchState["progress"]
            | undefined;

          if (payloadProgress) {
            next.progress = payloadProgress;
          }

          const payloadStatus = message.payload.status as SearchJobStatus | undefined;

          if (payloadStatus) {
            next.status = payloadStatus;
            setNotebookStatus(
              notebookId,
              payloadStatus === "running" || payloadStatus === "cancelling"
                ? "running"
                : "idle",
            );
          }
        }

        if (message.type === "results.available") {
          const totalResults =
            (message.payload.totalResults as number | undefined) ??
            current.totalResults;
          next.totalResults = totalResults;

          if (current.jobId) {
            void fetchResultsPage(
              notebookId,
              current.jobId,
              current.page,
              current.pageSize,
            );
          }
        }

        if (
          message.type === "cache.hit" ||
          message.type === "cache.miss" ||
          message.type === "cache.write" ||
          message.type === "cache.evicted"
        ) {
          const cacheEventType = message.type as
            | "cache.hit"
            | "cache.miss"
            | "cache.write"
            | "cache.evicted";
          const objectKey =
            (message.payload.objectKey as string | undefined) ?? "unknown";
          const chunkId =
            (message.payload.chunkId as string | undefined) ?? null;
          const detail =
            cacheEventType === "cache.hit" &&
            message.payload.trigramRejected === true
              ? "trigram-pruned"
              : cacheEventType === "cache.miss"
                ? "cold object"
                : null;
          const recentEvents = [
            ...next.cache.recentEvents,
            {
              type: cacheEventType,
              objectKey,
              chunkId,
              detail,
            },
          ].slice(-20);

          next.cache = {
            ...next.cache,
            hits: next.cache.hits + (cacheEventType === "cache.hit" ? 1 : 0),
            misses: next.cache.misses + (cacheEventType === "cache.miss" ? 1 : 0),
            writes: next.cache.writes + (cacheEventType === "cache.write" ? 1 : 0),
            evictions:
              next.cache.evictions + (cacheEventType === "cache.evicted" ? 1 : 0),
            recentEvents,
          };
        }

        if (message.type === "job.cancelling") {
          next.status = "cancelling";
          setNotebookStatus(notebookId, "running");
        }

        if (message.type === "job.paused") {
          next.status = "paused";
          setNotebookStatus(notebookId, "idle");
        }

        if (message.type === "job.cancelled") {
          next.status = "cancelled";
          next.connected = false;
          setNotebookStatus(notebookId, "idle");
          closeSearchStream(notebookId);
        }

        if (message.type === "job.completed") {
          next.status = "completed";
          next.connected = false;
          setNotebookStatus(notebookId, "idle");
          closeSearchStream(notebookId);
        }

        if (message.type === "job.failed") {
          next.status = "failed";
          next.errorMessage =
            (message.payload.errorMessage as string | undefined) ??
            "Search failed";
          next.connected = false;
          setNotebookStatus(notebookId, "idle");
          closeSearchStream(notebookId);
        }

        return next;
      });
    };

    source.onerror = () => {
      setSearchState(notebookId, (current) => ({
        ...current,
        connected: false,
      }));

      if (source.readyState === EventSource.CLOSED) {
        closeSearchStream(notebookId);
      }
    };
  }

  async function runSearch() {
    const pattern = activeNotebook.query.trim();

    if (!pattern || !activeNotebook.awsProfile || !activeNotebook.bucket) {
      return;
    }

    const response = await fetch("/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        notebookId: activeNotebook.id,
        mode: activeNotebook.queryMode,
        pattern,
        pageSize: activeNotebook.pageSize,
        startTime: activeNotebook.startTime,
        endTime: activeNotebook.endTime,
        source: {
          awsProfile: activeNotebook.awsProfile,
          bucket: activeNotebook.bucket,
          rootPrefix: activeNotebook.rootPrefix,
        },
        searchOptions: activeNotebook.searchOptions,
        timeConfig: activeNotebook.timeConfig,
        prefixFilters: activeNotebook.partitionFilters,
        customPathPattern: activeNotebook.customPathPattern,
      }),
    });

    const payload = (await response.json()) as {
      job?: SearchJob;
      error?: string;
    };

    if (!response.ok || !payload.job) {
      setSearchState(activeNotebook.id, (current) => ({
        ...current,
        status: "failed",
        errorMessage: payload.error ?? "Failed to start search",
      }));
      return;
    }

    setSearchState(activeNotebook.id, {
      jobId: payload.job.id,
      status: payload.job.status,
      progress: payload.job.progress,
      page: 1,
      pageSize: payload.job.pageSize,
      totalResults: 0,
      loadingPage: false,
      results: [],
      contextByResultKey: {},
      cache: {
        hits: 0,
        misses: 0,
        writes: 0,
        evictions: 0,
        recentEvents: [],
      },
      errorMessage: null,
      connected: false,
    });
    setNotebookStatus(activeNotebook.id, "running");
    openSearchStream(activeNotebook.id, payload.job.id);
  }

  async function cancelSearch() {
    const currentSearch = searchStateByNotebook[activeNotebook.id];

    if (!currentSearch?.jobId) {
      return;
    }

    const response = await fetch(`/api/search/${currentSearch.jobId}/cancel`, {
      method: "POST",
    });
    const payload = (await response.json()) as {
      job?: SearchJob;
      error?: string;
    };

    if (!response.ok || !payload.job) {
      setSearchState(activeNotebook.id, (current) => ({
        ...current,
        errorMessage: payload.error ?? "Failed to cancel search",
      }));
      return;
    }

    setSearchState(activeNotebook.id, (current) => ({
      ...current,
      status: payload.job?.status ?? current.status,
    }));
  }

  async function invalidateCache() {
    if (
      !activeNotebook.bucket.trim() ||
      !window.confirm(
        `Invalidate cached search artifacts for s3://${activeNotebook.bucket}/${activeNotebook.rootPrefix}?`,
      )
    ) {
      return;
    }

    setCacheInvalidateState(activeNotebook.id, {
      loading: true,
      message: null,
      error: null,
    });

    const response = await fetch("/api/cache/invalidate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bucket: activeNotebook.bucket,
        rootPrefix: activeNotebook.rootPrefix,
      }),
    });

    const payload = (await response.json()) as {
      removedChunks?: number;
      removedBytes?: number;
      error?: string;
    };

    if (!response.ok) {
      setCacheInvalidateState(activeNotebook.id, {
        loading: false,
        message: null,
        error: payload.error ?? "Failed to invalidate cache",
      });
      return;
    }

    setSearchState(activeNotebook.id, (current) => ({
      ...current,
      cache: {
        hits: 0,
        misses: 0,
        writes: 0,
        evictions: 0,
        recentEvents: [],
      },
    }));
    setCacheInvalidateState(activeNotebook.id, {
      loading: false,
      message: `Removed ${payload.removedChunks ?? 0} chunks and ${payload.removedBytes ?? 0} bytes of cached artifacts.`,
      error: null,
    });
  }

  function createNotebook() {
    const newNotebook: Notebook = {
      id: crypto.randomUUID(),
      title: `Notebook ${notebooks.length + 1}`,
      status: "idle",
      queryMode: activeNotebook.queryMode,
      awsProfile: activeNotebook.awsProfile,
      bucket: activeNotebook.bucket,
      rootPrefix: activeNotebook.rootPrefix,
      customPathPattern: activeNotebook.customPathPattern,
      searchOptions: activeNotebook.searchOptions,
      timeConfig: activeNotebook.timeConfig,
      timeSampleLine: activeNotebook.timeSampleLine,
      partitionOverrides: activeNotebook.partitionOverrides ?? {},
      partitionFilters: clonePrefixFilters(activeNotebook.partitionFilters ?? {}),
      query: "",
      pageSize: activeNotebook.pageSize,
      contextLineCount: activeNotebook.contextLineCount,
      startTime: activeNotebook.startTime,
      endTime: activeNotebook.endTime,
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
      partitionFilters: clonePrefixFilters(activeNotebook.partitionFilters ?? {}),
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
        const response = await fetch("/api/aws/profiles", {
          cache: "no-store",
        });
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
          {
            cache: "no-store",
          },
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
          {
            cache: "no-store",
          },
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
          {
            cache: "no-store",
          },
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
              Object.entries(notebook.partitionFilters ?? {}).filter(([key]) =>
                nextKeys.has(key),
              ),
            ) as PrefixFilters;

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

  useEffect(() => {
    const openEntries = Object.entries(partitionPickerState).filter(
      ([, state]) => state.open,
    );
    const openKeys = openEntries.map(([key]) => key);

    if (
      openKeys.length === 0 ||
      !activeNotebook.awsProfile ||
      !activeNotebook.bucket
    ) {
      return;
    }

    const controllers = openKeys.map((key) => {
      const controller = new AbortController();
      const state = partitionPickerState[key];

      void (async () => {
        setPartitionPickerEntry(key, (current) => ({
          ...current,
          loading: true,
          error: null,
        }));

        try {
          const response = await fetch(
            `/api/aws/partition-values?profile=${encodeURIComponent(
              activeNotebook.awsProfile,
            )}&bucket=${encodeURIComponent(
              activeNotebook.bucket,
            )}&rootPrefix=${encodeURIComponent(
              activeNotebook.rootPrefix,
            )}&pathPattern=${encodeURIComponent(
              activeNotebook.customPathPattern,
            )}&key=${encodeURIComponent(key)}&search=${encodeURIComponent(
              state.search,
            )}&page=${state.page}&pageSize=25`,
            {
              cache: "no-store",
              signal: controller.signal,
            },
          );
          const payload = (await response.json()) as {
            values?: string[];
            page?: number;
            totalPages?: number;
            total?: number;
            error?: string;
          };

          if (!response.ok) {
            throw new Error(payload.error ?? "Failed to load partition values");
          }

          setPartitionPickerEntry(key, (current) => ({
            ...current,
            values: payload.values ?? [],
            page: payload.page ?? current.page,
            totalPages: payload.totalPages ?? 1,
            totalItems: payload.total ?? 0,
            loading: false,
            error: null,
          }));
        } catch (error) {
          if ((error as Error).name === "AbortError") {
            return;
          }

          setPartitionPickerEntry(key, (current) => ({
            ...current,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to load partition values",
          }));
        }
      })();

      return controller;
    });

    return () => {
      controllers.forEach((controller) => controller.abort());
    };
  }, [
    partitionPickerQueryKey,
    activeNotebook.awsProfile,
    activeNotebook.bucket,
    activeNotebook.rootPrefix,
    activeNotebook.customPathPattern,
  ]);

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
  const allEditablePartitions = [...partitionDefinitions]
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
        selectedFilter: activeNotebook.partitionFilters?.[partition.key] ?? null,
      };
    });
  const timeMappedPartitionKeys = new Set(
    activeNotebook.timeConfig.pathMappings
      .filter((mapping) => mapping.component !== "none")
      .map((mapping) => mapping.partitionKey),
  );
  const editablePartitions = allEditablePartitions.filter(
    (partition) => !timeMappedPartitionKeys.has(partition.key),
  );
  const currentSearchState =
    searchStateByNotebook[activeNotebook.id] ?? createEmptySearchState();
  const currentCacheInvalidateState =
    cacheInvalidateByNotebook[activeNotebook.id] ?? {
      loading: false,
      message: null,
      error: null,
    };
  const currentTimePreview =
    timePreviewByNotebook[activeNotebook.id] ?? {
      loading: false,
      coarseRange: null,
      extractedText: null,
      lineTimestamp: null,
      errors: [],
    };
  function getPartitionPicker(key: string): PartitionValuePickerState {
    return (
      partitionPickerState[key] ?? {
        open: false,
        search: "",
        page: 1,
        totalPages: 1,
        totalItems: 0,
        values: [],
        loading: false,
        error: null,
      }
    );
  }
  const canRunSearch =
    activeNotebook.query.trim().length > 0 &&
    activeNotebook.awsProfile.trim().length > 0 &&
    activeNotebook.bucket.trim().length > 0 &&
    currentSearchState.status !== "running" &&
    currentSearchState.status !== "cancelling";
  const canCancelSearch =
    currentSearchState.jobId !== null &&
    (currentSearchState.status === "queued" ||
      currentSearchState.status === "running" ||
      currentSearchState.status === "cancelling");
  const hasPreviousResultsPage = currentSearchState.page > 1;
  const hasBufferedNextResultsPage =
    currentSearchState.page * currentSearchState.pageSize <
    currentSearchState.totalResults;
  const canAskForMoreResults =
    currentSearchState.jobId !== null &&
    !currentSearchState.loadingPage &&
    (currentSearchState.status === "paused" ||
      currentSearchState.status === "running" ||
      currentSearchState.status === "queued");
  const canLoadNextResultsPage =
    currentSearchState.jobId !== null &&
    !currentSearchState.loadingPage &&
    (hasBufferedNextResultsPage || canAskForMoreResults);
  const canInvalidateCache =
    activeNotebook.bucket.trim().length > 0 &&
    currentSearchState.status !== "queued" &&
    currentSearchState.status !== "running" &&
    currentSearchState.status !== "cancelling" &&
    !currentCacheInvalidateState.loading;

  function clearPartitionFilter(key: string) {
    setNotebooks((currentNotebooks) =>
      currentNotebooks.map((notebook) => {
        if (notebook.id !== activeNotebookId) {
          return notebook;
        }

        const nextFilters = clonePrefixFilters(notebook.partitionFilters ?? {});
        delete nextFilters[key];

        return {
          ...notebook,
          partitionFilters: nextFilters,
          updatedAt: "Just now",
        };
      }),
    );
  }

  function selectSinglePartitionFilterValue(key: string, value: string) {
    setNotebooks((currentNotebooks) =>
      currentNotebooks.map((notebook) => {
        if (notebook.id !== activeNotebookId) {
          return notebook;
        }

        const nextFilters = clonePrefixFilters(notebook.partitionFilters ?? {});

        if (!value) {
          delete nextFilters[key];
        } else {
          nextFilters[key] = {
            mode: "values",
            values: [value],
          };
        }

        return {
          ...notebook,
          partitionFilters: nextFilters,
          updatedAt: "Just now",
        };
      }),
    );
  }

  function toggleCategoryPartitionFilterValue(key: string, value: string) {
    setNotebooks((currentNotebooks) =>
      currentNotebooks.map((notebook) => {
        if (notebook.id !== activeNotebookId) {
          return notebook;
        }

        const nextFilters = clonePrefixFilters(notebook.partitionFilters ?? {});
        const currentValues =
          nextFilters[key]?.mode === "values" ? nextFilters[key].values : [];
        const hasValue = currentValues.includes(value);
        const nextValues = hasValue
          ? currentValues.filter((entry: string) => entry !== value)
          : [...currentValues, value];

        if (nextValues.length === 0) {
          delete nextFilters[key];
        } else {
          nextFilters[key] = {
            mode: "values",
            values: nextValues,
          };
        }

        return {
          ...notebook,
          partitionFilters: nextFilters,
          updatedAt: "Just now",
        };
      }),
    );
  }

  function setRangePartitionFilterBounds(
    key: string,
    patch: Partial<{ start: string; end: string }>,
  ) {
    setNotebooks((currentNotebooks) =>
      currentNotebooks.map((notebook) => {
        if (notebook.id !== activeNotebookId) {
          return notebook;
        }

        const nextFilters = clonePrefixFilters(notebook.partitionFilters ?? {});
        const currentFilter = nextFilters[key];
        const nextFilter: PrefixFilterSelection = {
          mode: "range",
          start:
            patch.start ??
            (currentFilter?.mode === "range" ? currentFilter.start : ""),
          end:
            patch.end ??
            (currentFilter?.mode === "range" ? currentFilter.end : ""),
        };

        nextFilters[key] = nextFilter;

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
        const nextOverride = {
          ...currentOverride,
          ...patch,
        };
        const nextFilters = clonePrefixFilters(notebook.partitionFilters ?? {});
        const currentFilter = nextFilters[key];

        if (nextOverride.kind === "range" && currentFilter?.mode === "values") {
          nextFilters[key] = {
            mode: "values",
            values: currentFilter.values.slice(0, 1),
          };
        }

        if (nextOverride.kind === "category" && currentFilter?.mode === "range") {
          delete nextFilters[key];
        }

        return {
          ...notebook,
          partitionOverrides: {
            ...notebook.partitionOverrides,
            [key]: {
              ...nextOverride,
            },
          },
          partitionFilters: nextFilters,
          updatedAt: "Just now",
        };
      }),
    );
  }

  function togglePartitionPicker(key: string) {
    setPartitionPickerState((current) => {
      const nextState: Record<string, PartitionValuePickerState> = {};

      for (const [entryKey, state] of Object.entries(current)) {
        nextState[entryKey] = {
          ...state,
          open: entryKey === key ? !state.open : false,
        };
      }

      if (!nextState[key]) {
        nextState[key] = {
          open: true,
          search: "",
          page: 1,
          totalPages: 1,
          totalItems: 0,
          values: [],
          loading: false,
          error: null,
        };
      }

      return nextState;
    });
  }

  function updateTimeMapping(partitionKey: string, patch: { component?: TimeComponent; format?: string }) {
    setNotebooks((currentNotebooks) =>
      currentNotebooks.map((notebook) => {
        if (notebook.id !== activeNotebookId) {
          return notebook;
        }

        const currentMappings = notebook.timeConfig.pathMappings ?? [];
        const existing = currentMappings.find((mapping) => mapping.partitionKey === partitionKey);
        const nextMapping = {
          partitionKey,
          component: patch.component ?? existing?.component ?? "none",
          format: patch.format ?? existing?.format,
        };

        const filtered = currentMappings.filter((mapping) => mapping.partitionKey !== partitionKey);
        const nextMappings =
          nextMapping.component === "none" && !nextMapping.format
            ? filtered
            : [...filtered, nextMapping];
        const nextFilters = clonePrefixFilters(notebook.partitionFilters ?? {});

        if (nextMapping.component !== "none") {
          delete nextFilters[partitionKey];
        }

        return {
          ...notebook,
          timeConfig: {
            ...notebook.timeConfig,
            pathMappings: nextMappings,
          },
          partitionFilters: nextFilters,
          updatedAt: "Just now",
        };
      }),
    );
  }

  function updateLineParser(nextParser: LineTimestampParser) {
    setNotebooks((currentNotebooks) =>
      currentNotebooks.map((notebook) =>
        notebook.id === activeNotebookId
          ? {
              ...notebook,
              timeConfig: {
                ...notebook.timeConfig,
                lineParser: nextParser,
              },
              updatedAt: "Just now",
            }
          : notebook,
      ),
    );
  }

  async function previewTimeConfig() {
    const partitionValues = Object.fromEntries(
      activeNotebook.timeConfig.pathMappings
        .filter((mapping) => mapping.component !== "none")
        .map((mapping) => {
          const partition = allEditablePartitions.find(
            (entry) => entry.key === mapping.partitionKey,
          );
          const filter = activeNotebook.partitionFilters[mapping.partitionKey];
          let value = partition?.values[0] ?? "";

          if (filter?.mode === "values") {
            value = filter.values[0] ?? "";
          } else if (filter?.mode === "range") {
            value = filter.start;
          }

          return [mapping.partitionKey, value];
        }),
    );

    setTimePreviewState(activeNotebook.id, (current) => ({
      ...current,
      loading: true,
      errors: [],
    }));

    const response = await fetch("/api/time/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timezone: activeNotebook.timeConfig.timezone,
        pathMappings: activeNotebook.timeConfig.pathMappings,
        partitionValues,
        lineParser: activeNotebook.timeConfig.lineParser,
        sampleLine: activeNotebook.timeSampleLine,
      }),
    });

    const payload = (await response.json()) as {
      coarseRange?: {
        start: string;
        end: string;
      } | null;
      extractedText?: string | null;
      lineTimestamp?: string | null;
      errors?: string[];
      error?: string;
    };

    setTimePreviewState(activeNotebook.id, {
      loading: false,
      coarseRange: payload.coarseRange ?? null,
      extractedText: payload.extractedText ?? null,
      lineTimestamp: payload.lineTimestamp ?? null,
      errors: payload.errors ?? (payload.error ? [payload.error] : []),
    });
  }

  const pathMappingsByKey = Object.fromEntries(
    activeNotebook.timeConfig.pathMappings.map((mapping) => [
      mapping.partitionKey,
      mapping,
    ]),
  );
  const lineParser = activeNotebook.timeConfig.lineParser;

  function getPartitionSelectionLabel(partition: (typeof editablePartitions)[number]) {
    if (!partition.selectedFilter) {
      return "All";
    }

    if (partition.selectedFilter.mode === "range") {
      const { start, end } = partition.selectedFilter;

      if (start && end) {
        return `${start} -> ${end}`;
      }

      if (start) {
        return `>= ${start}`;
      }

      if (end) {
        return `<= ${end}`;
      }

      return "Range";
    }

    if (partition.selectedFilter.values.length === 0) {
      return "All";
    }

    if (partition.selectedFilter.values.length === 1) {
      return partition.selectedFilter.values[0] ?? "All";
    }

    return `${partition.selectedFilter.values.length} selected`;
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
                        <div
                          className="picker partition-value-picker"
                          ref={(node) => {
                            partitionPickerRefs.current[partition.key] = node;
                          }}
                        >
                          <button
                            id={`partition-${partition.key}`}
                            className="picker-trigger"
                            type="button"
                            disabled={partition.hidden}
                            onClick={() => togglePartitionPicker(partition.key)}
                          >
                            <span>{getPartitionSelectionLabel(partition)}</span>
                            <span className="picker-chevron">▾</span>
                          </button>
                          {getPartitionPicker(partition.key).open ? (
                            <div className="picker-menu">
                              <div className="partition-picker-meta">
                                <span className="field-state">Filter type</span>
                                <div className="partition-type-toggle">
                                  <button
                                    type="button"
                                    className={`partition-type-button${
                                      partition.kind === "category" ? " is-active" : ""
                                    }`}
                                    onClick={() =>
                                      updatePartitionOverride(partition.key, {
                                        kind: "category",
                                      })
                                    }
                                  >
                                    Category
                                  </button>
                                  <button
                                    type="button"
                                    className={`partition-type-button${
                                      partition.kind === "range" ? " is-active" : ""
                                    }`}
                                    onClick={() =>
                                      updatePartitionOverride(partition.key, {
                                        kind: "range",
                                      })
                                    }
                                    >
                                      Range
                                    </button>
                                  </div>
                                  {partition.kind === "range" ? (
                                    <>
                                      <span className="field-state">Filter mode</span>
                                      <div className="partition-type-toggle">
                                        <button
                                          type="button"
                                          className={`partition-type-button${
                                            partition.selectedFilter?.mode !== "range"
                                              ? " is-active"
                                              : ""
                                          }`}
                                          onClick={() => clearPartitionFilter(partition.key)}
                                        >
                                          Values
                                        </button>
                                        <button
                                          type="button"
                                          className={`partition-type-button${
                                            partition.selectedFilter?.mode === "range"
                                              ? " is-active"
                                              : ""
                                          }`}
                                          onClick={() =>
                                            setRangePartitionFilterBounds(partition.key, {
                                              start:
                                                partition.selectedFilter?.mode === "range"
                                                  ? partition.selectedFilter.start
                                                  : "",
                                              end:
                                                partition.selectedFilter?.mode === "range"
                                                  ? partition.selectedFilter.end
                                                  : "",
                                            })
                                          }
                                        >
                                          Range
                                        </button>
                                      </div>
                                    </>
                                  ) : null}
                              </div>
                              {partition.kind === "range" &&
                              partition.selectedFilter?.mode === "range" ? (
                                <div className="partition-range-editor">
                                  <div className="field">
                                    <label htmlFor={`partition-${partition.key}-start`}>
                                      Start
                                    </label>
                                    <input
                                      id={`partition-${partition.key}-start`}
                                      value={partition.selectedFilter.start}
                                      placeholder="Optional"
                                      onChange={(event) =>
                                        setRangePartitionFilterBounds(partition.key, {
                                          start: event.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                  <div className="field">
                                    <label htmlFor={`partition-${partition.key}-end`}>
                                      End
                                    </label>
                                    <input
                                      id={`partition-${partition.key}-end`}
                                      value={partition.selectedFilter.end}
                                      placeholder="Optional"
                                      onChange={(event) =>
                                        setRangePartitionFilterBounds(partition.key, {
                                          end: event.target.value,
                                        })
                                      }
                                    />
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div className="picker-toolbar">
                                    <input
                                      value={getPartitionPicker(partition.key).search}
                                      placeholder={`Search ${partition.label}`}
                                      onChange={(event) =>
                                        setPartitionPickerEntry(partition.key, (current) => ({
                                          ...current,
                                          search: event.target.value,
                                          page: 1,
                                        }))
                                      }
                                    />
                                  </div>
                                  <div className="picker-list">
                                    <button
                                      type="button"
                                      className={`picker-option${
                                        partition.selectedFilter?.mode !== "values" ||
                                        partition.selectedFilter.values.length === 0
                                          ? " is-selected"
                                          : ""
                                      }`}
                                      onClick={() => {
                                        clearPartitionFilter(partition.key);
                                      }}
                                    >
                                      All
                                    </button>
                                    {getPartitionPicker(partition.key).values.map((value) => (
                                      <button
                                        key={value}
                                        type="button"
                                        className={`picker-option picker-option-selectable${
                                          partition.selectedFilter?.mode === "values" &&
                                          partition.selectedFilter.values.includes(value)
                                            ? " is-selected"
                                            : ""
                                        }`}
                                        onClick={() => {
                                          if (partition.kind === "category" || partition.kind === "range") {
                                            toggleCategoryPartitionFilterValue(
                                              partition.key,
                                              value,
                                            );

                                            if (partition.kind === "range") {
                                              return;
                                            }

                                            return;
                                          }

                                          selectSinglePartitionFilterValue(
                                            partition.key,
                                            value,
                                          );
                                          setPartitionPickerEntry(partition.key, (current) => ({
                                            ...current,
                                            open: false,
                                          }));
                                        }}
                                      >
                                        <span>{value}</span>
                                        <span className="picker-option-mark">
                                          {partition.selectedFilter?.mode === "values" &&
                                          partition.selectedFilter.values.includes(value)
                                            ? "Selected"
                                            : ""}
                                        </span>
                                      </button>
                                    ))}
                                    {getPartitionPicker(partition.key).values.length === 0 &&
                                    !getPartitionPicker(partition.key).loading ? (
                                      <div className="picker-empty">No values found</div>
                                    ) : null}
                                  </div>
                                </>
                              )}
                              <div className="picker-footer">
                                <span className="field-state">
                                  {partition.kind === "range" &&
                                  partition.selectedFilter?.mode === "range"
                                    ? "Bounds are inclusive"
                                    : getPartitionPicker(partition.key).loading
                                    ? "Loading values..."
                                    : `${getPartitionPicker(partition.key).totalItems} values · page ${getPartitionPicker(partition.key).page} of ${getPartitionPicker(partition.key).totalPages}`}
                                </span>
                                <div className="pager-row">
                                  {partition.kind === "category" ||
                                  (partition.kind === "range" &&
                                    partition.selectedFilter?.mode !== "range") ? (
                                    <button
                                      className="secondary-button"
                                      type="button"
                                      onClick={() =>
                                        setPartitionPickerEntry(partition.key, (current) => ({
                                          ...current,
                                          open: false,
                                        }))
                                      }
                                    >
                                      Done
                                    </button>
                                  ) : null}
                                  <button
                                    className="secondary-button"
                                    type="button"
                                    disabled={
                                      (partition.kind === "range" &&
                                        partition.selectedFilter?.mode === "range") ||
                                      getPartitionPicker(partition.key).page <= 1 ||
                                      getPartitionPicker(partition.key).loading
                                    }
                                    onClick={() =>
                                      setPartitionPickerEntry(partition.key, (current) => ({
                                        ...current,
                                        page: Math.max(1, current.page - 1),
                                      }))
                                    }
                                  >
                                    Prev
                                  </button>
                                  <button
                                    className="secondary-button"
                                    type="button"
                                    disabled={
                                      (partition.kind === "range" &&
                                        partition.selectedFilter?.mode === "range") ||
                                      getPartitionPicker(partition.key).page >=
                                        getPartitionPicker(partition.key).totalPages ||
                                      getPartitionPicker(partition.key).loading
                                    }
                                    onClick={() =>
                                      setPartitionPickerEntry(partition.key, (current) => ({
                                        ...current,
                                        page: Math.min(current.totalPages, current.page + 1),
                                      }))
                                    }
                                  >
                                    Next
                                  </button>
                                </div>
                              </div>
                              {getPartitionPicker(partition.key).error ? (
                                <p className="field-error picker-error">
                                  {getPartitionPicker(partition.key).error}
                                </p>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
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
          <div className="time-config-section">
            <div className="partition-header">
              <div>
                <label>Time config</label>
                <p className="field-state">
                  Map partition keys to time components and preview line timestamp parsing.
                </p>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={previewTimeConfig}
                disabled={currentTimePreview.loading}
              >
                {currentTimePreview.loading ? "Previewing..." : "Preview time config"}
              </button>
            </div>
            {allEditablePartitions.length > 0 ? (
              <div className="time-mapping-list">
                {allEditablePartitions.map((partition) => {
                  const mapping = pathMappingsByKey[partition.key];

                  return (
                    <div key={partition.key} className="time-mapping-row">
                      <span className="time-mapping-key">{partition.label}</span>
                      <select
                        className="control"
                        value={mapping?.component ?? "none"}
                        onChange={(event) =>
                          updateTimeMapping(partition.key, {
                            component: event.target.value as TimeComponent,
                          })
                        }
                      >
                        <option value="none">None</option>
                        <option value="year">Year</option>
                        <option value="month">Month</option>
                        <option value="day">Day</option>
                        <option value="hour">Hour</option>
                        <option value="minute">Minute</option>
                        <option value="second">Second</option>
                        <option value="date">Date</option>
                        <option value="datetime">Datetime</option>
                      </select>
                      <input
                        value={mapping?.format ?? ""}
                        placeholder="Format, e.g. YYYYMM"
                        onChange={(event) =>
                          updateTimeMapping(partition.key, {
                            format: event.target.value || undefined,
                          })
                        }
                      />
                    </div>
                  );
                })}
              </div>
            ) : null}
            <div className="time-parser-grid">
              <div className="field">
                <label htmlFor="time-timezone">Timezone</label>
                <input
                  id="time-timezone"
                  value={activeNotebook.timeConfig.timezone}
                  onChange={(event) =>
                    updateActiveNotebook("timeConfig", {
                      ...activeNotebook.timeConfig,
                      timezone: event.target.value,
                    })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="line-parser-mode">Line parser</label>
                <select
                  id="line-parser-mode"
                  className="control"
                  value={lineParser.mode}
                  onChange={(event) => {
                    const mode = event.target.value as LineTimestampParser["mode"];
                    if (mode === "none" || mode === "auto") {
                      updateLineParser({ mode });
                      return;
                    }
                    updateLineParser({
                      mode: "regex",
                      pattern: "",
                      group: 1,
                    });
                  }}
                >
                  <option value="none">Ignore line timestamps</option>
                  <option value="auto">Auto</option>
                  <option value="regex">Regex</option>
                </select>
              </div>
              {lineParser.mode === "regex" ? (
                <>
                  <div className="field">
                    <label htmlFor="line-parser-pattern">Regex pattern</label>
                    <input
                      id="line-parser-pattern"
                      value={lineParser.pattern}
                      onChange={(event) =>
                        updateLineParser({
                          ...lineParser,
                          pattern: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="line-parser-group">Capture group</label>
                    <input
                      id="line-parser-group"
                      type="number"
                      min={1}
                      value={lineParser.group}
                      onChange={(event) =>
                        updateLineParser({
                          ...lineParser,
                          group: Math.max(1, Number(event.target.value) || 1),
                        })
                      }
                    />
                  </div>
                  <div className="field parser-format-field">
                    <label htmlFor="line-parser-format">Timestamp format</label>
                    <input
                      id="line-parser-format"
                      value={lineParser.format ?? ""}
                      placeholder="Optional. Example: YYYY-MM-DD HH:mm:ss"
                      onChange={(event) =>
                        updateLineParser({
                          ...lineParser,
                          format: event.target.value || undefined,
                        })
                      }
                    />
                  </div>
                </>
              ) : null}
              <div className="field parser-sample-field">
                <label htmlFor="time-sample-line">Sample line</label>
                <input
                  id="time-sample-line"
                  value={activeNotebook.timeSampleLine}
                  placeholder="Paste a sample log line"
                  onChange={(event) =>
                    updateActiveNotebook("timeSampleLine", event.target.value)
                  }
                />
              </div>
            </div>
            <div className="time-preview-panel">
              <div className="time-preview-row">
                <span className="field-state">Coarse range</span>
                <strong>
                  {currentTimePreview.coarseRange
                    ? `${currentTimePreview.coarseRange.start} -> ${currentTimePreview.coarseRange.end}`
                    : "No coarse range"}
                </strong>
              </div>
              <div className="time-preview-row">
                <span className="field-state">Extracted text</span>
                <strong>{currentTimePreview.extractedText ?? "None"}</strong>
              </div>
              <div className="time-preview-row">
                <span className="field-state">Parsed line timestamp</span>
                <strong>{currentTimePreview.lineTimestamp ?? "None"}</strong>
              </div>
              {currentTimePreview.errors.length > 0 ? (
                <div className="time-preview-errors">
                  {currentTimePreview.errors.map((error) => (
                    <p key={error} className="field-error">
                      {error}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className="search-section">
            <div className="search-section-header">
              <div>
                <label htmlFor="search-pattern">Search</label>
                <p className="field-state">
                  {activeNotebook.queryMode === "substring"
                    ? "Exact substring match over objects under the selected root."
                    : "All tokens must appear in a line, in any order."}
                </p>
              </div>
              <div className="search-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!canRunSearch}
                  onClick={runSearch}
                >
                  Run search
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!canCancelSearch}
                  onClick={cancelSearch}
                >
                  Cancel
                </button>
              </div>
            </div>
            <div className="field search-pattern-field">
              <div className="search-query-row">
                <select
                  className="control search-mode-select"
                  aria-label="Search mode"
                  value={activeNotebook.queryMode}
                  onChange={(event) =>
                    updateActiveNotebook("queryMode", event.target.value as QueryMode)
                  }
                >
                  <option value="substring">Substring</option>
                  <option value="all_tokens">All tokens</option>
                </select>
                <input
                  id="search-pattern"
                  value={activeNotebook.query}
                  placeholder={
                    activeNotebook.queryMode === "substring"
                      ? "Search for an exact substring"
                      : "Enter tokens separated by spaces"
                  }
                  onChange={(event) =>
                    updateActiveNotebook("query", event.target.value)
                  }
                />
              </div>
            </div>
            <div className="search-time-grid">
              <div className="field">
                <label htmlFor="search-start-time">Start time</label>
                <input
                  id="search-start-time"
                  type="datetime-local"
                  value={activeNotebook.startTime}
                  onChange={(event) =>
                    updateActiveNotebook("startTime", event.target.value)
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="search-end-time">End time</label>
                <input
                  id="search-end-time"
                  type="datetime-local"
                  value={activeNotebook.endTime}
                  onChange={(event) =>
                    updateActiveNotebook("endTime", event.target.value)
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="search-page-size">Page size</label>
                <select
                  id="search-page-size"
                  className="control"
                  value={activeNotebook.pageSize}
                  onChange={(event) =>
                    updateActiveNotebook("pageSize", Number(event.target.value))
                  }
                >
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={250}>250</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="search-context-lines">Context lines</label>
                <select
                  id="search-context-lines"
                  className="control"
                  value={activeNotebook.contextLineCount}
                  onChange={(event) =>
                    updateActiveNotebook(
                      "contextLineCount",
                      Number(event.target.value),
                    )
                  }
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
            </div>
            <label className="search-option-toggle">
              <input
                type="checkbox"
                checked={activeNotebook.searchOptions.caseSensitive}
                onChange={(event) =>
                  updateActiveNotebook("searchOptions", {
                    ...activeNotebook.searchOptions,
                    caseSensitive: event.target.checked,
                  })
                }
              />
              <span>Case-sensitive</span>
            </label>
            <div className="search-summary">
              <span className={`search-status status-${currentSearchState.status}`}>
                {searchStatusLabel(currentSearchState.status)}
              </span>
              <span>{currentSearchState.progress.matchesFound} matches</span>
              <span>{currentSearchState.progress.objectsScanned} objects</span>
              <span>{currentSearchState.progress.bytesScanned} bytes scanned</span>
              <span>
                page {currentSearchState.page} · {currentSearchState.totalResults} buffered
              </span>
              <span>
                cache {currentSearchState.cache.hits} hit / {currentSearchState.cache.misses} miss
              </span>
              <span>
                {currentSearchState.cache.writes} writes / {currentSearchState.cache.evictions} evictions
              </span>
              <span>
                {currentSearchState.connected ? "Live stream connected" : "Stream idle"}
              </span>
              <button
                type="button"
                className="secondary-button search-cache-action"
                onClick={invalidateCache}
                disabled={!canInvalidateCache}
              >
                {currentCacheInvalidateState.loading
                  ? "Invalidating cache..."
                  : "Invalidate cache"}
              </button>
            </div>
            {currentSearchState.errorMessage ? (
              <p className="field-error">{currentSearchState.errorMessage}</p>
            ) : null}
            {currentCacheInvalidateState.error ? (
              <p className="field-error">{currentCacheInvalidateState.error}</p>
            ) : null}
            {currentCacheInvalidateState.message ? (
              <p className="field-state cache-invalidate-message">
                {currentCacheInvalidateState.message}
              </p>
            ) : null}
            {currentSearchState.cache.recentEvents.length > 0 ? (
              <div className="search-cache-activity">
                {currentSearchState.cache.recentEvents.map((event, index) => (
                  <div
                    key={`${event.type}:${event.objectKey}:${event.chunkId ?? "object"}:${index}`}
                    className="cache-event-row"
                  >
                    <span
                      className={`cache-event-badge cache-event-${event.type.replace(".", "-")}`}
                    >
                      {event.type.replace("cache.", "")}
                    </span>
                    <div className="cache-event-body">
                      <span className="cache-event-key">{event.objectKey}</span>
                      <span className="cache-event-meta">
                        {event.chunkId ? `chunk ${event.chunkId}` : "object scope"}
                        {event.detail ? ` · ${event.detail}` : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="search-results">
              <div className="pager-row search-results-pager">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={loadPreviousResultsPage}
                  disabled={!hasPreviousResultsPage || currentSearchState.loadingPage}
                >
                  Prev page
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={loadNextResultsPage}
                  disabled={!canLoadNextResultsPage}
                >
                  {currentSearchState.loadingPage
                    ? "Loading..."
                    : hasBufferedNextResultsPage
                      ? "Next page"
                      : "Scan more"}
                </button>
              </div>
              {currentSearchState.results.length === 0 ? (
                <div className="search-results-empty">
                  {currentSearchState.status === "idle"
                    ? "Run a search to see live results."
                    : currentSearchState.loadingPage
                      ? "Loading buffered results..."
                    : "No matches yet."}
                </div>
              ) : (
                currentSearchState.results.map((result, index) => {
                  const contextKey = getResultContextKey(result);
                  const contextState =
                    currentSearchState.contextByResultKey[contextKey];

                  return (
                    <div
                      key={`${result.objectKey}:${result.lineNumber}:${index}`}
                      className="search-result-row"
                    >
                      <div className="search-result-meta">
                        <span>{result.objectKey}</span>
                        <span>line {result.lineNumber}</span>
                        {result.timestampText ? <span>{result.timestampText}</span> : null}
                        <button
                          type="button"
                          className="secondary-button search-result-context-button"
                          onClick={() => toggleResultContext(result)}
                        >
                          {contextState?.loading
                            ? "Loading context..."
                            : contextState?.open
                              ? "Hide context"
                              : "Show context"}
                        </button>
                      </div>
                      <code className="search-result-line">{result.lineText}</code>
                      {contextState?.open ? (
                        <div className="search-result-context">
                          {contextState.source ? (
                            <div className="search-result-context-meta">
                              Context source: {contextState.source}
                            </div>
                          ) : null}
                          {contextState.error ? (
                            <p className="field-error">{contextState.error}</p>
                          ) : null}
                          {contextState.lines.map((line, lineIndex) => (
                            <div key={`${contextKey}:${line.objectKey}:${line.lineNumber}`}>
                              {lineIndex === 0 ||
                              contextState.lines[lineIndex - 1]?.objectKey !==
                                line.objectKey ? (
                                <div className="search-context-object-boundary">
                                  {line.objectKey}
                                </div>
                              ) : null}
                              <div
                                className={`search-context-line${
                                  line.isMatch ? " is-match" : ""
                                }`}
                              >
                                <span className="search-context-line-number">
                                  {line.lineNumber}
                                </span>
                                <code className="search-context-line-text">
                                  {line.lineText}
                                </code>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
