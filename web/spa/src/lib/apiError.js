// Structured fetch failure, thrown by the JSON-returning API helpers
// (apiGet/apiSend/localGet in ./api.js) on any non-ok response or network
// failure. Carries enough detail (method, url, status, body) to build a
// diagnostics bundle, and lets an uncaught rejection be told apart from any
// other kind of error — see lib/fatalError.js for what happens to one that
// nobody catches.
export class ApiError extends Error {
  constructor(method, url, status, statusText, body) {
    super(
      status == null
        ? `${method} ${url} -> network error${statusText ? `: ${statusText}` : ""}`
        : `${method} ${url} -> ${status}`,
    );
    this.name = "ApiError";
    this.method = method;
    this.url = url;
    this.status = status;
    this.statusText = statusText || "";
    this.body = body || "";
  }
}
