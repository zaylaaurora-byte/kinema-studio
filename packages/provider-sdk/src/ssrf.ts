/**
 * SSRF guard for user-supplied provider base URLs.
 *
 * SECURITY.md is blunt about the state of this:
 *
 *   "Users may point Kinema at their own OpenAI-compatible endpoint. That means the
 *    server makes outbound requests to a user-supplied URL, which is a classic SSRF
 *    vector. Mitigations required: an allowlist/denylist for private address ranges,
 *    redirect limits, TLS validation, timeouts, and an explicit warning when a user
 *    enters a self-hosted URL. **This is not fully mitigated yet.**"
 *
 * This module implements the denylist, the scheme/port restrictions, the redirect
 * limit and the timeout *policy*, and it produces the explicit warning. It does NOT
 * claim to close the hole, for one reason worth stating plainly:
 *
 *   **Hostname checks are defeated by DNS rebinding.** Validating a hostname and then
 *   handing the same hostname to `fetch` performs two independent DNS resolutions. An
 *   attacker controlling a DNS record can answer "public IP" to our check and
 *   "127.0.0.1" to the actual request.
 *
 * Closing that requires pinning the validated IP into the connection (a custom
 * dispatcher/agent writing `lookup`), which is a transport-level change. Until that
 * lands, `guardedFetch` here is a strong reduction in exposure, not a guarantee, and
 * every call site is expected to run behind a network policy that blocks egress to
 * private ranges. The code says so rather than implying otherwise.
 *
 * A SECOND, DIFFERENT CASE: LOCAL PROVIDERS ARE LEGITIMATE.
 * Ollama on `http://localhost:11434`, ComfyUI on `:8188` and LM Studio on `:1234` are
 * first-class supported providers (see PROVIDERS.md). Blocking loopback outright would
 * break the product's headline "run it locally, free" feature. So the guard
 * distinguishes *local* (loopback/private, allowed when explicitly opted in) from
 * *link-local and cloud metadata* (never allowed, no opt-in).
 */

/** Why a URL was rejected. Used to build an actionable message. */
export type SsrfRejectionCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "blocked_address"
  | "metadata_endpoint"
  | "blocked_port"
  | "not_allowlisted";

export interface SsrfRejection {
  readonly code: SsrfRejectionCode;
  /** User-facing explanation. Never contains the raw URL's credentials. */
  readonly message: string;
}

export interface SsrfAssessment {
  readonly allowed: boolean;
  /** Present only when `allowed` is false. */
  readonly rejection?: SsrfRejection;
  /**
   * True when the target is loopback or a private range — i.e. a self-hosted
   * endpoint. The UI must show an explicit warning for these rather than treating
   * them as ordinary cloud URLs.
   */
  readonly isLocal: boolean;
  /** True when the target looks like a cloud metadata service. Always rejected. */
  readonly isMetadata: boolean;
  /** Human-readable warning to display for an allowed-but-self-hosted target. */
  readonly warning?: string;
}

export interface SsrfPolicy {
  /**
   * Allow loopback/private targets. Defaults to true because local providers are a
   * supported feature — but it is the caller's decision, and `apps/api` sets it from
   * configuration so a hosted deployment can refuse them.
   */
  readonly allowLocal?: boolean;
  /** Restrict to these hostnames. Empty/absent means "no allowlist restriction". */
  readonly allowlist?: readonly string[];
  /** Extra ports to permit beyond the scheme defaults. */
  readonly extraAllowedPorts?: readonly number[];
}

/**
 * Addresses that are never acceptable, regardless of policy.
 *
 * The first entry is the important one. `169.254.169.254` is the AWS/GCP/Azure/
 * DigitalOcean instance metadata service. On AWS it serves IAM credentials to anything
 * that can make an unauthenticated HTTP GET — including, famously, Capital One in
 * 2019. `fd00:ec2::254` is its IPv6 equivalent.
 *
 * This list is a denylist and therefore necessarily incomplete; it is a backstop for
 * the ranges that are unambiguously never a user's AI provider.
 */
