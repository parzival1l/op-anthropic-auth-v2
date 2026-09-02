import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

const dataHome = mkdtempSync(join(tmpdir(), "op-anthropic-auth-v2-test-"));
const authDirectory = join(dataHome, "opencode");
const authFile = join(authDirectory, "auth.json");
let hooks;
let registration;
let activeCredential;

function chunkedResponse(chunks, options = {}) {
  const encoder = new TextEncoder();
  const pending = chunks.map((chunk) => encoder.encode(chunk));
  return new Response(
    new ReadableStream({
      pull(controller) {
        const chunk = pending.shift();
        if (chunk) controller.enqueue(chunk);
        else if (!options.keepOpen) controller.close();
      },
      cancel: options.cancel,
    }),
    { headers: options.headers },
  );
}

function oauthResponseEvent(response) {
  return {
    request: new Request("https://api.anthropic.com/v1/messages?beta=true", {
      headers: { "user-agent": "claude-cli/2.1.257 (external, cli)" },
    }),
    response,
  };
}

before(async () => {
  process.env.XDG_DATA_HOME = dataHome;
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(
    authFile,
    JSON.stringify({
      anthropic: {
        type: "oauth",
        refresh: "legacy-refresh-token",
        access: "legacy-access-token",
        expires: Date.now() + 60_000,
      },
    }),
    { mode: 0o600 },
  );
  const { default: plugin } = await import(`../index.js?test=${Date.now()}`);
  hooks = {};
  await plugin.setup({
    integration: {
      async transform(callback) {
        callback({
          method: {
            update(value) {
              registration = value;
            },
          },
        });
      },
      connection: {
        async active() {
          return { id: "anthropic-connection" };
        },
        async resolve() {
          return activeCredential;
        },
      },
    },
    session: {
      async hook(name, callback) {
        hooks[name] = callback;
      },
    },
  });
});

beforeEach(() => {
  activeCredential = {
    type: "oauth",
    methodID: "oauth",
    refresh: "refresh-token",
    access: "access-token",
    expires: Date.now() + 60_000,
  };
});

after(() => {
  rmSync(dataHome, { recursive: true, force: true });
});

test("rewrites tool names when JSON spans network chunks", async () => {
  const event = oauthResponseEvent(
    chunkedResponse(
      ['data: {"type":"content_block_start","content_block":{"name":"mc', 'p_URLFetch"}}\n\n'],
      { headers: { "content-type": "text/event-stream" } },
    ),
  );

  await hooks["http.response"](event);

  assert.equal(
    await event.response.text(),
    'data: {"type":"content_block_start","content_block":{"name": "URLFetch"}}\n\n',
  );
});

test("rewrites non-streaming JSON across chunks and removes stale length headers", async () => {
  const event = oauthResponseEvent(
    chunkedResponse(['{"content":[{"name":"m', 'cp_Read"}]}'], {
      headers: {
        "content-length": "999",
        "content-type": "application/json",
      },
    }),
  );

  await hooks["http.response"](event);

  assert.equal(await event.response.text(), '{"content":[{"name": "Read"}]}');
  assert.equal(event.response.headers.has("content-length"), false);
});

test("cancelling a rewritten response cancels its source", async () => {
  let cancelled = false;
  const event = oauthResponseEvent(
    chunkedResponse(["data: pending"], {
      headers: { "content-type": "text/event-stream" },
      keepOpen: true,
      cancel() {
        cancelled = true;
      },
    }),
  );

  await hooks["http.response"](event);
  const reader = event.response.body.getReader();
  const read = reader.read();
  await reader.cancel("interrupted");
  await read.catch(() => {});

  assert.equal(cancelled, true);
});

test("rewritten requests retain their abort signal", async () => {
  const controller = new AbortController();
  const original = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    signal: controller.signal,
  });
  const event = { request: original };

  await hooks["http.request"](event);
  controller.abort();

  assert.equal(original.signal.aborted, true);
  assert.equal(event.request.signal.aborted, true);
});

test("rewritten requests report the supported Claude Code version", async () => {
  const event = {
    request: new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    }),
  };

  await hooks["http.request"](event);

  assert.equal(
    event.request.headers.get("user-agent"),
    "claude-cli/2.1.257 (external, cli)",
  );
  const body = await event.request.json();
  assert.match(body.system[0].text, /cc_version=2\.1\.257\./);
});

