import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dataHome = mkdtempSync(join(tmpdir(), "op-anthropic-auth-v2-test-"));
const authDirectory = join(dataHome, "opencode");
const authFile = join(authDirectory, "auth.json");
let hooks;

function writeAuth(auth) {
  writeFileSync(authFile, JSON.stringify({ anthropic: auth }), { mode: 0o600 });
}

function chunkedResponse(chunks, options = {}) {
  const encoder = new TextEncoder();
  const pending = chunks.map((chunk) => encoder.encode(chunk));
  return new Response(
    new ReadableStream({
      pull(controller) {
        const chunk = pending.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel: options.cancel,
    }),
    { headers: options.headers },
  );
}

before(async () => {
  process.env.XDG_DATA_HOME = dataHome;
  mkdirSync(authDirectory, { recursive: true });
  writeAuth({
    type: "oauth",
    refresh: "refresh-token",
    access: "access-token",
    expires: Date.now() + 60_000,
  });

  const { default: plugin } = await import(`../index.js?test=${Date.now()}`);
  hooks = {};
  await plugin.setup({
    session: {
      async hook(name, callback) {
        hooks[name] = callback;
      },
    },
  });
});

after(() => {
  rmSync(dataHome, { recursive: true, force: true });
});

test("rewrites tool names when JSON spans network chunks", async () => {
  const event = {
    response: chunkedResponse(
      ['data: {"type":"content_block_start","content_block":{"name":"mc', 'p_URLFetch"}}\n\n'],
      { headers: { "content-type": "text/event-stream" } },
    ),
  };

  hooks["http.response"](event);

  assert.equal(
    await event.response.text(),
    'data: {"type":"content_block_start","content_block":{"name": "URLFetch"}}\n\n',
  );
});

test("rewrites non-streaming JSON across chunks and removes stale length headers", async () => {
  const event = {
    response: chunkedResponse(['{"content":[{"name":"m', 'cp_Read"}]}'], {
      headers: {
        "content-length": "999",
        "content-type": "application/json",
      },
    }),
  };

  hooks["http.response"](event);

  assert.equal(await event.response.text(), '{"content":[{"name": "Read"}]}');
  assert.equal(event.response.headers.has("content-length"), false);
});

test("cancelling a rewritten response cancels its source", async () => {
  let cancelled = false;
  const event = {
    response: chunkedResponse(["data: pending"], {
      headers: { "content-type": "text/event-stream" },
      cancel() {
        cancelled = true;
      },
    }),
  };

  hooks["http.response"](event);
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

test("token refresh failures fail the intercepted request", async () => {
  writeAuth({
    type: "oauth",
    refresh: "expired-refresh-token",
    access: "expired-access-token",
    expires: Date.now() - 1,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("invalid refresh token", { status: 401 });

  try {
    const event = {
      request: new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: "{}",
      }),
    };

    await assert.rejects(
      hooks["http.request"](event),
      /Token refresh failed: 401.*invalid refresh token/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("token refresh adopts a token rotated by another process", async () => {
  writeAuth({
    type: "oauth",
    refresh: "old-refresh-token",
    access: "expired-access-token",
    expires: Date.now() - 1,
  });
  const originalFetch = globalThis.fetch;
  const refreshTokens = [];
  globalThis.fetch = async (_url, init) => {
    const refreshToken = JSON.parse(init.body).refresh_token;
    refreshTokens.push(refreshToken);
    if (refreshTokens.length === 1) {
      writeAuth({
        type: "oauth",
        refresh: "rotated-refresh-token",
        access: "expired-rotated-access-token",
        expires: Date.now() - 1,
      });
      return new Response("old token rejected", { status: 401 });
    }
    return Response.json({
      refresh_token: "final-refresh-token",
      access_token: "fresh-access-token",
      expires_in: 3600,
    });
  };

  try {
    const event = {
      request: new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: "{}",
      }),
    };

    await hooks["http.request"](event);

    assert.deepEqual(refreshTokens, ["old-refresh-token", "rotated-refresh-token"]);
    assert.equal(event.request.headers.get("authorization"), "Bearer fresh-access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("API-key authentication is left untouched", async () => {
  writeAuth({ type: "api", key: "api-key" });
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
