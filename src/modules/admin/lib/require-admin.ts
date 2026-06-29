export class AdminDisabledError extends Error {
  constructor() {
    super("Outpost admin panel is disabled");
    this.name = "AdminDisabledError";
  }
}

export class AdminForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "AdminForbiddenError";
  }
}

export type AdminActor = {
  readonly actor: string;
};

export type RequireAdminFn = (request: Request) => Promise<AdminActor>;

export async function requireAdmin(
  enabled: boolean,
  requireAdminFn: RequireAdminFn,
  request: Request,
): Promise<AdminActor> {
  if (!enabled) throw new AdminDisabledError();
  return requireAdminFn(request);
}