test("tool names round-trip without changing case", async () => {
  const event = {
    request: new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "URLFetch", description: "Fetch a URL", input_schema: {} }],
      }),
    }),
  };

  await hooks["http.request"](event);
  const body = await event.request.json();

  assert.equal(body.tools[0].name, "mcp_URLFetch");
});

test("migrates version 0.1.1 credentials to the registered method", () => {
  const stored = JSON.parse(readFileSync(authFile, "utf8"));
  assert.equal(stored.anthropic.methodID, "oauth");
  assert.equal(stored.anthropic.refresh, "legacy-refresh-token");
  assert.equal(stored.anthropic.access, "legacy-access-token");
});

test("registers a Claude Pro/Max OAuth method for Anthropic", () => {
  assert.equal(registration.integrationID, "anthropic");
  assert.deepEqual(registration.method, {
    id: "oauth",
    type: "oauth",
    label: "Claude Pro/Max",
  });
  assert.equal(typeof registration.authorize, "function");
  assert.equal(typeof registration.refresh, "function");
});

test("authorizes with PKCE and exchanges the returned code", async () => {
  const authorization = await registration.authorize({});
  const url = new URL(authorization.url);
  const state = url.searchParams.get("state");

  assert.equal(url.origin + url.pathname, "https://claude.ai/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(url.searchParams.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]+$/);
  assert.match(url.searchParams.get("scope"), /user:inference/);
  assert.equal(authorization.mode, "code");

  const originalFetch = globalThis.fetch;
  let tokenBody;
  globalThis.fetch = async (_url, init) => {
    tokenBody = JSON.parse(init.body);
    return Response.json({
      refresh_token: "new-refresh-token",
      access_token: "new-access-token",
      expires_in: 3600,
    });
  };

  try {
    const credential = await authorization.callback(`authorization-code#${state}`);
    assert.equal(tokenBody.grant_type, "authorization_code");
    assert.equal(tokenBody.code, "authorization-code");
    assert.equal(tokenBody.state, state);
    assert.equal(typeof tokenBody.code_verifier, "string");
    assert.deepEqual(
      {
        type: credential.type,
        methodID: credential.methodID,
        refresh: credential.refresh,
        access: credential.access,
      },
      {
        type: "oauth",
        methodID: "oauth",
        refresh: "new-refresh-token",
        access: "new-access-token",
      },
    );
    assert.ok(credential.expires > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an authorization callback with the wrong state", async () => {
  const authorization = await registration.authorize({});
  await assert.rejects(
    authorization.callback("authorization-code#wrong-state"),
    /state does not match/,
  );
});

test("refreshes credentials through the registered OAuth method", async () => {
  const credential = {
    type: "oauth",
    methodID: "oauth",
    refresh: "old-refresh-token",
    access: "expired-access-token",
    expires: Date.now() - 1,
    metadata: { organization: "org-id" },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), {
      grant_type: "refresh_token",
      refresh_token: "old-refresh-token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });
    return Response.json({
      access_token: "new-access-token",
      expires_in: 3600,
    });
  };

  try {
    const refreshed = await registration.refresh(credential);
    assert.equal(refreshed.refresh, "old-refresh-token");
    assert.equal(refreshed.access, "new-access-token");
    assert.deepEqual(refreshed.metadata, { organization: "org-id" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports malformed token responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      refresh_token: "refresh-token",
      access_token: "access-token",
      expires_in: -1,
    });
  try {
    await assert.rejects(
      registration.refresh(activeCredential),
      /malformed token response/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API-key authentication is left untouched", async () => {
  activeCredential = { type: "api", key: "api-key" };
  const original = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "api-key" },
    body: "{}",
  });
  const event = { request: original };

  await hooks["http.request"](event);

  assert.equal(event.request, original);
  assert.equal(event.request.headers.get("x-api-key"), "api-key");
});

test("API-key responses are left untouched", async () => {
  activeCredential = { type: "api", key: "api-key" };
  const original = Response.json({ name: "mcp_Read" });
  const event = {
    request: new Request("https://api.anthropic.com/v1/messages", {
      headers: { "x-api-key": "api-key" },
    }),
    response: original,
  };

  await hooks["http.response"](event);

  assert.equal(event.response, original);
});
