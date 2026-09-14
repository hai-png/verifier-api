import SiteNav from "@/components/SiteNav";
import { Markdown } from "@/components/Markdown";
import { CHANGELOG_MD } from "@/lib/changelog";

export default function ChangelogPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteNav />
      <main className="flex-1 container mx-auto px-4 max-w-3xl py-10">
        <h1 className="text-3xl font-bold mb-2">Changelog</h1>
        <p className="text-muted-foreground mb-6">
          Notable changes to the verification API and dashboard.
        </p>
        <Markdown text={CHANGELOG_MD} />
      </main>
    </div>
  );
}
