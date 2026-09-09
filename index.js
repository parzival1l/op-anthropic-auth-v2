// Anthropic OAuth (Claude Pro/Max) support for OpenCode 2.
// Port of op-anthropic-auth@0.1.4 to the v2 plugin API.
// v1 loads op-anthropic-auth itself; this file targets opencode2 only.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { generatePKCE } from "@openauthjs/openauth/pkce";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_URL = "https://platform.claude.com/oauth/code/callback";
const AUTH_METHOD_ID = "oauth";
const AUTH_SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const REQUIRED_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];
const TOOL_PREFIX = "mcp_";
const OPENCODE_IDENTITY_PREFIX = "You are OpenCode";
const CLAUDE_CODE_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const PARAGRAPH_REMOVAL_ANCHORS = [
  "github.com/anomalyco/opencode",
  "opencode.ai/docs",
];
const TEXT_REPLACEMENTS = [
  { match: "if OpenCode honestly", replacement: "if the assistant honestly" },
];
// Used only when the local Claude Code install cannot be found.
const FALLBACK_CLAUDE_CODE_VERSION = "2.1.265";
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CCH_SALT = "59cf53e54c78";
const CCH_POSITIONS = [4, 7, 20];
const USER_AGENT_PREFIX = "claude-cli/";
const TOKEN_USER_AGENT = "axios/1.13.6";
const SEMVER = /^\d+\.\d+\.\d+/;
const VERSION_CACHE_MS = 60_000;
const NPM_PACKAGE_NAME = "@anthropic-ai/claude-code";

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// ---- Claude Code version discovery ----

// Resolve the `claude` launcher through symlinks. The native installer points
// ~/.local/bin/claude at ~/.local/share/claude/versions/<version>, so the
// basename is the active version. Never pick the highest entry in versions/ —
// a failed download leaves a zero-byte file of a version that cannot run.
function resolveClaudeBinary() {
  const candidates = [];
  const searchPath = process.env.PATH;
  if (searchPath) {
    for (const dir of searchPath.split(delimiter)) {
      if (dir) candidates.push(join(dir, "claude"));
    }
  }
  candidates.push(join(homedir(), ".local", "bin", "claude"));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return realpathSync(candidate);
    } catch {
      // Unreadable entry — keep looking.
    }
  }
  return null;
}