const METADATA_HOSTS = new Set([
  "169.254.169.254", // AWS / GCP / Azure / DigitalOcean IMDS
  "169.254.170.2", // AWS ECS task metadata (container credential endpoint)
  "100.100.100.200", // Alibaba Cloud metadata
  "metadata.google.internal", // GCP friendly hostname
  "metadata.goog",
  "instance-data", // OpenStack
  "metadata", // generic, used by several clouds
]);

/** Link-local (169.254.0.0/16, fe80::/10) is never a real provider. */
function isLinkLocal(host: string): boolean {
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^fe80:/i.test(host)) return true;
  return false;
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  // The whole 127.0.0.0/8 block is loopback on Linux and Windows.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.endsWith(".localhost")) return true;
  return false;
}

/**
 * RFC 1918 private ranges, plus CGNAT and the IPv6 unique-local range.
 *
 * These are legitimate for a self-hosted setup on a LAN (a home server running
 * Ollama), which is why they are classified rather than blocked outright.
 */
function isPrivateRange(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 0) return true; // "this network"
    return false;
  }
  // IPv6 unique local addresses fc00::/7.
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  return false;
}

/**
 * Is this host a bare IP literal (as opposed to a DNS name)?
 *
 * Matters because `[::1]` in a URL arrives as `::1`, and because a decimal/octal/hex
 * encoded IPv4 (`http://2130706433/` == 127.0.0.1, `http://0x7f000001/`) is a classic
 * filter bypass. We normalise those before classifying.
 */
function normaliseHost(host: string): string {
  let h = host.trim().toLowerCase();

  // Strip IPv6 brackets if a caller passed the raw authority form.
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);

  // A single decimal integer is an alternate IPv4 encoding: 2130706433 -> 127.0.0.1
  if (/^\d+$/.test(h)) {
    const asNumber = Number(h);
    if (Number.isSafeInteger(asNumber) && asNumber >= 0 && asNumber <= 0xffffffff) {
      return [
        (asNumber >>> 24) & 0xff,
        (asNumber >>> 16) & 0xff,
        (asNumber >>> 8) & 0xff,
        asNumber & 0xff,
      ].join(".");
    }
  }

  // Hex form: 0x7f000001
  if (/^0x[0-9a-f]+$/.test(h)) {
    const asNumber = Number.parseInt(h.slice(2), 16);
    if (Number.isSafeInteger(asNumber) && asNumber <= 0xffffffff) {
      return [
        (asNumber >>> 24) & 0xff,
        (asNumber >>> 16) & 0xff,
        (asNumber >>> 8) & 0xff,
        asNumber & 0xff,
      ].join(".");
    }
  }

  // Dotted octal / mixed: 0177.0.0.1
  if (/^0[0-7]*\./.test(h)) {
    const parts = h.split(".");
    if (parts.length === 4 && parts.every((p) => /^0[0-7]*$/.test(p) || /^\d+$/.test(p))) {
      const nums = parts.map((p) => (p.startsWith("0") && p.length > 1 ? parseInt(p, 8) : Number(p)));
      if (nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        return nums.join(".");
      }
    }
  }

  // Trailing dot on an FQDN ("localhost." and "metadata.google.internal.") resolves
  // identically but compares differently as a string.
  if (h.endsWith(".") && h.length > 1) h = h.slice(0, -1);

  return h;
}

/** Ports that are never a legitimate provider endpoint. */
const BLOCKED_PORTS = new Set([
  22, // SSH
  23, // telnet
  25, // SMTP
  445, // SMB
  1433, // MSSQL
  1521, // Oracle
  3306, // MySQL
  3389, // RDP
  5432, // PostgreSQL
  6379, // Redis
  9200, // Elasticsearch
  11211, // memcached
  27017, // MongoDB
]);

/**
 * Assess a base URL against the SSRF policy.
 *
 * Pure and synchronous: no DNS, no network. That is a deliberate limitation — see the
 * DNS-rebinding note at the top of this file — and it means this function is trivially
 * unit-testable, which matters because it is the only thing standing between a user
 * input and an outbound request.
 */
