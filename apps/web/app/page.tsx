type Notebook = {
  id: string;
  title: string;
  status: "running" | "idle";
  query: string;
  range: string;
  updatedAt: string;
};

type Cell = {
  id: string;
  kind: "query" | "note" | "results";
  title: string;
  body: string;
};

const notebooks: Notebook[] = [
  {
    id: "checkout-errors",
    title: "Checkout errors",
    status: "running",
    query: 'timeout while awaiting headers service="checkout-api"',
    range: "Last 90 min",
    updatedAt: "2 min ago",
  },
  {
    id: "auth-refresh",
    title: "Auth refresh",
    status: "idle",
    query: 'token refresh failed service="auth-service"',
    range: "Today",
    updatedAt: "14 min ago",
  },
  {
    id: "queue-latency",
    title: "Queue latency",
    status: "idle",
    query: 'consumer lag service="worker-ingest"',
    range: "May 2026",
    updatedAt: "Yesterday",
  },
];

const activeNotebook = notebooks[0];

const cells: Cell[] = [
  {
    id: "query-1",
    kind: "query",
    title: "Search",
    body:
      'search mode=substring pattern="timeout while awaiting headers" range="-90m" filters.env="prod" filters.year_date="202605"',
  },
  {
    id: "note-1",
    kind: "note",
    title: "Note",
    body:
      "Errors start shortly after the 13:00 deploy and cluster around a single provider.",
  },
  {
    id: "results-1",
    kind: "results",
    title: "Results",
    body:
      "[13:12:09] request_id=af83 timeout while awaiting headers upstream=payments-v2\n[13:12:10] request_id=af83 retrying provider=adyen attempt=2\n[13:12:11] request_id=af83 circuit=half-open customer_visible=true",
  },
];

function statusLabel(status: Notebook["status"]) {
  return status === "running" ? "Running" : "Idle";
}

export default function HomePage() {
  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">WAML</p>
            <h1>Notebooks</h1>
          </div>
          <button className="primary-button" type="button">
            New
          </button>
        </div>

        <div className="notebook-list">
          {notebooks.map((notebook) => (
            <article
              key={notebook.id}
              className={`notebook-item${
                notebook.id === activeNotebook.id ? " is-active" : ""
              }`}
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
            </article>
          ))}
        </div>
      </aside>

      <section className="content">
        <header className="content-header">
          <div>
            <p className="eyebrow">Notebook</p>
            <h2>{activeNotebook.title}</h2>
          </div>
          <div className="header-actions">
            <button className="secondary-button" type="button">
              Duplicate
            </button>
            <button className="primary-button" type="button">
              Run all
            </button>
          </div>
        </header>

        <section className="search-bar">
          <div className="field">
            <label>Pattern</label>
            <input defaultValue="timeout while awaiting headers" />
          </div>
          <div className="field small">
            <label>Range</label>
            <input defaultValue="Last 90 minutes" />
          </div>
          <div className="field small">
            <label>Prefix</label>
            <input defaultValue="year_date=202605" />
          </div>
        </section>

        <section className="cells">
          {cells.map((cell) => (
            <article key={cell.id} className="cell">
              <div className="cell-header">
                <div>
                  <p className="cell-kind">{cell.kind}</p>
                  <h3>{cell.title}</h3>
                </div>
                <button className="secondary-button" type="button">
                  Run
                </button>
              </div>
              <pre>{cell.body}</pre>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}