// npm installs symlink `claude` to <root>/@anthropic-ai/claude-code/cli.js, so
// walk up from the resolved file to the package manifest.
function versionFromNpmPackage(binaryPath) {
  let dir = dirname(binaryPath);
  for (let depth = 0; depth < 5; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (isRecord(manifest) && manifest.name === NPM_PACKAGE_NAME) {
        const version = manifest.version;
        return typeof version === "string" && SEMVER.test(version) ? version : null;
      }
    } catch {
      // No manifest here — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function detectClaudeCodeVersion() {
  const override = process.env.CLAUDE_CODE_VERSION;
  if (override && SEMVER.test(override)) return override;
  const binary = resolveClaudeBinary();
  if (!binary) return null;
  const name = basename(binary);
  if (SEMVER.test(name)) return name;
  return versionFromNpmPackage(binary);
}

let versionCache = { value: "", checkedAt: 0 };

// Cached with a TTL rather than resolved once at import: Claude Code updates
// itself while the OpenCode server stays up for days, and the request hook runs
// on every call.
function claudeCodeVersion() {
  const now = Date.now();
  if (versionCache.value && now - versionCache.checkedAt < VERSION_CACHE_MS) {
    return versionCache.value;
  }
  let detected = null;
  try {
    detected = detectClaudeCodeVersion();
  } catch {
    detected = null;
  }
  const value = detected ?? FALLBACK_CLAUDE_CODE_VERSION;
  versionCache = { value, checkedAt: now };
  return value;
}

function requestUserAgent() {
  return `${USER_AGENT_PREFIX}${claudeCodeVersion()} (external, cli)`;
}

// Match the prefix, not the whole string. The version can change between a
// request and its response, and an exact match would skip the rewrite.
function isOwnUserAgent(value) {
  return typeof value === "string" && value.startsWith(USER_AGENT_PREFIX);
}

function isPluginOAuthCredential(value) {
  return (
    isRecord(value) &&
    value.type === "oauth" &&
    value.methodID === AUTH_METHOD_ID &&
    typeof value.refresh === "string" &&
    value.refresh.length > 0 &&
    typeof value.access === "string" &&
    value.access.length > 0 &&
    typeof value.expires === "number"
  );
}

function migrateLegacyCredential() {
  const authFile =
    process.env.XDG_DATA_HOME != null
      ? join(process.env.XDG_DATA_HOME, "opencode", "auth.json")
      : join(homedir(), ".local", "share", "opencode", "auth.json");
  try {
    const all = JSON.parse(readFileSync(authFile, "utf8"));
    const credential = all?.anthropic;
    if (
      !isRecord(credential) ||
      credential.type !== "oauth" ||
      credential.methodID != null ||
      typeof credential.refresh !== "string" ||
      credential.refresh.length === 0 ||
      !Number.isSafeInteger(credential.expires)
    ) {
      return false;
    }

    const hasAccess = typeof credential.access === "string" && credential.access.length > 0;
    all.anthropic = {
      ...credential,
      methodID: AUTH_METHOD_ID,
      access: hasAccess ? credential.access : "",
      expires: hasAccess ? credential.expires : 0,
    };
    const temporary = `${authFile}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, authFile);
    return true;
  } catch {
    return false;
  }
}

function parseAuthorizationCode(input) {
  const text = input.trim();
  try {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) return { code, state };
  } catch {
    // The callback may be a code-state pair instead of a URL.
  }

  const [code, state, ...rest] = text.split("#");
  if (code && state && rest.length === 0) return { code, state };

  const params = new URLSearchParams(text);
  const queryCode = params.get("code");
  const queryState = params.get("state");
  if (queryCode && queryState) return { code: queryCode, state: queryState };
  throw new Error("Authorization callback must include a code and state");
}

function makeAuthorizationUrl(challenge, state) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CALLBACK_URL);
  url.searchParams.set("scope", AUTH_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

async function requestTokens(body, action, requireRefreshToken = true) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": TOKEN_USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${action} failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }

  const result = await response.json();
  if (
    !isRecord(result) ||
    typeof result.access_token !== "string" ||
    result.access_token.length === 0 ||
    !Number.isSafeInteger(result.expires_in) ||
    result.expires_in <= 0 ||
    (requireRefreshToken &&
      (typeof result.refresh_token !== "string" || result.refresh_token.length === 0)) ||
    (!requireRefreshToken &&
      result.refresh_token != null &&
      (typeof result.refresh_token !== "string" || result.refresh_token.length === 0))
  ) {
    throw new Error(`${action} failed: malformed token response`);
  }
  return result;
}

function toCredential(tokens, metadata, fallbackRefreshToken) {
  return /** @type {import("@opencode-ai/plugin").Credential.OAuth} */ ({
    type: /** @type {"oauth"} */ ("oauth"),
    methodID: AUTH_METHOD_ID,
    refresh: tokens.refresh_token ?? fallbackRefreshToken,
    access: tokens.access_token,
    expires: Date.now() + tokens.expires_in * 1000,
    ...(metadata == null ? {} : { metadata }),
  });
}

async function authorize() {
  const pkce = await generatePKCE();
  const state = randomBytes(16).toString("hex");
  return {
    url: makeAuthorizationUrl(pkce.challenge, state),
    instructions: "Authorize Claude Pro/Max, then paste the returned code here.",
    mode: /** @type {"code"} */ ("code"),
    async callback(input) {
      const parsed = parseAuthorizationCode(input);
      if (parsed.state !== state) throw new Error("Authorization state does not match");
      const tokens = await requestTokens(
        {
          code: parsed.code,
          state: parsed.state,
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          redirect_uri: CALLBACK_URL,
          code_verifier: pkce.verifier,
        },
        "Token exchange",
      );
      return toCredential(tokens);
    },
  };
}

async function refreshCredential(
  /** @type {import("@opencode-ai/plugin").Credential.OAuth} */ credential,
) {
  const tokens = await requestTokens(
    {
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
    },
    "Token refresh",
    false,
  );
  return toCredential(tokens, credential.metadata, credential.refresh);
}

async function currentCredential(ctx) {
  const connection = await ctx.integration.connection.active("anthropic");
  if (!connection) return null;
  const credential = await ctx.integration.connection.resolve(connection);
  return isPluginOAuthCredential(credential) ? credential : null;
}

// ---- request rewriting ----

function mergeBetaHeaders(headers) {
  const incoming = (headers.get("anthropic-beta") || "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);
  return [...new Set([...REQUIRED_BETAS, ...incoming])].join(",");
}

function sanitizeSystemText(text) {
  const paragraphs = text.split(/\n\n+/);
  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) return false;
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false;
    }
    return true;
  });
  let result = filtered.join("\n\n");
  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement);
  }
  return result.trim();
}

function prependClaudeCodeIdentity(system) {
  const identityBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };
  if (system == null) return [identityBlock];
  if (typeof system === "string") {
    const sanitized = sanitizeSystemText(system);
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock];
    return [identityBlock, { type: "text", text: sanitized }];
  }
  if (isRecord(system)) {
    const type = typeof system.type === "string" ? system.type : "text";
    const text = typeof system.text === "string" ? system.text : "";
    return [identityBlock, { ...system, type, text: sanitizeSystemText(text) }];
  }
  if (!Array.isArray(system)) return [identityBlock];
  const sanitized = system.map((item) => {
    if (typeof item === "string") {
      return { type: "text", text: sanitizeSystemText(item) };
    }
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return { ...item, type: "text", text: sanitizeSystemText(item.text) };
    }
    return { type: "text", text: String(item) };
  });
  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) return sanitized;
  return [identityBlock, ...sanitized];
}

function extractFirstUserMessageText(messages) {
  const userMsg = messages.find((message) => message.role === "user");
  if (!userMsg) return "";
  const { content } = userMsg;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block.type === "text");
    if (textBlock?.text) return textBlock.text;
  }
  return "";
}

function computeCCH(messageText) {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
}

function computeVersionSuffix(messageText, version) {
  const chars = CCH_POSITIONS.map((index) => messageText[index] || "0").join("");
  return createHash("sha256")
    .update(`${CCH_SALT}${chars}${version}`)
    .digest("hex")
    .slice(0, 3);
}

function buildBillingHeaderValue(messages) {
  const text = extractFirstUserMessageText(messages);
  const version = claudeCodeVersion();
  const suffix = computeVersionSuffix(text, version);
  const cch = computeCCH(text);
  return (
    `${BILLING_HEADER_PREFIX} ` +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}; ` +
    `cch=${cch};`
  );
}

function relocateSystemEntriesToFirstUserMessage(system, messages) {
  if (!Array.isArray(system) || !Array.isArray(messages)) return system;
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return system;
  const kept = [];
  const moved = [];
  for (const entry of system) {
    if (isRecord(entry) && typeof entry.text === "string") {
      const text = entry.text.trim();
      if (!text) continue;
      if (text.startsWith(BILLING_HEADER_PREFIX) || text === CLAUDE_CODE_IDENTITY) {
        kept.push({ type: "text", text });
      } else {
        moved.push(text);
      }
      continue;
    }
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text) moved.push(text);
    }
  }
  if (!moved.length) return kept;
  const relocatedText = moved.join("\n\n");
  if (typeof firstUserMessage.content === "string") {
    firstUserMessage.content = firstUserMessage.content
      ? `${relocatedText}\n\n${firstUserMessage.content}`
      : relocatedText;
  } else if (Array.isArray(firstUserMessage.content)) {
    firstUserMessage.content = [
      { type: "text", text: relocatedText },
      ...firstUserMessage.content,
    ];
  } else {
    firstUserMessage.content = relocatedText;
  }
  return kept;
}

