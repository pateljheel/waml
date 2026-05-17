import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getJob, listCacheChunksForObject } from "@waml/db";
import type { StorageProvider } from "@waml/shared";
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { createGunzip, gunzipSync } from "node:zlib";
import { createS3Client } from "../../../../../lib/aws";
import { createGcsStorageClient } from "../../../../../lib/storage/gcs";

type ContextLine = {
  objectKey: string;
  lineNumber: number;
  lineText: string;
  isMatch: boolean;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function normalizeChunkLines(text: string) {
  const lines = text.split(/\r?\n/);

  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

async function readCachedTextArtifact(filepath: string) {
  const compressed = await fs.readFile(filepath);

  if (compressed.length >= 2 && compressed[0] === 0x1f && compressed[1] === 0x8b) {
    return gunzipSync(compressed).toString("utf8");
  }

  return compressed.toString("utf8");
}

async function loadContextFromCache({
  provider,
  bucket,
  objectKey,
  versionToken,
  lineNumber,
  before,
  after,
}: {
  provider: StorageProvider;
  bucket: string;
  objectKey: string;
  versionToken: string;
  lineNumber: number;
  before: number;
  after: number;
}) {
  if (!versionToken) {
    return null;
  }

  const chunks = listCacheChunksForObject(provider, bucket, objectKey, versionToken).filter(
    (chunk) => chunk.textCachePath,
  );

  if (chunks.length === 0) {
    return null;
  }

  const startLine = Math.max(1, lineNumber - before);
  const endLine = lineNumber + after;
  const canUseLineRanges = chunks.every(
    (chunk) =>
      chunk.textCachePath &&
      chunk.startLineNumber !== null &&
      chunk.endLineNumber !== null,
  );

  if (canUseLineRanges) {
    const collected: ContextLine[] = [];

    for (const chunk of chunks) {
      if (!chunk.textCachePath) {
        return null;
      }

      if (
        chunk.endLineNumber! < startLine ||
        chunk.startLineNumber! > endLine
      ) {
        continue;
      }

      const text = await readCachedTextArtifact(chunk.textCachePath);
      const lines = normalizeChunkLines(text);
      const localStartIndex = Math.max(0, startLine - chunk.startLineNumber!);
      const localEndIndex = Math.min(
        lines.length - 1,
        endLine - chunk.startLineNumber!,
      );

      for (
        let localIndex = localStartIndex;
        localIndex <= localEndIndex;
        localIndex += 1
      ) {
        const absoluteLineNumber = chunk.startLineNumber! + localIndex;
        collected.push({
          objectKey,
          lineNumber: absoluteLineNumber,
          lineText: lines[localIndex] ?? "",
          isMatch: absoluteLineNumber === lineNumber,
        });
      }
    }

    return collected.length > 0 ? collected : null;
  }

  const collected: ContextLine[] = [];
  let currentLineNumber = 0;

  for (const chunk of chunks) {
    if (!chunk.textCachePath) {
      return null;
    }

    const text = await readCachedTextArtifact(chunk.textCachePath);
    const lines = normalizeChunkLines(text);

    for (const lineText of lines) {
      currentLineNumber += 1;

      if (currentLineNumber < startLine) {
        continue;
      }

      if (currentLineNumber > endLine) {
        return collected;
      }

      collected.push({
        objectKey,
        lineNumber: currentLineNumber,
        lineText,
        isMatch: currentLineNumber === lineNumber,
      });
    }
  }

  return collected.length > 0 ? collected : null;
}

async function loadContextFromObjectStore({
  provider,
  awsProfile,
  gcpProject,
  authMode,
  serviceAccountKeyPath,
  bucket,
  objectKey,
  lineNumber,
  before,
  after,
}: {
  provider: StorageProvider;
  awsProfile: string;
  gcpProject: string;
  authMode: "adc" | "service_account";
  serviceAccountKeyPath: string;
  bucket: string;
  objectKey: string;
  lineNumber: number;
  before: number;
  after: number;
}) {
  let sourceStream: Readable | undefined;

  if (provider === "s3") {
    const client = await createS3Client(awsProfile);
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey,
      }),
    );
    const body = response.Body as
      | AsyncIterable<Uint8Array | Buffer | string>
      | undefined;
    sourceStream =
      body && typeof (body as NodeJS.ReadableStream).pipe === "function"
        ? (body as Readable)
        : body
          ? Readable.from(body)
          : undefined;
  } else {
    const client = createGcsStorageClient({
      gcpProject,
      authMode,
      serviceAccountKeyPath,
    });
    sourceStream = client
      .bucket(bucket)
      .file(objectKey)
      .createReadStream() as Readable;
  }

  if (!sourceStream) {
    return [];
  }

  const decodedBody: Readable = objectKey.endsWith(".gz")
    ? sourceStream.pipe(createGunzip())
    : sourceStream;
  const decoder = new TextDecoder("utf-8");
  const startLine = Math.max(1, lineNumber - before);
  const endLine = lineNumber + after;
  const collected: ContextLine[] = [];
  let bufferedText = "";
  let currentLineNumber = 0;

  for await (const rawChunk of decodedBody) {
    const chunkBuffer =
      typeof rawChunk === "string" ? Buffer.from(rawChunk) : Buffer.from(rawChunk);
    bufferedText += decoder.decode(chunkBuffer, { stream: true });
    const lines = bufferedText.split(/\r?\n/);
    bufferedText = lines.pop() ?? "";

    for (const lineText of lines) {
      currentLineNumber += 1;

      if (currentLineNumber < startLine) {
        continue;
      }

      if (currentLineNumber > endLine) {
        return collected;
      }

      collected.push({
        objectKey,
        lineNumber: currentLineNumber,
        lineText,
        isMatch: currentLineNumber === lineNumber,
      });
    }
  }

  bufferedText += decoder.decode();

  if (bufferedText) {
    currentLineNumber += 1;

    if (currentLineNumber >= startLine && currentLineNumber <= endLine) {
      collected.push({
        objectKey,
        lineNumber: currentLineNumber,
        lineText: bufferedText,
        isMatch: currentLineNumber === lineNumber,
      });
    }
  }

  return collected;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const job = getJob(jobId);

  if (!job) {
    return NextResponse.json(
      { error: "Job not found" },
      { status: 404, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const searchParams = new URL(request.url).searchParams;
  const objectKey = searchParams.get("objectKey")?.trim() ?? "";
  const versionToken =
    searchParams.get("versionToken")?.trim() ??
    searchParams.get("etag")?.trim() ??
    "";
  const etag = searchParams.get("etag")?.trim() ?? "";
  const lineNumber = Number(searchParams.get("lineNumber") ?? "0");
  const before = Math.max(0, Number(searchParams.get("before") ?? "20") || 20);
  const after = Math.max(0, Number(searchParams.get("after") ?? "20") || 20);

  if (!objectKey || !Number.isInteger(lineNumber) || lineNumber <= 0) {
    return NextResponse.json(
      { error: "objectKey and a positive lineNumber are required" },
      { status: 400, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const cachedLines =
    (await loadContextFromCache({
      provider: job.source.provider,
      bucket: job.source.bucket,
      objectKey,
      versionToken,
      lineNumber,
      before,
      after,
    })) ?? [];
  const lines =
    cachedLines.length > 0
      ? cachedLines
      : await loadContextFromObjectStore({
          provider: job.source.provider,
          awsProfile: job.source.awsProfile,
          gcpProject: job.source.gcpProject,
          authMode: job.source.authMode,
          serviceAccountKeyPath: job.source.serviceAccountKeyPath,
          bucket: job.source.bucket,
          objectKey,
          lineNumber,
          before,
          after,
        });

  return NextResponse.json(
    {
      objectKey,
      versionToken: versionToken || null,
      etag: etag || null,
      lineNumber,
      before,
      after,
      lines,
      source: cachedLines.length > 0 ? "cache" : "s3",
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
