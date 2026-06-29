"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { PageShell } from "../../layouts/page-shell.js";
import { Button } from "../../primitives/button.js";
import { Alert } from "../../primitives/alert.js";
import { Badge } from "../../primitives/badge.js";
import { Card, CardHeader, CardTitle, CardDescription } from "../../primitives/card.js";
import { PageHeader } from "../../primitives/page-header.js";
import { LoadingState } from "../../primitives/loading-state.js";
import { useUiPaths } from "../use-page-ui.js";

type MetricInfo = {
  name: string;
  type: "counter" | "gauge";
  description: string;
};

type ObservabilityResponse = {
  countsByState: Record<string, number>;
  suppressionCount: number;
  lastWorkerRun: {
    at: string;
    claimed: number;
    sent: number;
    retried: number;
    failed: number;
    rateLimited: number;
  } | null;
  metrics: MetricInfo[];
};

type AdminObservabilityPageProps = {
  apiBase?: string;
};

export function AdminObservabilityPage({ apiBase = "/api/outpost" }: AdminObservabilityPageProps) {
  const resolved = useUiPaths();
  const [data, setData] = useState<ObservabilityResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(`${apiBase}/admin/observability`);
      if (!res.ok) throw new Error("Failed to load");
      setData(await res.json());
    } catch {
      setError("Failed to load observability data.");
    } finally {
      setIsLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageShell width="wide">
      <div className="mb-4 text-sm text-[var(--muted)]">
        <Link href={resolved.adminPanel} className="hover:underline">
          Admin
        </Link>
        <span className="mx-2">/</span>
        <span className="text-[var(--foreground)]">Observability</span>
      </div>

      <PageHeader
        title="Observability"
        description="Operational snapshot from the outbox. Export OpenTelemetry metrics to your collector for dashboards."
        action={
          <Button variant="secondary" onClick={load} disabled={isLoading}>
            {isLoading ? "Loading…" : "Refresh"}
          </Button>
        }
      />

      {error && (
        <Alert variant="danger" className="mb-4">
          {error}
        </Alert>
      )}

      {isLoading ? (
        <LoadingState label="Loading observability" />
      ) : data ? (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(data.countsByState).map(([state, count]) => (
              <Card key={state} muted>
                <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{state}</p>
                <p className="mt-1 text-2xl font-semibold">{count}</p>
              </Card>
            ))}
            <Card muted>
              <p className="text-xs uppercase tracking-wide text-[var(--muted)]">suppressions</p>
              <p className="mt-1 text-2xl font-semibold">{data.suppressionCount}</p>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Last send worker run</CardTitle>
              <CardDescription>
                Updated when an operator clicks &quot;Run send worker&quot; on the queue page or a cron invokes the worker.
              </CardDescription>
            </CardHeader>
            {data.lastWorkerRun ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                <div>
                  <p className="text-[var(--muted)]">At</p>
                  <p>{new Date(data.lastWorkerRun.at).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-[var(--muted)]">Claimed</p>
                  <p>{data.lastWorkerRun.claimed}</p>
                </div>
                <div>
                  <p className="text-[var(--muted)]">Sent</p>
                  <p>{data.lastWorkerRun.sent}</p>
                </div>
                <div>
                  <p className="text-[var(--muted)]">Retried</p>
                  <p>{data.lastWorkerRun.retried}</p>
                </div>
                <div>
                  <p className="text-[var(--muted)]">Rate limited</p>
                  <p>{data.lastWorkerRun.rateLimited}</p>
                </div>
                <div>
                  <p className="text-[var(--muted)]">Failed (DLQ)</p>
                  <p>{data.lastWorkerRun.failed}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">No worker run recorded yet.</p>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>OpenTelemetry metrics</CardTitle>
              <CardDescription>
                Emitted when `OtelTelemetry` is wired. Point your SDK exporter at these names.
              </CardDescription>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-[var(--border)] bg-[var(--card-muted)]">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-[var(--muted)]">Name</th>
                    <th className="px-4 py-2 text-left font-medium text-[var(--muted)]">Type</th>
                    <th className="px-4 py-2 text-left font-medium text-[var(--muted)]">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {data.metrics.map((m) => (
                    <tr key={m.name} className="hover:bg-[var(--card-muted)]">
                      <td className="px-4 py-3 font-mono text-xs">{m.name}</td>
                      <td className="px-4 py-3">
                        <Badge variant={m.type === "gauge" ? "info" : "default"}>{m.type}</Badge>
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">{m.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}
    </PageShell>
  );
}
