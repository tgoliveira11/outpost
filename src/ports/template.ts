import type { MessageBody } from "../domain/message.js";

/**
 * Template port (TDR §3.7). Resolves a template id+version and a bag of
 * variables into a concrete subject + body. Implementations MUST escape
 * user-supplied variables to prevent injection into HTML.
 *
 * Phase 1 ships a simple in-memory renderer; versioning + an admin editor are
 * Phase 2, but the port is defined now so the API shape is stable.
 */
export interface RenderedTemplate {
  readonly subject: string;
  readonly body: MessageBody;
}

export interface TemplateRenderer {
  render(input: {
    id: string;
    version?: number;
    vars: Record<string, unknown>;
  }): Promise<RenderedTemplate>;
}
