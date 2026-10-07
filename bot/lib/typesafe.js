import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// TypeSafe System One client for shadow checks: typed judgments (yes/no
// probabilities, scores) from https://api.typesafe.ai. The key comes from the
// TYPESAFE_API_KEY environment variable and is never written anywhere. The
// model is pinned so a TypeSafe release cannot quietly change past answers;
// move it on purpose and expect new disagreements.

export const TYPESAFE_MODEL = "jev-1.13.0";
export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

// Node's own fetch ignores HTTPS_PROXY. The cloud routine needs the proxy: it
// is what puts the real credential on requests to api.typesafe.ai (the key in
// the environment there is a placeholder), so a request sent direct is refused
// with 401. When HTTPS_PROXY (or https_proxy) is set, requests go through the
// undici package's fetch with its proxy agent, which honours HTTPS_PROXY and
// NO_PROXY. Node's fetch cannot take that agent (the bundled undici is an
// older major), so the package's own fetch is used with it. With no proxy
// variable, the request is exactly as before: Node's fetch, direct.
let proxyAgent = null;
export async function proxyTransport(env = process.env) {
  const proxy = env.HTTPS_PROXY || env.https_proxy;
  if (!proxy) return null;
  let undici;
  try {
    undici = await import("undici");
  } catch (error) {
    throw new Error(`HTTPS_PROXY is set but the undici package is not installed (run npm install in the pricing repo): ${error.message}`);
  }
  if (proxyAgent?.proxy !== proxy) proxyAgent = { proxy, agent: new undici.EnvHttpProxyAgent() };
  return { fetch: undici.fetch, dispatcher: proxyAgent.agent };
}

// One request: { state, questions } -> { model, answers, usage }.
export async function systemOne({ state, questions, model = TYPESAFE_MODEL, apiKey = process.env.TYPESAFE_API_KEY, fetchImpl }) {
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const proxy = await proxyTransport();
  const request = fetchImpl || proxy?.fetch || globalThis.fetch;
  for (let attempt = 1; ; attempt++) {
    const response = await request(TYPESAFE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state, questions }),
      ...(proxy ? { dispatcher: proxy.dispatcher } : {}),
    }).catch((error) => {
      // fetch says only "fetch failed"; the cause names the proxy or network reason.
      throw new Error(`TypeSafe request failed: ${error.cause?.message || error.message}`);
    });
    if (response.ok) return response.json();
    const retry = response.status === 429 || response.status >= 500;
    if (!retry || attempt >= 4) throw new Error(`TypeSafe ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const wait = Number(response.headers?.get?.("retry-after")) * 1000 || 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

// Answers saved by the exact text judged, the questions and the model, so a
// rerun gives the same answer and only new or changed text is sent.
export function cacheKey({ state, questions, model = TYPESAFE_MODEL }) {
  return crypto.createHash("sha256").update(JSON.stringify({ model, state, questions })).digest("hex");
}

export function readCache(file) {
  if (!file || !fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cache, null, 1)}\n`);
}

// Judge many states with the same questions, a few requests at a time.
// Returns one { answers, cached } per state, or { error } when a call failed.
export async function judgeAll({ states, questions, cache, model = TYPESAFE_MODEL, concurrency = 8, ask = systemOne }) {
  const results = new Array(states.length);
  let next = 0;
  let tokens = 0;
  const worker = async () => {
    while (next < states.length) {
      const index = next++;
      const state = states[index];
      const key = cacheKey({ state, questions, model });
      if (cache[key]) {
        results[index] = { answers: cache[key].answers, cached: true };
        continue;
      }
      try {
        const reply = await ask({ state, questions, model });
        cache[key] = { model: reply.model, at: new Date().toISOString(), answers: reply.answers };
        tokens += reply.usage?.input_tokens || 0;
        results[index] = { answers: reply.answers, cached: false };
      } catch (error) {
        results[index] = { error: error.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, states.length) }, worker));
  return { results, tokens };
}

// The most likely Score level (0-based), from its probabilities.
export function topLevel(answer) {
  const entries = Object.entries(answer?.probabilities || {});
  if (!entries.length) return null;
  return Number(entries.sort((a, b) => b[1] - a[1])[0][0]);
}
