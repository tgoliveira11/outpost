"use client";

import Link from "next/link";
import { useUiPaths } from "../use-page-ui.js";
import { PageShell } from "../../layouts/page-shell.js";
import { Card, CardHeader, CardTitle, CardDescription } from "../../primitives/card.js";
import type { OutpostPaths } from "../types.js";

type AdminPanelPageProps = {
  paths?: OutpostPaths;
};

const SECTIONS = [
  {
    key: "adminQueue",
    label: "Email Queue",
    description: "Inspect queued messages and run the send worker manually.",
    suffix: "/queue",
  },
  {
    key: "adminConfig",
    label: "Configuration",
    description: "View and override vault/env settings. Admin overrides win over env.local.",
    suffix: "/config",
  },
  {
    key: "adminObservability",
    label: "Observability",
    description: "Queue depth, worker activity, and OpenTelemetry metric catalog.",
    suffix: "/observability",
  },
] as const;

export function AdminPanelPage({ paths }: AdminPanelPageProps) {
  const resolved = useUiPaths(paths);
  const base = resolved.adminPanel;

  return (
    <PageShell width="wide">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Outpost Admin</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Operate the transactional email outbox — queue, configuration, and observability.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((section) => (
          <Link key={section.key} href={`${base}${section.suffix}`} className="block">
            <Card className="h-full cursor-pointer transition-shadow hover:shadow-md">
              <CardHeader>
                <CardTitle className="text-base">{section.label}</CardTitle>
                <CardDescription className="text-sm">{section.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </PageShell>
  );
}
