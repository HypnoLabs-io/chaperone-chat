import { describe, expect, it, vi } from "vitest";
import {
  createJevClient,
  DEFAULT_JEV_MODEL,
  isChaperoneError,
  isJevError,
  JEV_MAX_QUESTIONS,
  JevError,
  jevFingerprint,
  jevRequestBody,
  type JevQuestion,
  type JevRequest,
} from "../../src/jev";

const Q: JevQuestion = { type: "noul", instructions: "Is it a fit?", criteria: { true: "- yes", false: "- no" } };
const SECRET_TEXT = "zebra-secret-text";
const REQUEST: JevRequest = { state: { conversation: [{ from: "sender", text: SECRET_TEXT }] }, questions: { a: Q, b: Q } };

function answer(p: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    model: DEFAULT_JEV_MODEL,
    answers: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { type: "noul", noul: v }])),
    usage: { input_tokens: 640, output_tokens: 2 },
    ...extra,
  };
}

function respond(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Jev is TypeSafe's service: its network is mocked, the client itself runs for real. */
function clientWith(fetchImpl: (...args: Parameters<typeof fetch>) => Promise<Response>, options = {}) {
  const fetchMock = vi.fn(fetchImpl);
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const client = createJevClient({ apiKey: "test-key", fetch: fetchMock as typeof fetch, sleep, ...options });
  return { client, fetchMock, sleep };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("the request", () => {
  it("posts the pinned model, the state and every named question to the base URL, with the bearer key", async () => {
    const { client, fetchMock } = clientWith(async () => respond(200, answer({ a: 0.2, b: 0.8 })));
    await client.ask(REQUEST);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ model: "jev-1.13.0", state: REQUEST.state, questions: REQUEST.questions });
    expect(jevRequestBody("jev-1.13.0", REQUEST)).toEqual(body);
  });

  it("takes the model, the base URL and the key as options; a key function is read at each call", async () => {
    let key = "first";
    const { client, fetchMock } = clientWith(async () => respond(200, answer({ a: 0.1, b: 0.1 }, { model: "jev-2.0.0" })), {
      apiKey: () => key,
      model: "jev-2.0.0",
      baseUrl: "https://jev.example.test/",
    });
    expect(client.model).toBe("jev-2.0.0");
    await client.ask(REQUEST);
    key = "second";
    await client.ask(REQUEST);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init?.headers as Record<string, string>).Authorization])).toEqual([
      ["https://jev.example.test/v1/systemone", "Bearer first"],
      ["https://jev.example.test/v1/systemone", "Bearer second"],
    ]);
  });

  it("refuses an empty batch, too many questions, or a name that isn't opaque, before calling", async () => {
    const { client, fetchMock } = clientWith(async () => respond(200, answer({})));
    const many = Object.fromEntries(Array.from({ length: JEV_MAX_QUESTIONS + 1 }, (_, i) => [`q${i + 1}`, Q]));
    for (const questions of [{}, many, { "Dana Kim": Q }, { "1a": Q }]) {
      expect(await failureOf(client.ask({ state: {}, questions }))).toMatchObject({ failure: "malformed" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the answers", () => {
  it("are each question's probability by name, with the usage", async () => {
    const { client } = clientWith(async () => respond(200, answer({ b: 0.81, a: 0.12, extra: 0.5 })));
    expect(await client.ask(REQUEST)).toEqual({ p: { a: 0.12, b: 0.81 }, model: DEFAULT_JEV_MODEL, usage: { inputTokens: 640, outputTokens: 2 } });
  });

  it("leave the usage out when the response has none", async () => {
    const { client } = clientWith(async () => respond(200, answer({ a: 0.1, b: 0.3 }, { usage: undefined })));
    expect(await client.ask(REQUEST)).toEqual({ p: { a: 0.1, b: 0.3 }, model: DEFAULT_JEV_MODEL });
  });

  it.each([
    ["another model", answer({ a: 0.1, b: 0.1 }, { model: "jev-1.14.0" }), "model_mismatch"],
    ["the moving alias", answer({ a: 0.1, b: 0.1 }, { model: "jev-latest" }), "model_mismatch"],
    ["one question unanswered", answer({ a: 0.1 }), "malformed"],
    ["a string", answer({ a: "0.3", b: 0.1 }), "malformed"],
    ["above 1", answer({ a: 1.5, b: 0.1 }), "malformed"],
    ["below 0", answer({ a: -0.01, b: 0.1 }), "malformed"],
    ["the wrong type", answer({ b: 0.1 }, { answers: { a: { type: "score", score: 0.1 }, b: { type: "noul", noul: 0.1 } } }), "malformed"],
    ["not JSON", "<html>oops</html>", "malformed"],
  ])("refuses %s", async (_name, body, failure) => {
    const { client } = clientWith(async () => respond(200, body));
    expect(await failureOf(client.ask(REQUEST))).toMatchObject({ failure });
  });

  it("names the model a mismatched answer came from", async () => {
    const { client } = clientWith(async () => respond(200, answer({ a: 0.1, b: 0.1 }, { model: "jev-1.13.0-rc2" })));
    expect(await failureOf(client.ask(REQUEST))).toMatchObject({ failure: "model_mismatch", answeredModel: "jev-1.13.0-rc2" });
  });
});

describe("failures", () => {
  it("throws without calling when there is no key", async () => {
    const fetchMock = vi.fn();
    const client = createJevClient({ apiKey: () => "  ", fetch: fetchMock as unknown as typeof fetch });
    expect(await failureOf(client.ask(REQUEST))).toMatchObject({ failure: "no_key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out", async () => {
    const { client } = clientWith(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      { timeoutMs: 20 },
    );
    expect(await failureOf(client.ask(REQUEST))).toMatchObject({ failure: "timeout" });
  });

  it("names a network failure", async () => {
    const { client } = clientWith(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await failureOf(client.ask(REQUEST))).toMatchObject({ failure: "network" });
  });

  it("retries a 429 once, after Retry-After", async () => {
    const responses = [respond(429, { detail: "slow down" }, { "retry-after": "1" }), respond(200, answer({ a: 0.2, b: 0.4 }))];
    const { client, fetchMock, sleep } = clientWith(async () => responses.shift() as Response);
    expect((await client.ask(REQUEST)).p.a).toBe(0.2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("retries a 529 once after a short pause when there's no Retry-After", async () => {
    const responses = [respond(529), respond(200, answer({ a: 0.3, b: 0.4 }))];
    const { client, sleep } = clientWith(async () => responses.shift() as Response);
    expect((await client.ask(REQUEST)).p.a).toBe(0.3);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("doesn't retry past a long Retry-After, or twice", async () => {
    const long = clientWith(async () => respond(429, {}, { "retry-after": "30" }));
    expect(await failureOf(long.client.ask(REQUEST))).toMatchObject({ failure: "http", status: 429 });
    expect(long.fetchMock).toHaveBeenCalledTimes(1);
    const twice = clientWith(async () => respond(529));
    expect(await failureOf(twice.client.ask(REQUEST))).toMatchObject({ failure: "http", status: 529 });
    expect(twice.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never puts the state's text in an error", async () => {
    const outcomes = [
      clientWith(async () => respond(500, { echo: SECRET_TEXT })),
      clientWith(async () => respond(200, { model: DEFAULT_JEV_MODEL, answers: { a: { type: "noul", noul: SECRET_TEXT } } })),
      clientWith(async () => {
        throw new Error(SECRET_TEXT);
      }),
    ];
    for (const { client } of outcomes) {
      const error = await failureOf(client.ask(REQUEST));
      expect(isJevError(error)).toBe(true);
      expect(isChaperoneError(error)).toBe(true);
      expect(JSON.stringify(error) + String(error) + (error as Error).message).not.toContain(SECRET_TEXT);
    }
  });

  it("is recognised by shape, so a copy from another entry still reads as a JevError", () => {
    const foreign = Object.assign(new Error("jev_http_500"), { name: "JevError", failure: "http", status: 500 });
    expect(isJevError(foreign)).toBe(true);
    expect(isJevError(new Error("jev_http_500"))).toBe(false);
    expect(new JevError("http", 500)).toMatchObject({ code: "jev_http_500", failure: "http", status: 500 });
  });

  it("needs a key option", () => {
    let error: unknown;
    try {
      createJevClient({} as never);
    } catch (e) {
      error = e;
    }
    expect(isChaperoneError(error, "invalid_option")).toBe(true);
  });
});

describe("jevFingerprint", () => {
  it("is eight hex digits that move with the model and the value", () => {
    const a = jevFingerprint("jev-1.13.0", { q: 1 });
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(jevFingerprint("jev-1.13.0", { q: 1 })).toBe(a);
    expect(jevFingerprint("jev-1.14.0", { q: 1 })).not.toBe(a);
    expect(jevFingerprint("jev-1.13.0", { q: 2 })).not.toBe(a);
  });
});
