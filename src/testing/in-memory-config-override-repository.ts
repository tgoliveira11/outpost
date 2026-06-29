import type { AdminConfigOverride, ConfigOverrideRepository } from "../modules/admin/repositories/config-override-repository.js";

export class InMemoryConfigOverrideRepository implements ConfigOverrideRepository {
  private readonly rows = new Map<string, AdminConfigOverride>();

  async getAll(): Promise<AdminConfigOverride[]> {
    return [...this.rows.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  async get(key: string): Promise<AdminConfigOverride | null> {
    return this.rows.get(key) ?? null;
  }

  async set(key: string, value: unknown, updatedBy: string): Promise<AdminConfigOverride> {
    const row: AdminConfigOverride = {
      key,
      value,
      updatedBy,
      updatedAt: new Date(),
    };
    this.rows.set(key, row);
    return row;
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }
}