export function assessBaseUrl(rawUrl: string, policy: SsrfPolicy = {}): SsrfAssessment {
  const allowLocal = policy.allowLocal ?? true;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      allowed: false,
      isLocal: false,
      isMetadata: false,
      rejection: {
        code: "invalid_url",
        message: "That is not a valid URL. Include the scheme, for example https://api.example.com/v1.",
      },
    };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      allowed: false,
      isLocal: false,
      isMetadata: false,
      rejection: {
        code: "unsupported_scheme",
        message: `Only http and https base URLs are supported (got "${url.protocol.replace(":", "")}").`,
      },
    };
  }

  // user:pass@host — either a typo or an attempt to smuggle a credential past logging.
  if (url.username || url.password) {
    return {
      allowed: false,
      isLocal: false,
      isMetadata: false,
      rejection: {
        code: "credentials_in_url",
        message:
          "Do not embed credentials in the base URL. Use the API key field instead, where the value is encrypted at rest.",
      },
    };
  }

  const host = normaliseHost(url.hostname);
  const isMetadata = METADATA_HOSTS.has(host);

  if (isMetadata || isLinkLocal(host)) {
    return {
      allowed: false,
      isLocal: false,
      isMetadata,
      rejection: {
        code: isMetadata ? "metadata_endpoint" : "blocked_address",
        message: isMetadata
          ? "That address is a cloud instance-metadata endpoint. Pointing a provider at it would expose the server's own cloud credentials, so it is never allowed."
          : "Link-local addresses (169.254.0.0/16) are not valid provider endpoints and are never allowed.",
      },
    };
  }

  const local = isLoopback(host) || isPrivateRange(host);

  if (local && !allowLocal) {
    return {
      allowed: false,
      isLocal: true,
      isMetadata: false,
      rejection: {
        code: "blocked_address",
        message:
          "This deployment does not allow provider endpoints on loopback or private networks. Use a public HTTPS endpoint.",
      },
    };
  }

  // Explicit allowlist, when configured.
  if (policy.allowlist && policy.allowlist.length > 0) {
    const permitted = policy.allowlist.some((entry) => {
      const allowed = normaliseHost(entry);
      return host === allowed || host.endsWith(`.${allowed}`);
    });
    if (!permitted) {
      return {
        allowed: false,
        isLocal: local,
        isMetadata: false,
        rejection: {
          code: "not_allowlisted",
          message: `"${host}" is not in this deployment's provider allowlist.`,
        },
      };
    }
  }

  // Port policy. An explicit port is honoured for local endpoints (Ollama :11434,
  // ComfyUI :8188, LM Studio :1234) but blocked on the well-known infrastructure
  // ports, which are a scan target rather than a provider.
  const explicitPort = url.port === "" ? undefined : Number(url.port);
  if (explicitPort !== undefined) {
    const extra = policy.extraAllowedPorts ?? [];
    if (BLOCKED_PORTS.has(explicitPort) && !extra.includes(explicitPort)) {
      return {
        allowed: false,
        isLocal: local,
        isMetadata: false,
        rejection: {
          code: "blocked_port",
          message: `Port ${explicitPort} is not a provider API port and is blocked.`,
        },
      };
    }
  }

  // Plaintext HTTP to a remote host. Allowed (some self-hosted gateways do it) but
  // warned about, because the API key travels in a header and would be readable.
  const insecureRemote = url.protocol === "http:" && !local;

  return {
    allowed: true,
    isLocal: local,
    isMetadata: false,
    ...(local
      ? {
          warning:
            "This is a self-hosted or local endpoint. Kinema will send requests to your own network address.",
        }
      : insecureRemote
        ? {
            warning:
              "This endpoint uses plain HTTP. Your API key will be sent unencrypted over the network.",
          }
        : {}),
  };
}

/**
 * How outbound provider requests must be made.
 *
 * Exported as a value rather than left to each call site so the policy is auditable in
 * one place: "what is our redirect limit?" has exactly one answer.
 */
