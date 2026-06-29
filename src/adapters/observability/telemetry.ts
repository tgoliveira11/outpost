import type { Telemetry } from "../../ports/services.js";

/**
 * No-op telemetry. Used when observability is disabled. Still runs the wrapped
 * function so behavior is identical to the instrumented path.
 */
export class NoopTelemetry implements Telemetry {
  async span<T>(_name: string, _attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  counter(): void {}
  gauge(): void {}
}

/**
 * OpenTelemetry-backed telemetry (TDR §8). `@opentelemetry/api` is an OPTIONAL
 * peer dependency: this adapter imports it lazily so the package works without
 * it installed. Wire the OTel SDK (exporters, providers) in your application;
 * this adapter only emits to whatever global meter/tracer is registered.
 *
 * Usage:
 *   import { OtelTelemetry } from "@tgoliveira/outpost/adapters";
 *   const telemetry = await OtelTelemetry.create();
 */
export class OtelTelemetry implements Telemetry {
  private constructor(
    // Loosely typed to avoid a hard dependency on @opentelemetry/api types.
    private readonly tracer: any,
    private readonly counters: Map<string, any>,
    private readonly gauges: Map<string, any>,
    private readonly meter: any,
    private readonly api: any,
  ) {}

  static async create(serviceName = "outpost"): Promise<Telemetry> {
    try {
      const api = await import("@opentelemetry/api");
      const tracer = api.trace.getTracer(serviceName);
      const meter = api.metrics.getMeter(serviceName);
      return new OtelTelemetry(tracer, new Map(), new Map(), meter, api);
    } catch {
      // @opentelemetry/api not installed → degrade gracefully to no-op.
      return new NoopTelemetry();
    }
  }

  async span<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span: any) => {
      try {
        for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v as any);
        const result = await fn();
        span.setStatus({ code: this.api.SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: this.api.SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  counter(name: string, value: number, attrs?: Record<string, unknown>): void {
    let c = this.counters.get(name);
    if (!c) {
      c = this.meter.createCounter(name);
      this.counters.set(name, c);
    }
    c.add(value, attrs);
  }

  gauge(name: string, value: number, attrs?: Record<string, unknown>): void {
    // Use a counter-style observation; for true gauges wire an observable
    // gauge in your SDK. Recorded as a histogram-friendly value here.
    let g = this.gauges.get(name);
    if (!g) {
      g = this.meter.createHistogram(name);
      this.gauges.set(name, g);
    }
    g.record(value, attrs);
  }
}
