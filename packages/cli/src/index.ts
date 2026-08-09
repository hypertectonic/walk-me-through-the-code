#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

import {
  browserToAgentEventSchemaForArtifact,
  ConversationModeSchema,
  ContextualQuestionSchema,
  WalkthroughArtifactSchema,
  type WalkthroughArtifact,
} from "@walk-me-through-code/contracts";

import {
  AgentCommandInputError,
  agentCommandErrorCode,
  endLiveSession,
  executeAgentCommand,
} from "./agent-commands.js";
import { normalizeArtifactRepository } from "./repository-identity.js";
import { evaluateArtifactEvidence } from "./stale-evidence.js";
import {
  privateNetworkAddresses,
  routedPrivateIpv4Address,
  viewerRequestFailure,
} from "./private-network.js";
import { tailscaleIpv4Addresses } from "./tailscale.js";
import { prependViewerConnectionGuard } from "./viewer-connection.js";
import {
  executeSkillCommand,
  SkillInstallationError,
} from "./skill-installation.js";

import {
  compareProtocolTimestamps,
  SqliteSessionStore,
  SessionStoreConflictError,
  SessionStoreStateError,
  type JsonValue,
  type SessionStore,
} from "./session/index.js";

const VERSION = "0.1.1";
const SUPPORTED_SKILL_VERSIONS = ["0.1.1"] as const;
const LOOPBACK_HOST = "127.0.0.1";
const PRIVATE_NETWORK_HOST = "0.0.0.0";
const SESSION_COOKIE = "wmtc_session";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export interface WalkthroughServer {
  readonly server: Server;
  readonly origin: string;
  readonly origins: readonly string[];
  readonly sessionId: string;
  close(): Promise<void>;
}

export interface WalkthroughServerOptions {
  readonly evaluateEvidence?: typeof evaluateArtifactEvidence;
  readonly share?: "private";
  readonly sessionStore?: SessionStore;
}

interface OpenOptions {
  artifactPath: string;
  openBrowser: boolean;
  port: number;
  share?: "private";
}

interface AppliedWalkthroughUpdate {
  readonly changedIds: readonly string[];
  readonly currentRevision: number;
  readonly status: "applied";
  readonly updateId: string;
}

interface RejectedWalkthroughUpdate {
  readonly error: {
    readonly code: "INVALID_UPDATE" | "REVISION_MISMATCH";
    readonly currentRevision: number;
    readonly expectedRevision: number;
    readonly message: string;
    readonly recoverable: boolean;
  };
  readonly status: "rejected";
  readonly updateId: string;
}

