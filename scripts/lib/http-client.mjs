export class HttpError extends Error {
  constructor(message, response, body) {
    super(message);
    this.name = "HttpError";
    this.response = response;
    this.body = body;
  }
}

export class CookieClient {
  #cookies = new Map();

  constructor(baseUrl, { timeoutMs = 10_000, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(path, init = {}) {
    const headers = new Headers(init.headers);
    if (this.#cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.#cookies]
          .map(([name, value]) => `${name}=${value}`)
          .join("; "),
      );
    }
    const method = init.method?.toUpperCase() ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      headers.set("origin", this.baseUrl);
    }
    // Both ceilings, not either/or. Callers pass a run-wide deadline, and
    // `?? ` meant that deadline *replaced* the per-request timeout — so a single
    // hung request could consume the whole budget, and the report blamed the
    // check rather than naming the call. One 292s request inside a 300s staging
    // smoke is what that looked like (DISCREPANCIES.md, 2026-09-15).
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(new URL(path, `${this.baseUrl}/`), {
        ...init,
        headers,
        signal,
      });
    } catch (error) {
      // A bare "The operation was aborted due to timeout" says nothing about
      // which call stalled, and the check wrapper only knows the check's name.
      // Name the request here, where the method and path are in hand.
      const cause = error instanceof Error ? error.message : String(error);
      const failure = new Error(
        `${method} ${path} failed after ${this.timeoutMs}ms at most: ${cause}`,
      );
      failure.cause = error;
      throw failure;
    }
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const value of setCookies) {
      const pair = value.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) {
        const name = pair.slice(0, separator);
        const cookieValue = pair.slice(separator + 1);
        if (cookieValue === "") this.#cookies.delete(name);
        else this.#cookies.set(name, cookieValue);
      }
    }
    return response;
  }

  async json(path, init = {}) {
    const headers = new Headers(init.headers);
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    const response = await this.request(path, {
      ...init,
      headers,
      body:
        init.body === undefined || typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body),
    });
    const text = await response.text();
    let body;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    return { response, body };
  }
}

export function detail(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text || "empty response").replace(/\s+/g, " ").slice(0, 300);
}
