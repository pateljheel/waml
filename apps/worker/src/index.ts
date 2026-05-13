import {
  ensureRuntimeDirectories,
  getCacheDirectoryPath,
  getDatabaseFilePath,
  initializeDatabase,
  listJobs,
} from "@waml/db";

async function main() {
  ensureRuntimeDirectories();
  initializeDatabase();

  const startupDetails = {
    db: getDatabaseFilePath(),
    cacheDir: getCacheDirectoryPath(),
    mode: "worker",
  };

  console.log("[waml-worker] started", startupDetails);
  console.log("[waml-worker] next step: implement SQLite job claiming loop");

  const jobs = listJobs();

  console.log("[waml-worker] jobs present", jobs.length);

  process.stdin.resume();
}

main().catch((error) => {
  console.error("[waml-worker] fatal", error);
  process.exitCode = 1;
});