type WalkthroughUpdateOutcome = AppliedWalkthroughUpdate | RejectedWalkthroughUpdate;

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  additionalHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    ...additionalHeaders,
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new SessionStoreConflictError("Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 65_536) throw new SessionStoreConflictError("Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SessionStoreConflictError("Request body must be valid JSON");
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionStoreConflictError("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function runtimeId(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString("hex")}`;
}

function issuePath(issue: { path: readonly PropertyKey[] }): string {
  if (issue.path.length === 0) return "$";
  return issue.path.reduce<string>((path, segment) =>
    typeof segment === "number" ? `${path}[${segment}]` : `${path}.${String(segment)}`,
  "$");
}

export async function loadArtifact(artifactPath: string): Promise<WalkthroughArtifact> {
  let source: string;
  try {
    source = await readFile(artifactPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read Walkthrough Artifact at ${artifactPath}: ${detail}`, { cause: error });
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Walkthrough Artifact is not valid JSON: ${detail}`, { cause: error });
  }

  const result = WalkthroughArtifactSchema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issuePath(issue)}: ${issue.message}`)
      .join("\n");
    throw new Error(`Walkthrough Artifact validation failed:\n${details}`);
  }
  return result.data;
}

function mimeType(path: string): string {
  switch (extname(path)) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function tokenMatches(candidate: string | undefined, activeTokens: Set<string>): boolean {
  if (candidate === undefined) return false;
  const candidateBuffer = Buffer.from(candidate);
  for (const token of activeTokens) {
    const tokenBuffer = Buffer.from(token);
    if (
      candidateBuffer.length === tokenBuffer.length &&
      timingSafeEqual(candidateBuffer, tokenBuffer)
    ) return true;
  }
  return false;
}

async function assetMap(viewerDirectory: string): Promise<Map<string, string>> {
  const assets = new Map<string, string>();

  async function collect(directory: string, urlPrefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const filePath = resolve(directory, entry.name);
      const urlPath = `${urlPrefix}/${entry.name}`;
      if (entry.isDirectory()) await collect(filePath, urlPath);
      else if (entry.isFile()) assets.set(urlPath, filePath);
    }));
  }

  await collect(viewerDirectory, "");
  return assets;
}

export async function startWalkthroughServer(
  artifactInput: WalkthroughArtifact,
  port = 0,
  viewerDirectory = fileURLToPath(new URL("../../viewer/dist/", import.meta.url)),
  options: WalkthroughServerOptions = {},
): Promise<WalkthroughServer> {
  const parsedArtifact = WalkthroughArtifactSchema.parse(artifactInput);
  const normalizedRepository = normalizeArtifactRepository(parsedArtifact);
  const identity = normalizedRepository.identity;
  const evaluateEvidence = options.evaluateEvidence ?? evaluateArtifactEvidence;
  let artifact = await evaluateEvidence(normalizedRepository.artifact);
  const assets = await assetMap(viewerDirectory);
  const indexPath = assets.get("/index.html");
  if (indexPath === undefined) {
    throw new Error(
      "Viewer assets are missing. Run `corepack npm run build` before opening a Walkthrough.",
    );
  }

  const activeTokens = new Set<string>();
  let sessionStore = options.sessionStore;
  let ownsSessionStore = false;
  let sessionId: string | undefined;
  const runtimeOwnerId = runtimeId("runtime");
  let ownsRuntime = false;
  let runtimeOwnershipLost = false;
  const sharedPrivately = options.share === "private";
  const tailscaleAddresses = sharedPrivately ? await tailscaleIpv4Addresses() : [];
  const routedLanAddress = sharedPrivately ? await routedPrivateIpv4Address() : undefined;
  const advertisedAddresses = sharedPrivately
    ? privateNetworkAddresses(networkInterfaces(), tailscaleAddresses, routedLanAddress)
    : [LOOPBACK_HOST];
  const allowedHosts = new Set<string>();
  const eventStreams = new Map<ServerResponse, NodeJS.Timeout>();
  const synchronizeWalkthroughState = (active: { id: string; store: SessionStore }): void => {
    const initialized = active.store.initializeWalkthroughState({
      sessionId: active.id,
      artifact: artifact as unknown as JsonValue,
      revision: artifact.revision,
      updatedAt: new Date().toISOString(),
    }).record;
    const restored = normalizeArtifactRepository(
      WalkthroughArtifactSchema.parse(initialized.artifact),
    ).artifact;
    const evidenceStates = new Map(artifact.sections.flatMap((section) =>
      section.type === "sourceExcerpt" && section.evidenceState !== undefined
        ? [[section.id, section.evidenceState] as const]
        : [],
    ));
    artifact = {
      ...restored,
      sections: restored.sections.map((section) => {
        const evidenceState = evidenceStates.get(section.id);
        return section.type === "sourceExcerpt" && evidenceState !== undefined
          ? { ...section, evidenceState }
          : section;
      }),
    };
  };

  const claimRuntime = (active: { id: string; store: SessionStore }): void => {
    if (runtimeOwnershipLost) {
      throw new SessionStoreStateError(
        `Live Session ${active.id} runtime ownership has expired`,
      );
    }
    if (ownsRuntime) {
      if (active.store.renewRuntimeOwnership(active.id, runtimeOwnerId)) return;
      ownsRuntime = false;
      runtimeOwnershipLost = true;
      throw new SessionStoreStateError(
        `Live Session ${active.id} runtime ownership has expired`,
      );
    }
    try {
      active.store.claimRuntimeOwnership(active.id, runtimeOwnerId);
      ownsRuntime = true;
    } catch (error) {
      runtimeOwnershipLost = true;
      throw error;
    }
  };

  const activeSession = (): { id: string; store: SessionStore } => {
    if (sessionStore === undefined) {
      sessionStore = new SqliteSessionStore({ projectRoot: identity.root });
      ownsSessionStore = true;
    }
    if (sessionId === undefined) {
      const timestamp = new Date().toISOString();
      const resumable = sessionStore.findResumableSession({
        repositoryKey: identity.key,
        ...(identity.scope === undefined ? {} : { repositoryScope: identity.scope }),
        walkthroughId: artifact.id,
        artifactRevision: artifact.revision,
      });
      if (resumable !== undefined) {
        sessionId = resumable.id;
        const active = { id: sessionId, store: sessionStore };
        claimRuntime(active);
        const latestEventAt = sessionStore.listEvents(sessionId).at(-1)?.occurredAt ?? resumable.updatedAt;
        const occurredAt = timestamp < latestEventAt ? latestEventAt : timestamp;
        if (resumable.state === "created") {
          sessionStore.transitionSession({
            sessionId,
            eventId: runtimeId("session-opened-after-recovery"),
            to: "viewer_open",
            occurredAt,
          });
        } else if (
          resumable.state === "interrupted" ||
          resumable.state === "agent_listening" ||
          resumable.state === "active"
        ) {
          if (resumable.state !== "interrupted") {
            sessionStore.transitionSession({
              sessionId,
              eventId: runtimeId("session-recovered-interruption"),
              to: "interrupted",
              occurredAt,
            });
          }
          sessionStore.transitionSession({
            sessionId,
            eventId: runtimeId("session-resumed"),
            to: "viewer_open",
            occurredAt,
          });
        }
        synchronizeWalkthroughState(active);
        return active;
      }
      const newSessionId = runtimeId("session");
      sessionStore.transaction((transaction) => {
        transaction.createSession({
          id: newSessionId,
          repositoryKey: identity.key,
          ...(identity.scope === undefined ? {} : { repositoryScope: identity.scope }),
          walkthroughId: artifact.id,
          artifactRevision: artifact.revision,
          conversationMode: "analyze",
          state: "created",
          createdAt: timestamp,
          updatedAt: timestamp,
          endedAt: null,
          lifecycleEventId: runtimeId("session-created"),
        });
        transaction.transitionSession({
          sessionId: newSessionId,
          eventId: runtimeId("session-opened"),
          to: "viewer_open",
          occurredAt: timestamp,
        });
      });
      sessionId = newSessionId;
    }
    const active = { id: sessionId, store: sessionStore };
    claimRuntime(active);
    synchronizeWalkthroughState(active);
    return active;
  };

  const refreshWalkthroughState = async (checkEvidence: boolean): Promise<void> => {
    if (sessionId === undefined || sessionStore === undefined) return;
    const previousRevision = artifact.revision;
    synchronizeWalkthroughState({ id: sessionId, store: sessionStore });
    if (checkEvidence || artifact.revision !== previousRevision) {
      const scannedArtifact = artifact;
      const evaluatedArtifact = await evaluateEvidence(scannedArtifact);
      if (artifact.revision === scannedArtifact.revision) artifact = evaluatedArtifact;
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      const host = request.headers.host;
      const origin = request.headers.origin;
      const requestFailure = viewerRequestFailure({
        allowedHosts,
        advertisedAddresses,
        host,
        localAddress: request.socket.localAddress,
        origin,
        remoteAddress: request.socket.remoteAddress,
        share: sharedPrivately ? "private" : "loopback",
        tailscaleAddresses,
      });
      if (requestFailure === "transport") {
        sendJson(response, 403, { error: "Viewer requests require a trusted private IPv4 transport" });
        return;
      }
      if (requestFailure === "host") {
        sendJson(response, 421, { error: "Invalid Host header" });
        return;
      }
      if (requestFailure === "origin") {
        sendJson(response, 403, { error: "Invalid Origin header" });
        return;
      }
      const requestOrigin = `http://${host}`;
      const requestTarget = request.url ?? "/";
      if (!requestTarget.startsWith("/") || requestTarget.startsWith("//")) {
        sendJson(response, 400, { error: "Invalid request target" });
        return;
      }
      const requestUrl = new URL(requestTarget, requestOrigin);
      if (requestUrl.search !== "") {
        sendJson(response, 400, { error: "Query parameters are not accepted" });
        return;
      }
      const requestPath = requestUrl.pathname;
      if (requestPath.startsWith("/api/")) {
        const token = parseCookies(request).get(SESSION_COOKIE);
        if (!tokenMatches(token, activeTokens)) {
          sendJson(response, 401, { error: "Browser session authentication required" });
          return;
        }
      }
      if (requestPath === "/api/artifact") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        await refreshWalkthroughState(true);
        if (request.method === "HEAD") {
          send(response, 200, "", "application/json; charset=utf-8");
        } else {
          sendJson(response, 200, artifact);
        }
        return;
      }

      if (requestPath === "/api/session") {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const active = activeSession();
        sendJson(response, 200, active.store.getSnapshot(active.id));
        return;
      }

      if (requestPath === "/api/session/mode") {
        if (request.method !== "PATCH") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const body = objectValue(await readJson(request));
        const mode = ConversationModeSchema.safeParse(body.mode);
        if (Object.keys(body).length !== 1 || !mode.success) {
          sendJson(response, 400, { error: "Conversation mode must be analyze or learn" });
          return;
        }
        const active = activeSession();
        const result = active.store.transaction((store) => {
          const snapshot = store.getSnapshot(active.id);
          if (snapshot === undefined) {
            throw new SessionStoreStateError(`Session ${active.id} does not exist`);
          }
          const latestEventAt = snapshot.events.at(-1)?.occurredAt ?? snapshot.session.updatedAt;
          const now = new Date().toISOString();
          const changedAt = compareProtocolTimestamps(now, latestEventAt) >= 0
            ? now
            : latestEventAt;
          return store.setConversationMode({
            sessionId: active.id,
            eventId: runtimeId("conversation-mode"),
            mode: mode.data,
            changedAt,
          });
        });
        sendJson(response, 200, { mode: result.record.conversationMode });
        return;
      }

      if (requestPath === "/api/session/end") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const active = activeSession();
        sendJson(response, 200, endLiveSession(active.store, active.id));
        return;
      }

      if (requestPath === "/api/events/ack") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const body = objectValue(await readJson(request));
        const acknowledgementSequence = body.lastEventId;
        if (
          Object.keys(body).length !== 1 ||
          typeof acknowledgementSequence !== "number" ||
          !Number.isSafeInteger(acknowledgementSequence) ||
          acknowledgementSequence < 0
        ) {
          sendJson(response, 400, {
            error: "Event acknowledgement requires one non-negative integer lastEventId",
          });
          return;
        }
        const active = activeSession();
        const token = parseCookies(request).get(SESSION_COOKIE) ?? "";
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const consumer = `viewer-${tokenHash}`;
        const cursorId = `cursor-${tokenHash}`;
        const existing = active.store.getSnapshot(active.id)?.cursors.find(
          (candidate) => candidate.consumer === consumer,
        );
        const now = Date.now();
        const updatedAt = new Date(Math.max(
          now,
          existing === undefined ? now : Date.parse(existing.updatedAt),
        )).toISOString();
        const result = active.store.advanceCursor({
          id: cursorId,
          sessionId: active.id,
          consumer,
          lastSequence: acknowledgementSequence,
          updatedAt,
        });
        sendJson(response, 200, result.record);
        return;
      }

      if (requestPath === "/api/events") {
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const lastEventId = request.headers["last-event-id"];
        if (Array.isArray(lastEventId)) {
          sendJson(response, 400, { error: "Last-Event-ID must contain one durable event sequence" });
          return;
        }
        const requestedSequence = lastEventId === undefined || lastEventId === ""
          ? undefined
          : Number(lastEventId);
        if (requestedSequence !== undefined && (!Number.isSafeInteger(requestedSequence) || requestedSequence < 0)) {
          sendJson(response, 400, { error: "Last-Event-ID must be a non-negative durable event sequence" });
          return;
        }
        const active = activeSession();
        const token = parseCookies(request).get(SESSION_COOKIE) ?? "";
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const consumer = `viewer-${tokenHash}`;
        const durableSequence = active.store.getSnapshot(active.id)?.cursors.find(
          (candidate) => candidate.consumer === consumer,
        )?.lastSequence ?? 0;
        const latestSequence = active.store.listEvents(active.id).at(-1)?.sequence ?? 0;
        if (requestedSequence !== undefined && requestedSequence > latestSequence) {
          sendJson(response, 409, {
            error: `Last-Event-ID ${requestedSequence} is not committed for session ${active.id}`,
          });
          return;
        }
        const afterSequence = requestedSequence === undefined
          ? durableSequence
          : Math.min(requestedSequence, durableSequence);
        let cursor = afterSequence;
        let sending = false;
        response.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write(": connected\n\n");
        const waitForDrain = (): Promise<boolean> => new Promise((resolveDrain) => {
          const complete = (): void => {
            response.off("drain", complete);
            response.off("close", complete);
            resolveDrain(!response.destroyed && !response.writableEnded);
          };
          response.once("drain", complete);
          response.once("close", complete);
        });
        const sendAvailable = async (): Promise<void> => {
          if (sending || response.destroyed || response.writableEnded) return;
          sending = true;
          try {
            await refreshWalkthroughState(false);
            const events = active.store.listEvents(active.id, cursor);
            for (const event of events) {
              const questionEvent = event.type.startsWith("question_") || event.type === "lease_expired";
              const snapshot = questionEvent || event.type === "status_recorded" || event.type === "reply_recorded"
                ? active.store.getSnapshot(active.id)
                : undefined;
              const record = event.type === "status_recorded"
                ? snapshot?.statuses.find(({ id }) => id === event.entityId)
                : event.type === "reply_recorded"
                  ? snapshot?.replies.find(({ questionId }) => questionId === event.entityId)
                  : questionEvent
                    ? snapshot?.questions.find(({ id }) => id === event.entityId)
                    : undefined;
              const accepted = response.write(`id: ${event.sequence}\ndata: ${JSON.stringify({
                ...event,
                ...(record === undefined ? {} : { record }),
                ...(event.type === "walkthrough_update_recorded" && event.data !== null
                  ? { walkthroughUpdate: event.data as unknown as WalkthroughUpdateOutcome }
                  : {}),
              })}\n\n`);
              if (!accepted && !(await waitForDrain())) return;
              cursor = event.sequence;
            }
          } finally {
            sending = false;
          }
        };
        void sendAvailable();
        const timer = setInterval(() => void sendAvailable(), 200);
        eventStreams.set(response, timer);
        const closeStream = (): void => {
          const activeTimer = eventStreams.get(response);
          if (activeTimer !== undefined) clearInterval(activeTimer);
          eventStreams.delete(response);
        };
        request.once("close", closeStream);
        response.once("close", closeStream);
        return;
      }

      if (requestPath === "/api/questions") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const active = activeSession();
        await refreshWalkthroughState(true);
        const parsed = browserToAgentEventSchemaForArtifact(artifact).safeParse(
          await readJson(request),
        );
        if (!parsed.success) {
          sendJson(response, 400, {
            error: parsed.error.issues.map(({ message }) => message).join("; "),
          });
          return;
        }
        if (parsed.data.sessionId !== active.id) {
          sendJson(response, 409, { error: "Question session does not match this Viewer session" });
          return;
        }
        const result = active.store.enqueueQuestion({
          id: parsed.data.eventId,
          sessionId: active.id,
          artifactRevision: parsed.data.artifactRevision,
          message: parsed.data.message,
          context: parsed.data.contextSelection ?? null,
          createdAt: parsed.data.createdAt,
        });
        sendJson(response, result.created ? 201 : 200, result.record);
        return;
      }

      if (requestPath === "/api/drafts") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const active = activeSession();
        await refreshWalkthroughState(true);
        const draftEvent = await readJson(request);
        const structuralValidation = ContextualQuestionSchema.safeParse(draftEvent);
        const creationCommitted =
          structuralValidation.success &&
          active.store.listEvents(active.id).some(
            ({ id, type }) =>
              id === structuralValidation.data.eventId && type === "draft_created",
          );
        const parsed = creationCommitted
          ? structuralValidation
          : browserToAgentEventSchemaForArtifact(artifact).safeParse(draftEvent);
        if (!parsed.success) {
          sendJson(response, 400, {
            error: parsed.error.issues.map(({ message }) => message).join("; "),
          });
          return;
        }
        if (parsed.data.sessionId !== active.id) {
          sendJson(response, 409, { error: "Draft session does not match this Viewer session" });
          return;
        }
        const result = active.store.createDraft({
          id: parsed.data.eventId,
          sessionId: active.id,
          artifactRevision: parsed.data.artifactRevision,
          message: parsed.data.message,
          context: parsed.data.contextSelection ?? null,
          createdAt: parsed.data.createdAt,
        });
        sendJson(response, result.created ? 201 : 200, result.record);
        return;
      }

      if (requestPath === "/api/drafts/send") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const active = activeSession();
        await refreshWalkthroughState(true);
        const body = objectValue(await readJson(request));
        if (typeof body.eventId !== "string" || typeof body.sentAt !== "string") {
          sendJson(response, 400, { error: "Sending drafts requires eventId and sentAt" });
          return;
        }
        if (
          !Array.isArray(body.drafts) ||
          !body.drafts.every((draft) =>
            typeof draft === "object" &&
            draft !== null &&
            !Array.isArray(draft) &&
            typeof (draft as Record<string, unknown>).id === "string" &&
            typeof (draft as Record<string, unknown>).updatedAt === "string"
          )
        ) {
          sendJson(response, 400, { error: "Sending drafts requires the displayed draft batch" });
          return;
        }
        const drafts = body.drafts.map((draft) => {
          const record = draft as Record<string, unknown>;
          return { id: record.id as string, updatedAt: record.updatedAt as string };
        });
        let composer: {
          readonly artifactRevision: number;
          readonly message: string;
          readonly context: JsonValue | null;
        } | null = null;
        if (body.composer !== null && body.composer !== undefined) {
          const composerBody = objectValue(body.composer);
          const contextSelection = composerBody.contextSelection;
          const composerEvent = {
            schemaVersion: 1,
            type: "question",
            eventId: body.eventId,
            sessionId: active.id,
            artifactRevision: composerBody.artifactRevision,
            createdAt: body.sentAt,
            mode: active.store.getSession(active.id)?.conversationMode,
            message: composerBody.message,
            ...(Array.isArray(contextSelection) && contextSelection.length === 0
              ? {}
              : { contextSelection }),
          };
          const structuralValidation = ContextualQuestionSchema.safeParse(composerEvent);
          const sendCommitted =
            structuralValidation.success &&
            active.store.listEvents(active.id).some(
              ({ id, type }) =>
                id === structuralValidation.data.eventId && type === "drafts_sent",
            );
          const validation = sendCommitted
            ? structuralValidation
            : browserToAgentEventSchemaForArtifact(artifact).safeParse(composerEvent);
          if (!validation.success) {
            sendJson(response, 400, {
              error: validation.error.issues.map(({ message }) => message).join("; "),
            });
            return;
          }
          composer = {
            artifactRevision: validation.data.artifactRevision,
            message: validation.data.message,
            context: validation.data.contextSelection ?? null,
          };
        }
        const result = active.store.sendDrafts({
          sessionId: active.id,
          eventId: body.eventId,
          sentAt: body.sentAt,
          drafts,
          composer,
        });
        sendJson(response, result.created ? 201 : 200, result.questions);
        return;
      }

      const draftPath = requestPath.match(/^\/api\/drafts\/([a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)*)$/);
      if (draftPath !== null) {
        const draftId = draftPath[1] ?? "";
        const active = activeSession();
        if (request.method === "PATCH") {
          const body = objectValue(await readJson(request));
          if (typeof body.expectedUpdatedAt !== "string") {
            sendJson(response, 400, { error: "Draft edit requires expectedUpdatedAt" });
            return;
          }
          const contextSelection = body.contextSelection;
          const draftEvent = {
            schemaVersion: 1,
            type: "question",
            eventId: body.eventId,
            sessionId: active.id,
            artifactRevision: body.artifactRevision,
            createdAt: body.updatedAt,
            mode: body.mode,
            message: body.message,
            ...(Array.isArray(contextSelection) && contextSelection.length === 0
              ? {}
              : { contextSelection }),
          };
          const structuralValidation = ContextualQuestionSchema.safeParse(draftEvent);
          if (!structuralValidation.success) {
            sendJson(response, 400, {
              error: structuralValidation.error.issues.map(({ message }) => message).join("; "),
            });
            return;
          }
          const editCommitted = active.store.listEvents(active.id).some(
            ({ id, type }) =>
              id === structuralValidation.data.eventId && type === "draft_updated",
          );
          const existingDraft = active.store.getDraft(draftId);
          const preservesAnchor =
            existingDraft !== undefined &&
            structuralValidation.data.artifactRevision === existingDraft.artifactRevision &&
            isDeepStrictEqual(
              structuralValidation.data.contextSelection ?? null,
              existingDraft.context,
            );
          const validation = editCommitted || preservesAnchor || existingDraft === undefined
            ? structuralValidation
            : browserToAgentEventSchemaForArtifact(artifact).safeParse(draftEvent);
          if (!validation.success) {
            sendJson(response, 400, {
              error: validation.error.issues.map(({ message }) => message).join("; "),
            });
            return;
          }
          const result = active.store.editDraft({
            draftId,
            sessionId: active.id,
            eventId: validation.data.eventId,
            expectedUpdatedAt: body.expectedUpdatedAt,
            artifactRevision: validation.data.artifactRevision,
            mode: validation.data.mode,
            message: validation.data.message,
            context: validation.data.contextSelection ?? null,
            updatedAt: validation.data.createdAt,
          });
          sendJson(response, 200, result.record);
          return;
        }
        if (request.method === "DELETE") {
          const body = objectValue(await readJson(request));
          if (
            typeof body.eventId !== "string" ||
            typeof body.expectedUpdatedAt !== "string" ||
            typeof body.removedAt !== "string"
          ) {
            sendJson(response, 400, {
              error: "Draft removal requires eventId, expectedUpdatedAt, and removedAt",
            });
            return;
          }
          const result = active.store.removeDraft({
            draftId,
            sessionId: active.id,
            eventId: body.eventId,
            expectedUpdatedAt: body.expectedUpdatedAt,
            removedAt: body.removedAt,
          });
          sendJson(response, 200, result.record);
          return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      const questionPath = requestPath.match(/^\/api\/questions\/([a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)*)$/);
      if (questionPath !== null) {
        const questionId = questionPath[1] ?? "";
        const active = activeSession();
        if (request.method === "PATCH") {
          const body = objectValue(await readJson(request));
          const contextSelection = body.contextSelection;
          const existingQuestion = active.store.getQuestion(questionId);
          if (existingQuestion === undefined) {
            sendJson(response, 404, { error: `Question ${questionId} does not exist` });
            return;
          }
          const validation = browserToAgentEventSchemaForArtifact(artifact).safeParse({
            schemaVersion: 1,
            type: "question",
            eventId: body.eventId,
            sessionId: active.id,
            artifactRevision: artifact.revision,
            createdAt: body.updatedAt,
            mode: existingQuestion.mode,
            message: body.message,
            ...(Array.isArray(contextSelection) && contextSelection.length === 0
              ? {}
              : { contextSelection }),
          });
          if (!validation.success) {
            sendJson(response, 400, {
              error: validation.error.issues.map(({ message }) => message).join("; "),
            });
            return;
          }
          const result = active.store.editQuestion({
            questionId,
            sessionId: active.id,
            eventId: validation.data.eventId,
            message: validation.data.message,
            context: validation.data.contextSelection ?? null,
            updatedAt: validation.data.createdAt,
          });
          sendJson(response, 200, result.record);
          return;
        }
        if (request.method === "DELETE") {
          const body = objectValue(await readJson(request));
          if (typeof body.eventId !== "string" || typeof body.cancelledAt !== "string") {
            sendJson(response, 400, { error: "Cancellation requires eventId and cancelledAt" });
            return;
          }
          const result = active.store.cancelQuestion({
            questionId,
            sessionId: active.id,
            eventId: body.eventId,
            cancelledAt: body.cancelledAt,
          });
          sendJson(response, 200, result.record);
          return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (requestPath.startsWith("/api/")) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      const selectedPath = requestPath === "/" ? indexPath : assets.get(requestPath);
      if (selectedPath === undefined) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const headers: Record<string, string> = {};
      if (requestPath === "/") {
        const existingToken = parseCookies(request).get(SESSION_COOKIE);
        const sessionToken = existingToken !== undefined && tokenMatches(existingToken, activeTokens)
          ? existingToken
          : randomBytes(32).toString("base64url");
        if (!activeTokens.has(sessionToken)) {
          activeTokens.add(sessionToken);
          if (activeTokens.size > 32) {
            const oldestToken = activeTokens.values().next().value;
            if (oldestToken !== undefined) activeTokens.delete(oldestToken);
          }
        }
        headers["Set-Cookie"] = `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`;
      }
      const contents = request.method === "HEAD" ? "" : await readFile(selectedPath, "utf8");
      send(response, 200, contents, mimeType(selectedPath), headers);
    })().catch((error: unknown) => {
      const expected = error instanceof SessionStoreConflictError || error instanceof SessionStoreStateError;
      if (!response.headersSent) {
        sendJson(response, expected ? 409 : 500, {
          error: expected && error instanceof Error ? error.message : "Internal server error",
        });
      }
      else response.destroy();
    });
  });

  prependViewerConnectionGuard(server, {
    advertisedAddresses,
    share: sharedPrivately ? "private" : "loopback",
    tailscaleAddresses,
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, sharedPrivately ? PRIVATE_NETWORK_HOST : LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("The local Viewer did not receive a TCP port");
  }
  const origins = advertisedAddresses.map((address_) => `http://${address_}:${address.port}`);
  for (const origin of origins) allowedHosts.add(origin.slice("http://".length));
  const expectedOrigin = origins[0] ?? "";

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      // Stop accepting reconnects before ending SSE responses. EventSource clients
      // reconnect automatically when a stream ends, so reversing this order can
      // admit a new connection that keeps server.close() waiting indefinitely.
      const serverClosed = new Promise<void>((resolveClose, reject) => {
        server.close((error) => error === undefined ? resolveClose() : reject(error));
      });
      for (const [stream, timer] of eventStreams) {
        clearInterval(timer);
        stream.end();
      }
      eventStreams.clear();
      server.closeAllConnections();
      await serverClosed;
      try {
        if (
          ownsRuntime &&
          sessionId !== undefined &&
          sessionStore !== undefined &&
          sessionStore.renewRuntimeOwnership(sessionId, runtimeOwnerId)
        ) {
          const session = sessionStore.getSession(sessionId);
          if (session !== undefined && session.state !== "ended" && session.state !== "interrupted") {
            const timestamp = new Date().toISOString();
            const events = sessionStore.listEvents(sessionId);
            const latestEventAt = events[events.length - 1]?.occurredAt ?? session.updatedAt;
            const occurredAt = timestamp < latestEventAt ? latestEventAt : timestamp;
            sessionStore.transitionSession({
              sessionId,
              eventId: runtimeId("session-interrupted"),
              to: "interrupted",
              occurredAt,
            });
          }
        } else {
          ownsRuntime = false;
          runtimeOwnershipLost = true;
        }
      } finally {
        try {
          if (ownsRuntime && sessionId !== undefined && sessionStore !== undefined) {
            sessionStore.releaseRuntimeOwnership(sessionId, runtimeOwnerId);
            ownsRuntime = false;
          }
        } finally {
          if (ownsSessionStore) sessionStore?.close();
        }
      }
    })();
    return closePromise;
  };

  return {
    server,
    origin: expectedOrigin,
    origins,
    get sessionId() {
      return activeSession().id;
    },
    close,
  };
}

function launchBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { executable: "open", arguments: [url] }
    : process.platform === "win32"
      ? { executable: "cmd", arguments: ["/c", "start", "", url] }
      : { executable: "xdg-open", arguments: [url] };
  const child = spawn(command.executable, command.arguments, {
    detached: true,
    stdio: "ignore",
  });
  child.once("error", () => {
    process.stderr.write("Viewer started, but the browser could not be opened automatically.\n");
  });
  child.unref();
}

function parseOpenOptions(arguments_: string[]): OpenOptions {
  const artifactPath = arguments_[0];
  if (artifactPath === undefined || artifactPath.startsWith("--")) {
    throw new Error(
      "Usage: wmtc open <walkthrough.json> --skill-version <version> [--share private] [--no-open] [--port <number>]",
    );
  }
  let openBrowser = true;
  let port = 0;
  let share: "private" | undefined;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--no-open") {
      openBrowser = false;
    } else if (argument === "--share") {
      if (arguments_[index + 1] !== "private") {
        throw new Error("--share requires the value private");
      }
      share = "private";
      index += 1;
    } else if (argument === "--port") {
      const portArgument = arguments_[index + 1];
      const parsedPort = Number(portArgument);
      if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      port = parsedPort;
      index += 1;
    } else {
      throw new Error(`Unknown open option: ${argument ?? ""}`);
    }
  }
  return { artifactPath, openBrowser, port, ...(share === undefined ? {} : { share }) };
}

