// Anthropic OAuth (Claude Pro/Max) support for OpenCode 2.
// Port of op-anthropic-auth@0.1.4 to the v2 plugin API.
// v1 loads op-anthropic-auth itself; this file targets opencode2 only.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
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
const CLAUDE_CODE_VERSION = "2.1.257";
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CCH_SALT = "59cf53e54c78";
const CCH_POSITIONS = [4, 7, 20];
const REQUEST_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
const TOKEN_USER_AGENT = "axios/1.13.6";

const AUTH_FILE =
  process.env.XDG_DATA_HOME != null
    ? join(process.env.XDG_DATA_HOME, "opencode", "auth.json")
    : join(homedir(), ".local", "share", "opencode", "auth.json");

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isOAuthAuth(value) {
  return (
    isRecord(value) &&
    value.type === "oauth" &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number"
  );
}

// ---- auth store ----

function readAuthFile() {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeAuthEntry(entry) {
  const all = readAuthFile() ?? {};
  all.anthropic = entry;
  const tmp = `${AUTH_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, AUTH_FILE);
}

let refreshPromise = null;

async function refreshAccessToken(auth) {
  let refreshToken = auth.refresh;
  const maxRetries = 2;
  const baseDelayMs = 500;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": TOKEN_USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!response.ok) {
      if (response.status >= 500 && attempt < maxRetries) {
        await response.body?.cancel();
        continue;
      }
      // On 401, another process may have already rotated the refresh token.
      if (response.status === 401 && attempt < maxRetries) {
        const updated = readAuthFile()?.anthropic;
        if (isOAuthAuth(updated) && updated.refresh !== refreshToken) {
          await response.body?.cancel();
          if (updated.access && updated.expires > Date.now()) {
            return updated.access;
          }
          refreshToken = updated.refresh;
          continue;
        }
      }
      const body = await response.text().catch(() => "");
      throw new Error(`Token refresh failed: ${response.status} — ${body}`);
    }
    const json = await response.json();
    const entry = {
      type: "oauth",
      refresh: json.refresh_token,
      access: json.access_token,
      expires: Date.now() + json.expires_in * 1000,
    };
    writeAuthEntry(entry);
    return entry.access;
  }
  throw new Error("Token refresh failed: retries exhausted");
}

async function currentAccessToken() {
  const auth = readAuthFile()?.anthropic;
  if (!isOAuthAuth(auth)) return null;
  if (auth.access && auth.expires > Date.now() + 30_000) return auth.access;
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken(auth).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
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

function computeVersionSuffix(messageText) {
  const chars = CCH_POSITIONS.map((index) => messageText[index] || "0").join("");
  return createHash("sha256")
    .update(`${CCH_SALT}${chars}${CLAUDE_CODE_VERSION}`)
    .digest("hex")
    .slice(0, 3);
}

function buildBillingHeaderValue(messages) {
  const text = extractFirstUserMessageText(messages);
  const suffix = computeVersionSuffix(text);
  const cch = computeCCH(text);
  return (
    `${BILLING_HEADER_PREFIX} ` +
    `cc_version=${CLAUDE_CODE_VERSION}.${suffix}; ` +
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

export default {
  id: "anthropic-oauth-v2",
  async setup(ctx) {
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

        const access = await currentAccessToken();
        if (!access) return; // not OAuth (API key user) — leave untouched

        const headers = new Headers(event.request.headers);
        headers.set("authorization", `Bearer ${access}`);
        headers.set("anthropic-beta", mergeBetaHeaders(headers));
        headers.set("user-agent", REQUEST_USER_AGENT);
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
          duplex: "half",
          signal: event.request.signal,
        });
      },
      { providerID: "anthropic" },
    );

    await ctx.session.hook(
      "http.response",
      (event) => {
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
