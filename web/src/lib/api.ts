/** Base URL of the verifier-api. Baked in at build time. */
export const API_URL =
  (process.env.NEXT_PUBLIC_API_URL || "https://verifier-api-selfhosted.onrender.com").replace(/\/$/, "");

const TOKEN_KEY = "nvd_token";
const WORKSPACE_KEY = "nvd_workspace_id";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export function getStoredWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(WORKSPACE_KEY);
}

export function setStoredWorkspaceId(id: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKSPACE_KEY, id);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options?.headers as Record<string, string> | undefined) ?? {}),
  };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  tier: string;
  verificationCredits: number;
  verificationCreditsMonthly: number;
  imageCredits: number;
  imageCreditsMonthly: number;
  role?: string;
}

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  role?: string;
  currentWorkspaceId?: string | null;
}

export interface MeResponse {
  success: boolean;
  user: User;
  workspaces: Workspace[];
}

export interface ApiKey {
  id: string;
  prefix: string | null;
  usageCount: number;
  lastUsed: string | null;
  isActive: boolean;
  createdAt: string;
  permissions: unknown;
}

export interface PayoutAccount {
  id: string;
  label: string;
  accountHolderName: string | null;
  type: string;
  account: string;
  providersAllowed: unknown;
  isDefault: boolean;
  createdAt: string;
}

export interface PaymentLink {
  id: string;
  name: string;
  mode: string;
  fixedAmount: number;
  acceptedProviders: unknown;
  status: string;
  redirectUrl: string | null;
  expiresAt: string | null;
  createdAt: string;
  _count?: { orders: number };
}

export interface Webhook {
  id: string;
  url: string;
  events: unknown;
  active: boolean;
  createdAt: string;
  _count?: { deliveries: number };
}

export const PROVIDERS = ["telebirr", "cbe", "cbebirr", "dashen", "abyssinia", "mpesa"] as const;
