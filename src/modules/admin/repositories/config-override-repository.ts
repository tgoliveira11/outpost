export type AdminConfigOverride = {
  readonly key: string;
  readonly value: unknown;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
};

export interface ConfigOverrideRepository {
  getAll(): Promise<AdminConfigOverride[]>;
  get(key: string): Promise<AdminConfigOverride | null>;
  set(key: string, value: unknown, updatedBy: string): Promise<AdminConfigOverride>;
  delete(key: string): Promise<void>;
}
