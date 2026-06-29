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
import { EmptyState } from "../../primitives/empty-state.js";
import { useUiPaths } from "../use-page-ui.js";

type MessageRow = {
  id: string;
  state: string;
  subject: string;
  provider: string;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  lastError: string | null;
};

type QueueResponse = {
  queued: MessageRow[];
  sending: MessageRow[];
  failed: MessageRow[];
  counts: Record<string, number>;
};

type AdminQueuePageProps = {
  apiBase?: string;
};

function stateBadge(state: string) {
  if (state === "queued") return <Badge variant="info">queued</Badge>;
  if (state === "sending") return <Badge variant="warning">sending</Badge>;
  if (state === "failed") return <Badge variant="danger">failed</Badge>;
  return <Badge variant="muted">{state}</Badge>;
}

function formatDate(d?: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function MessageTable({
  title,
  description,
  rows,
}: {
  title: string;
  description: string;
  rows: MessageRow[];
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {rows.length === 0 ? (
        <div className="px-6 pb-6">
          <EmptyState title="No messages" description="Nothing in this bucket right now." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--card-muted)]">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-[var(--muted)]">State</th>
                <th className="px-4 py-2 text-left font-medium text-[var(--muted)]">Subject</th>
                <th className="px-4 py-2 text-left font-medium text-[var(--muted)]">Provider</th>
                <th className="px-4 py-2 text-left font-medium text-[var(--muted)]">Attempts</th>
                <th className="px-4 py-2 text-left font-medium text-[var(--muted)]">Next attempt</th>
                <th className="px-4 py-2 text-left font-medium text-[var(--muted)]">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-[var(--card-muted)]">
                  <td className="px-4 py-3">{stateBadge(row.state)}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.subject}</div>
                    <div className="font-mono text-xs text-[var(--muted)]">{row.id}</div>
                  </td>
                  <td className="px-4 py-3">{row.provider}</td>
                  <td className="px-4 py-3">{row.attempts}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{formatDate(row.nextAttemptAt)}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{formatDate(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function AdminQueuePage({ apiBase = "/api/outpost" }: AdminQueuePageProps) {
  const resolved = useUiPaths();
  const [data, setData] = useState<QueueResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunningWorker, setIsRunningWorker] = useState(false);
  const [error, setError] = useState("");
  const [workerResult, setWorkerResult] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(`${apiBase}/admin/queue`);
      if (!res.ok) throw new Error("Failed to load");
      setData(await res.json());
    } catch {
      setError("Failed to load the email queue. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runWorker() {
    setIsRunningWorker(true);
    setError("");
    setWorkerResult("");
    try {
      const res = await fetch(`${apiBase}/admin/worker/send`, { method: "POST" });
      if (!res.ok) throw new Error("Worker run failed");
      const report = await res.json();
      setWorkerResult(
        `Worker finished: claimed ${report.claimed ?? 0} message(s).`,
      );
      await load();
    } catch {
      setError("Failed to run the send worker. Please try again.");
    } finally {
      setIsRunningWorker(false);
    }
  }

  return (
    <PageShell width="wide">
      <div className="mb-4 text-sm text-[var(--muted)]">
        <Link href={resolved.adminPanel} className="hover:underline">
          Admin
        </Link>
        <span className="mx-2">/</span>
        <span className="text-[var(--foreground)]">Email Queue</span>
      </div>

      <PageHeader
        title="Email Queue"
        description="Messages waiting to be sent. Run the send worker to process the next batch."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={load} disabled={isLoading}>
              {isLoading ? "Loading…" : "Refresh"}
            </Button>
            <Button variant="primary" onClick={runWorker} disabled={isRunningWorker}>
              {isRunningWorker ? "Running…" : "Run send worker"}
            </Button>
          </div>
        }
      />

      {error && (
        <Alert variant="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {workerResult && (
        <Alert variant="success" className="mb-4">
          {workerResult}
        </Alert>
      )}

      {isLoading ? (
        <LoadingState label="Loading queue" />
      ) : data ? (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card muted>
              <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Queued</p>
              <p className="mt-1 text-2xl font-semibold">{data.counts.queued ?? 0}</p>
            </Card>
            <Card muted>
              <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Sending</p>
              <p className="mt-1 text-2xl font-semibold">{data.counts.sending ?? 0}</p>
            </Card>
            <Card muted>
              <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Failed (DLQ)</p>
              <p className="mt-1 text-2xl font-semibold">{data.counts.failed ?? 0}</p>
            </Card>
          </div>

          <MessageTable
            title="Queued"
            description="Persisted and waiting for the send worker."
            rows={data.queued}
          />
          <MessageTable
            title="Sending"
            description="Claimed by a worker; will be reclaimed if the lease expires."
            rows={data.sending}
          />
          <MessageTable
            title="Failed"
            description="Dead-lettered after retries exhausted."
            rows={data.failed}
          />
        </div>
      ) : null}
    </PageShell>
  );
}