async function openCommand(arguments_: string[]): Promise<void> {
  const options = parseOpenOptions(arguments_);
  // Validation deliberately completes before any server socket is created.
  const artifact = await loadArtifact(options.artifactPath);
  const runtime = await startWalkthroughServer(artifact, options.port, undefined, {
    ...(options.share === undefined ? {} : { share: options.share }),
  });
  try {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: "viewer_open",
      sessionId: runtime.sessionId,
      artifactId: artifact.id,
      revision: artifact.revision,
      origin: runtime.origin,
      origins: runtime.origins,
    })}\n`);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  if (options.openBrowser) launchBrowser(runtime.origin);

  const shutdown = (): void => {
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function rootHelp(): string {
  return [
    "Walk Me Through the Code",
    "",
    "Usage: wmtc <command> [options]",
    "",
    "Commands:",
    "  help [command]                  Show help for a command.",
    "  compatibility                    Print runtime and skill compatibility as JSON.",
    "  version                          Print the runtime version.",
    "  skill <install|verify>           Install or verify the bundled agent skill.",
    "  open <walkthrough.json>          Open a local Viewer for an artifact.",
    "  poll <session-id>                Wait for the next question from the Viewer.",
    "  acknowledge <session-id> <event-id>  Confirm a delivered question.",
    "  progress <session-id> <event-id> <status.json>  Record agent progress.",
    "  reply <session-id> <response.json>  Send an answer or Walkthrough Update.",
    "  retry-update <session-id> <update.json>  Retry a rejected update.",
    "  fail <session-id> <event-id> <error.json>  Record a structured failure.",
    "  end <session-id>                 End a Live Session.",
    "  history <list|discard>           List or discard saved sessions.",
    "",
    "Use `wmtc <command> --help` for command syntax and options.",
    "Installation agents should run `wmtc compatibility`, then `wmtc skill install --host <host>` and `wmtc skill verify --host <host>`.",
  ].join("\n");
}

function commandHelp(command: string, arguments_: readonly string[] = []): string | undefined {
  switch (command) {
    case "compatibility":
      return [
        "Usage: wmtc compatibility",
        "",
        "Print the runtime version and supported skill versions as JSON.",
      ].join("\n");
    case "version":
    case "--version":
    case "-v":
      return [
        "Usage: wmtc version",
        "",
        "Aliases: wmtc --version, wmtc -v",
        "",
        "Print the runtime version.",
      ].join("\n");
    case "open":
      return [
        "Usage: wmtc open <walkthrough.json> --skill-version <version> [--share private] [--no-open] [--port <number>]",
        "",
        "Validate a Walkthrough Artifact and open its local Viewer.",
        "",
        "Options:",
        "  --skill-version <version>  Required bundled skill version.",
        "  --share private            Explicitly allow trusted LAN or Tailnet access.",
        "  --no-open                  Do not launch a browser automatically.",
        "  --port <number>            Use a TCP port from 0 through 65535; 0 selects one.",
      ].join("\n");
    case "poll":
      return agentCommandHelp("poll", "Wait for and lease the next Viewer question.");
    case "acknowledge":
      return agentCommandHelp("acknowledge", "Confirm a question delivered by poll.");
    case "progress":
      return agentCommandHelp("progress", "Record a structured agent progress status.");
    case "reply":
      return agentCommandHelp("reply", "Send a structured answer or Walkthrough Update.");
    case "retry-update":
      return agentCommandHelp("retry-update", "Retry a rejected Walkthrough Update with its current revision.");
    case "fail":
      return agentCommandHelp("fail", "Record a structured failure for a delivered question.");
    case "end":
      return agentCommandHelp("end", "End a Live Session. This operation is idempotent.");
    case "skill":
      return skillHelp(arguments_);
    case "history":
      return historyHelp(arguments_);
    default:
      return undefined;
  }
}

function agentCommandHelp(command: string, description: string): string {
  const usage = {
    poll: "<session-id>",
    acknowledge: "<session-id> <event-id>",
    progress: "<session-id> <event-id> <status.json>",
    reply: "<session-id> <response.json>",
    "retry-update": "<session-id> <update.json>",
    fail: "<session-id> <event-id> <error.json>",
    end: "<session-id>",
  }[command];
  return [
    `Usage: wmtc ${command} ${usage} --skill-version <version>`,
    "",
    description,
    "",
    "Options:",
    "  --skill-version <version>  Required bundled skill version.",
  ].join("\n");
}

function skillHelp(arguments_: readonly string[]): string | undefined {
  const [operation] = arguments_;
  if (operation === undefined) {
    return [
      "Usage: wmtc skill <install|verify> --host <codex|claude-code|opencode>",
      "",
      "Install or verify the bundled Walk Me Through the Code skill.",
      "",
      "Subcommands:",
      "  install  Install the bundled skill without replacing an existing installation.",
      "  verify   Verify that a managed installed skill is current and unmodified.",
    ].join("\n");
  }
  if (operation !== "install" && operation !== "verify") return undefined;
  const description = operation === "install"
    ? "Install the bundled skill for one supported agent host. Existing destinations are never overwritten."
    : "Verify that the installed skill is managed, current, and unmodified.";
  return [
    `Usage: wmtc skill ${operation} --host <codex|claude-code|opencode>`,
    "",
    description,
    "",
    "Options:",
    "  --host <host>  Required agent host: codex, claude-code, or opencode.",
  ].join("\n");
}

function historyHelp(arguments_: readonly string[]): string | undefined {
  const [operation] = arguments_;
  if (operation === undefined) {
    return [
      "Usage: wmtc history <list|discard>",
      "",
      "Inspect or explicitly discard saved Walkthrough sessions.",
      "",
      "Subcommands:",
      "  list                Print saved session metadata and outcome counts as JSON.",
      "  discard <session-id>  Permanently remove one inactive saved session.",
    ].join("\n");
  }
  if (operation === "list") {
    return [
      "Usage: wmtc history list",
      "",
      "Print saved session metadata and outcome counts as JSON.",
    ].join("\n");
  }
  if (operation === "discard") {
    return [
      "Usage: wmtc history discard <session-id>",
      "",
      "Permanently remove one inactive saved session and its product-state records.",
    ].join("\n");
  }
  return undefined;
}

function isHelpRequest(arguments_: readonly string[]): boolean {
  return arguments_.includes("--help") || arguments_.includes("-h");
}

function historyCommand(arguments_: readonly string[]): unknown {
  const [operation, sessionId, ...extra] = arguments_;
  const store = new SqliteSessionStore({ stateScope: "global-history" });
  try {
    if (operation === "list" && sessionId === undefined && extra.length === 0) {
      const sessions = store.listSessions().map((session) => {
        const snapshot = store.getSnapshot(session.id);
        const artifact = snapshot?.walkthroughState?.artifact;
        const artifactTitle = typeof artifact === "object" &&
          artifact !== null &&
          !Array.isArray(artifact)
          ? (artifact as { readonly title?: JsonValue }).title
          : undefined;
        const title = typeof artifactTitle === "string"
          ? artifactTitle
          : undefined;
        return {
          id: session.id,
          walkthroughId: session.walkthroughId,
          ...(title === undefined ? {} : { title }),
          revision: snapshot?.walkthroughState?.revision ?? session.artifactRevision,
          state: session.state,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          endedAt: session.endedAt,
          outcomes: {
            queued: snapshot?.questions.filter(({ state }) => state === "queued").length ?? 0,
            answered: snapshot?.questions.filter(({ state }) => state === "answered").length ?? 0,
            failed: snapshot?.questions.filter(({ state }) => state === "failed").length ?? 0,
            cancelled: snapshot?.questions.filter(({ state }) => state === "cancelled").length ?? 0,
          },
        };
      });
      return { ok: true, status: "history", sessions };
    }
    if (operation === "discard" && sessionId !== undefined && extra.length === 0) {
      if (!/^[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)*$/.test(sessionId)) {
        throw new AgentCommandInputError("History discard requires a valid session ID");
      }
      return {
        ok: true,
        status: "discarded",
        sessionId,
        discarded: store.discardSession(sessionId),
      };
    }
    throw new AgentCommandInputError(
      "Usage: wmtc history list | wmtc history discard <session-id>",
    );
  } finally {
    store.close();
  }
}

function requireCompatibleSkillVersion(command: string, arguments_: string[]): string[] {
  const optionIndexes = arguments_
    .map((argument, index) => argument === "--skill-version" ? index : -1)
    .filter((index) => index >= 0);
  if (optionIndexes.length !== 1) {
    throw new AgentCommandInputError(
      `wmtc ${command} requires exactly one --skill-version <version> option. ` +
      `Runtime ${VERSION} supports walk-me-through-code skill ${SUPPORTED_SKILL_VERSIONS.join(", ")}.`,
    );
  }
  const optionIndex = optionIndexes[0] ?? -1;
  const skillVersion = arguments_[optionIndex + 1];
  if (skillVersion === undefined || skillVersion.startsWith("--")) {
    throw new AgentCommandInputError("--skill-version requires a version value");
  }
  if (!SUPPORTED_SKILL_VERSIONS.includes(skillVersion as typeof SUPPORTED_SKILL_VERSIONS[number])) {
    throw new AgentCommandInputError(
      `wmtc ${VERSION} requires walk-me-through-code skill ${SUPPORTED_SKILL_VERSIONS.join(", ")}, ` +
      `but found ${skillVersion}. Install the pinned matching skill.`,
    );
  }
  return arguments_.filter((_, index) => index !== optionIndex && index !== optionIndex + 1);
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    process.stdout.write(`${rootHelp()}\n`);
  } else if (command === "help") {
    const [helpCommand, ...helpArguments] = arguments_;
    const help = helpCommand === undefined || helpCommand === "--help" || helpCommand === "-h"
      ? rootHelp()
      : commandHelp(helpCommand, helpArguments);
    if (help === undefined) {
      throw new AgentCommandInputError(`Unknown help topic: ${helpCommand}\n${rootHelp()}`);
    }
    process.stdout.write(`${help}\n`);
  } else if (command !== undefined && isHelpRequest(arguments_)) {
    const help = commandHelp(command, arguments_.filter((argument) => argument !== "--help" && argument !== "-h"));
    if (help === undefined) {
      throw new AgentCommandInputError(`Unknown command: ${command}\n${rootHelp()}`);
    }
    process.stdout.write(`${help}\n`);
  } else if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
  } else if (command === "compatibility") {
    if (arguments_.length > 0) throw new AgentCommandInputError("Usage: wmtc compatibility");
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: VERSION,
      supportedSkillVersions: SUPPORTED_SKILL_VERSIONS,
    })}\n`);
  } else if (command === "open") {
    await openCommand(requireCompatibleSkillVersion(command, arguments_));
  } else if (command === "history") {
    process.stdout.write(`${JSON.stringify(historyCommand(arguments_))}\n`);
  } else if (command === "skill") {
    const result = await executeSkillCommand(arguments_, {
      bundledSkillDirectory: fileURLToPath(new URL(
        "../../../skills/walk-me-through-code",
        import.meta.url,
      )),
      homeDirectory: homedir(),
      skillVersion: SUPPORTED_SKILL_VERSIONS[0],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (["poll", "acknowledge", "progress", "reply", "retry-update", "fail", "end"].includes(command ?? "")) {
    const result = await executeAgentCommand(
      command ?? "",
      requireCompatibleSkillVersion(command ?? "", arguments_),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    throw new AgentCommandInputError(
      command === undefined ? rootHelp() : `Unknown command: ${command}\n${rootHelp()}`,
    );
  }
}

const isDirectExecution = process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        code: error instanceof SkillInstallationError
          ? error.code
          : agentCommandErrorCode(error),
        message,
      },
    })}\n`);
    process.exitCode = 1;
  });
}
