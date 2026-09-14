import { Fragment } from "react";

/** Minimal markdown renderer: ## / ### headings, - bullets (1 nesting level), > quotes, --- rules, `code`, **bold**. */
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: string[] | null = null;
  let sub: string[] | null = null;
  let key = 0;

  const flush = () => {
    if (list) {
      blocks.push(
        <ul key={key++} className="list-disc ml-5 mb-3 text-sm space-y-1">
          {list.map((item, i) => (
            <li key={i}>
              <Inline t={item} />
              {sub && i === list!.length - 1 && (
                <ul className="list-disc ml-5 mt-1 space-y-1">
                  {sub.map((s, j) => (
                    <li key={j}>
                      <Inline t={s} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      );
      list = null;
      sub = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("## ")) {
      flush();
      blocks.push(
        <h2 key={key++} className="text-2xl font-bold mt-8 mb-3">
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith("### ")) {
      flush();
      blocks.push(
        <h3 key={key++} className="text-lg font-semibold mt-6 mb-2">
          {line.slice(4)}
        </h3>
      );
    } else if (line.startsWith("> ")) {
      flush();
      blocks.push(
        <blockquote key={key++} className="border-l-2 pl-3 text-sm text-muted-foreground mb-3">
          <Inline t={line.slice(2)} />
        </blockquote>
      );
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flush();
      blocks.push(<hr key={key++} className="my-6" />);
    } else if (/^(\s{2,}-|\t+-)/.test(raw) && list) {
      sub = sub ?? [];
      sub.push(raw.replace(/^(\s{2,}|\t+)-/, "").trim());
    } else if (/^- /.test(line)) {
      if (!list) list = [];
      else if (sub) {
        // previous sub belongs to prior item rendering; keep simple: merge
      }
      list.push(line.slice(2));
    } else if (line.trim() === "") {
      flush();
    } else {
      flush();
      blocks.push(
        <p key={key++} className="text-sm leading-6 mb-3">
          <Inline t={line} />
        </p>
      );
    }
  }
  flush();
  return <>{blocks}</>;
}

function Inline({ t }: { t: string }) {
  const parts = t.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
          return (
            <code key={i} className="bg-muted px-1 rounded text-[13px]">
              {p.slice(1, -1)}
            </code>
          );
        }
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
          return <strong key={i}>{p.slice(2, -2)}</strong>;
        }
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}
