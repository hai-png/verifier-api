import type { ReactNode } from "react";
import { API_BASE } from "@/lib/config";

/**
 * The origin every curl example on the docs site is written against.
 *
 * This was a hardcoded literal for one deployment. On the `selfhosted` branch
 * that meant a fork's own documentation told its readers to send their API key to
 * somebody else's server — the same defect as the dashboard's build-time default,
 * in a place nobody would think to look. It now follows the configured origin, and
 * falls back to an obvious placeholder rather than to a real host: an example that
 * reads `https://your-api.example.com` gets corrected, whereas one that reads a
 * working domain gets run.
 */
export const API_HOST = API_BASE || "https://your-api.example.com";

export function DocH({ children }: { children: ReactNode }) {
  return <h1 className="text-3xl font-bold mb-3">{children}</h1>;
}

export function DocLead({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground mb-8 text-lg">{children}</p>;
}

export function DocH2({ children }: { children: ReactNode }) {
  return <h2 className="text-xl font-semibold mt-8 mb-3">{children}</h2>;
}

export function DocP({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-6 mb-3">{children}</p>;
}

export function Code({ code }: { code: string }) {
  return (
    <pre className="bg-muted rounded-md p-4 overflow-auto text-xs mb-4 whitespace-pre-wrap break-words">
      {code}
    </pre>
  );
}

export function Endpoint({
  method,
  path,
  desc,
}: {
  method: string;
  path: string;
  desc: string;
}) {
  const color =
    method === "GET"
      ? "bg-green-600"
      : method === "POST"
        ? "bg-blue-600"
        : method === "DELETE"
          ? "bg-red-600"
          : "bg-amber-600";
  return (
    <div className="border rounded-md p-3 mb-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs font-bold text-white px-2 py-0.5 rounded ${color}`}>{method}</span>
        <code className="text-xs font-mono">{path}</code>
      </div>
      <p className="text-sm text-muted-foreground mt-1">{desc}</p>
    </div>
  );
}

export function Next({ href, label }: { href: string; label: string }) {
  return (
    <p className="text-sm mt-8">
      <a href={href} className="underline hover:text-foreground font-medium">
        Next: {label} →
      </a>
    </p>
  );
}
