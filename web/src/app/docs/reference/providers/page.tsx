import { DocH, DocLead, DocH2, DocP, Next } from "@/components/Docs";

const ROWS: [string, string, string][] = [
  ["telebirr", "Telebirr receipt no", "/verify-telebirr"],
  ["cbe", "FT no (+ suffix for legacy)", "/verify-cbe"],
  ["cbebirr", "CBE Birr (+ buyer phone)", "/verify-cbebirr"],
  ["dashen", "Dashen reference", "/verify-dashen"],
  ["abyssinia", "Abyssinia reference", "/verify-abyssinia"],
  ["mpesa", "M-Pesa transaction ID", "/verify-mpesa"],
  ["awash", "Awash reference", "/verify-awash"],
  ["zemen", "Zemen reference", "/verify-zemen"],
];

export default function Providers() {
  return (
    <>
      <DocH>Providers</DocH>
      <DocLead>Eight dedicated adapters, plus OCR for every other Ethiopian bank.</DocLead>

      <div className="border rounded-md overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted text-left">
              <th className="p-2">Provider</th>
              <th className="p-2">Reference</th>
              <th className="p-2">Endpoint</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([p, ref, ep]) => (
              <tr key={p} className="border-t">
                <td className="p-2 font-mono">{p}</td>
                <td className="p-2">{ref}</td>
                <td className="p-2 font-mono text-xs">{ep}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DocH2>Beyond the eight</DocH2>
      <DocP>
        Cooperative Bank of Oromia, Amhara, Wegagen, Bunna, Enat, Lion, Berhan, Abay and the rest
        verify through <a href="/docs/verification/image" className="underline">receipt images</a>{" "}
        (Mistral Vision OCR). Prefer <code>POST /verify</code> when you don&apos;t know the
        provider — it routes automatically.
      </DocP>
      <DocH2>Ethiopian-IP note</DocH2>
      <DocP>
        Telebirr and M-Pesa block non-Ethiopian IPs; the API relays those checks through an
        Ethiopia-hosted proxy with automatic fallback relays, so integrations work from anywhere.
      </DocP>
      <Next href="/docs/reference/plans" label="Plans & limits" />
    </>
  );
}