export const OUTBOUND_REQUEST_POLICY = {
  /**
   * Zero redirects.
   *
   * A redirect is an SSRF bypass: `https://evil.example` may pass the hostname check
   * and then issue `302 Location: http://169.254.169.254/`. Provider APIs do not need
   * redirects, so refusing them costs nothing.
   */
  maxRedirects: 0,
  /** Anything longer than this is a hung provider holding a worker slot. */
  timeoutMs: 120_000,
  /** Validate TLS. `false` here would be a one-word security hole. */
  rejectUnauthorized: true,
} as const;

/** Reasons a guarded fetch refused to run. */
export class SsrfBlockedError extends Error {
  readonly code: SsrfRejectionCode;

  constructor(rejection: SsrfRejection) {
    super(rejection.message);
    this.name = "SsrfBlockedError";
    this.code = rejection.code;
  }
}

/**
 * Fetch a provider endpoint, refusing disallowed targets.
 *
 * This is the only sanctioned way to make an outbound request to a user-supplied base
 * URL. `fetchImpl` is injected so tests never touch the network — the same rule the
 * adapters follow.
 */
export async function guardedFetch(
  input: { readonly baseUrl: string; readonly path: string },
  policy: SsrfPolicy,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
): Promise<Response> {
  const assessment = assessBaseUrl(input.baseUrl, policy);
  if (!assessment.allowed && assessment.rejection) {
    throw new SsrfBlockedError(assessment.rejection);
  }

  const url = new URL(input.path.replace(/^\//, ""), ensureTrailingSlash(input.baseUrl));

  // A signal for the timeout. `AbortSignal.timeout` is available in Node 18+.
  //
  // THIS SIGNAL MUST COMPOSE WITH `init.signal`, NOT REPLACE IT.
  //
  // `signal: controller.signal` used to be written unconditionally, which silently
  // discarded any signal the caller passed in. That is a correctness bug with real
  // consequences: an adapter that passes the user's cancellation signal would see it
  // disappear here, so pressing Cancel would neither stop the request nor stop the
  // spend. The bug is invisible at the call site because the override happens one
  // level down, and the timeout still worked — so it only ever showed up as "cancel
  // does nothing".
  //
  // `AbortSignal.any` is the platform's own composition primitive (Node 20+); the
  // relay below is the fallback for older runtimes. Both give: abort if EITHER the
  // caller aborts or the timeout expires, which is the only correct behaviour.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OUTBOUND_REQUEST_POLICY.timeoutMs);

  const callerSignal = init.signal;
  // `null` is the DOM's "no signal"; treat it the same as undefined.
  const outwardSignal =
    callerSignal === undefined || callerSignal === null
      ? controller.signal
      : composeSignals(callerSignal, controller.signal);

  try {
    return await fetchImpl(url.toString(), {
      ...init,
      // `redirect: "error"` is how we enforce maxRedirects: 0 through fetch's own API,
      // rather than following a chain and inspecting it afterwards.
      redirect: "error",
      signal: outwardSignal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Abort when either input signal aborts, and never before.
 *
 * Prefers `AbortSignal.any` and falls back to a manual relay. The fallback registers
 * with `{ once: true }` on both inputs and removes the listeners once the combined
 * signal fires, so a long-lived caller signal does not accumulate listeners from
 * every request made with it (Node warns, and eventually leaks, otherwise).
 *
 * If an input is ALREADY aborted, the returned signal is aborted synchronously. That
 * matters: a real `fetch` rejects immediately when handed an aborted signal, and a
 * composed signal that only aborted on the next tick would let a cancelled request
 * out of the door — exactly the race this composition exists to close.
 */
function composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal })
    .any;
  if (typeof anyFn === "function") {
    return anyFn.call(AbortSignal, [a, b]);
  }

  const controller = new AbortController();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }

  const relay = (): void => {
    a.removeEventListener("abort", relay);
    b.removeEventListener("abort", relay);
    controller.abort();
  };
  a.addEventListener("abort", relay, { once: true });
  b.addEventListener("abort", relay, { once: true });

  return controller.signal;
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}