function prefixName(name) {
  return `${TOOL_PREFIX}${name}`;
}

function unprefixName(name) {
  return name;
}

function prefixToolNames(parsed) {
  if (parsed.tools && Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map((tool) => ({
      ...tool,
      name: tool.name ? prefixName(tool.name) : tool.name,
    }));
  }
  if (parsed.messages && Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map((msg) => {
      if (msg.content && Array.isArray(msg.content)) {
        msg.content = msg.content.map((block) => {
          if (block.type === "tool_use" && block.name) {
            return { ...block, name: prefixName(block.name) };
          }
          return block;
        });
      }
      return msg;
    });
  }
  return JSON.stringify(parsed);
}

function rewriteRequestBody(body) {
  if (!body || typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body);
    const billingHeader =
      Array.isArray(parsed.messages) &&
      parsed.messages.some((message) => message.role === "user")
        ? buildBillingHeaderValue(parsed.messages)
        : null;
    parsed.system = prependClaudeCodeIdentity(parsed.system);
    if (billingHeader && Array.isArray(parsed.system)) {
      parsed.system.unshift({ type: "text", text: billingHeader });
    }
    parsed.system = relocateSystemEntriesToFirstUserMessage(
      parsed.system,
      parsed.messages,
    );
    return prefixToolNames(parsed);
  } catch {
    return body;
  }
}

