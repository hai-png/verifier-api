import SiteNav from "@/components/SiteNav";

const SECTIONS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Start",
    links: [
      { href: "/docs", label: "Overview" },
      { href: "/docs/getting-started", label: "Getting started" },
      { href: "/docs/authentication", label: "Authentication" },
    ],
  },
  {
    title: "Verification",
    links: [
      { href: "/docs/verification", label: "Single & universal" },
      { href: "/docs/verification/batch", label: "Batch" },
      { href: "/docs/verification/image", label: "Receipt images" },
    ],
  },
  {
    title: "Commerce",
    links: [
      { href: "/docs/commerce/products", label: "Products" },
      { href: "/docs/commerce/payout-accounts", label: "Payout accounts" },
      { href: "/docs/commerce/payment-links", label: "Payment links" },
      { href: "/docs/commerce/orders", label: "Orders" },
    ],
  },
  {
    title: "Automation",
    links: [
      { href: "/docs/automation/webhooks", label: "Webhooks" },
      { href: "/docs/automation/notifications", label: "Notifications" },
    ],
  },
  {
    title: "Tools",
    links: [{ href: "/docs/tools/cbe-qr", label: "CBE receipt URLs" }],
  },
  {
    title: "Reference",
    links: [
      { href: "/docs/reference/providers", label: "Providers" },
      { href: "/docs/reference/plans", label: "Plans & limits" },
      { href: "/docs/reference/errors", label: "Errors & retries" },
    ],
  },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteNav />
      <div className="flex-1 container mx-auto px-4 max-w-6xl py-8 flex flex-col md:flex-row gap-8">
        <aside className="md:w-60 shrink-0">
          <nav className="md:sticky md:top-20 space-y-5">
            {SECTIONS.map((s) => (
              <div key={s.title}>
                <div className="text-xs font-bold uppercase text-muted-foreground mb-2">
                  {s.title}
                </div>
                <ul className="space-y-1">
                  {s.links.map((l) => (
                    <li key={l.href}>
                      <a href={l.href} className="text-sm hover:underline">
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
        <main className="flex-1 min-w-0 pb-16">{children}</main>
      </div>
    </div>
  );
}
