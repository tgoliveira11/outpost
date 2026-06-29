import type { TemplateRenderer, RenderedTemplate } from "../../ports/template.js";
import { ValidationError } from "../../domain/errors.js";

export interface TemplateDefinition {
  readonly id: string;
  readonly version: number;
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
}

/**
 * Minimal in-memory template renderer (TDR §3.7). Supports `{{var}}`
 * interpolation with HTML escaping of every variable to prevent injection via
 * user-supplied data. Versioning + an admin editor are Phase 2; the port
 * (`TemplateRenderer`) is the seam to swap this for a DB-backed store later.
 */
export class InMemoryTemplateRenderer implements TemplateRenderer {
  // id -> version -> definition
  private readonly templates = new Map<string, Map<number, TemplateDefinition>>();

  constructor(defs: TemplateDefinition[] = []) {
    for (const d of defs) this.register(d);
  }

  register(def: TemplateDefinition): void {
    let versions = this.templates.get(def.id);
    if (!versions) {
      versions = new Map();
      this.templates.set(def.id, versions);
    }
    versions.set(def.version, def);
  }

  async render(input: {
    id: string;
    version?: number;
    vars: Record<string, unknown>;
  }): Promise<RenderedTemplate> {
    const versions = this.templates.get(input.id);
    if (!versions) throw new ValidationError(`Unknown template "${input.id}"`);

    const version = input.version ?? Math.max(...versions.keys());
    const def = versions.get(version);
    if (!def) throw new ValidationError(`Template "${input.id}" has no version ${version}`);

    return {
      subject: interpolate(def.subject, input.vars, false),
      body: {
        html: def.html ? interpolate(def.html, input.vars, true) : undefined,
        text: def.text ? interpolate(def.text, input.vars, false) : undefined,
      },
    };
  }
}

function interpolate(template: string, vars: Record<string, unknown>, escapeHtml: boolean): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    const str = value === undefined || value === null ? "" : String(value);
    return escapeHtml ? escape(str) : str;
  });
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