function rewriteResponse(response) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const isEventStream = response.headers
    .get("content-type")
    ?.toLowerCase()
    .includes("text/event-stream");
  let buffered = "";
  let finished = false;

  const rewriteText = (text) =>
    text.replace(
      /"name"\s*:\s*"mcp_([^"]+)"/g,
      (_match, name) => `"name": "${unprefixName(name)}"`,
    );

  const stream = new ReadableStream({
    async pull(controller) {
      while (true) {
        if (isEventStream) {
          const boundary = buffered.match(/\r?\n\r?\n/);
          if (boundary?.index != null) {
            const end = boundary.index + boundary[0].length;
            const event = buffered.slice(0, end);
            buffered = buffered.slice(end);
            controller.enqueue(encoder.encode(rewriteText(event)));
            return;
          }
        }

        if (finished) {
          if (buffered) {
            controller.enqueue(encoder.encode(rewriteText(buffered)));
            buffered = "";
          } else {
            controller.close();
          }
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          buffered += decoder.decode();
          finished = true;
        } else {
          buffered += decoder.decode(value, { stream: true });
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isAnthropicApi(url) {
  return url.hostname === "api.anthropic.com";
}

// ---- plugin ----

/** @type {import("@opencode-ai/plugin").Plugin.Plugin} */
const plugin = {
  id: "anthropic-oauth-v2",
  async setup(ctx) {
    migrateLegacyCredential();
    await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: "anthropic",
        method: {
          id: AUTH_METHOD_ID,
          type: "oauth",
          label: "Claude Pro/Max",
        },
        authorize,
        refresh: refreshCredential,
      });
    });

    await ctx.session.hook(
      "http.request",
      async (event) => {
        let url;
        try {
          url = new URL(event.request.url);
        } catch {
          return;
        }
        if (!isAnthropicApi(url)) return;

        const credential = await currentCredential(ctx);
        if (!credential) return;

        const headers = new Headers(event.request.headers);
        headers.set("authorization", `Bearer ${credential.access}`);
        headers.set("anthropic-beta", mergeBetaHeaders(headers));
        headers.set("user-agent", requestUserAgent());
        headers.delete("x-api-key");

        if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
          url.searchParams.set("beta", "true");
        }

        let body;
        if (event.request.method === "POST") {
          const original = await event.request.clone().text();
          body = rewriteRequestBody(original);
        }

        event.request = new Request(url.toString(), {
          method: event.request.method,
          headers,
          body,
          signal: event.request.signal,
        });
      },
      { providerID: "anthropic" },
    );

    await ctx.session.hook(
      "http.response",
      async (event) => {
        if (!isOwnUserAgent(event.request.headers.get("user-agent"))) return;
        // Rewrite unless the response URL is present and provably non-Anthropic.
        try {
          const url = new URL(event.response.url);
          if (!isAnthropicApi(url)) return;
        } catch {
          // No URL — rely on the providerID scope and rewrite anyway.
        }
        event.response = rewriteResponse(event.response);
      },
      { providerID: "anthropic" },
    );
  },
};

export default plugin;
