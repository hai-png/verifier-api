import { CreditCard } from "lucide-react";

/** Minimal public-site header for /docs, /changelog, and /status. Verification requires a dashboard session. */
export default function SiteNav() {
  return (
    <header className="border-b bg-card sticky top-0 z-50">
      <div className="container mx-auto px-4 max-w-5xl flex items-center justify-between h-14">
        <a href="/" className="flex items-center gap-2 font-bold text-lg">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center text-primary-foreground">
            <CreditCard className="w-4 h-4" />
          </div>
          Noveld Pay
        </a>
        <nav className="flex items-center gap-1 text-sm font-medium">
          <a href="/docs" className="px-3 py-2 rounded-md hover:bg-muted">
            Docs
          </a>
          <a href="/changelog" className="px-3 py-2 rounded-md hover:bg-muted text-muted-foreground">
            Changelog
          </a>
          <a href="/status" className="px-3 py-2 rounded-md hover:bg-muted text-muted-foreground">
            Status
          </a>
        </nav>
      </div>
    </header>
  );
}
