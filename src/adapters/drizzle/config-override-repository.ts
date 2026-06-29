import { eq } from "drizzle-orm";
import type {
  AdminConfigOverride,
  ConfigOverrideRepository,
} from "../../modules/admin/repositories/config-override-repository.js";
import type { OutpostDb } from "./db.js";
import { adminConfigOverrides } from "./schema.js";

export class DrizzleConfigOverrideRepository implements ConfigOverrideRepository {
  constructor(private readonly db: OutpostDb) {}

  async getAll(): Promise<AdminConfigOverride[]> {
    const rows = await this.db
      .select()
      .from(adminConfigOverrides)
      .orderBy(adminConfigOverrides.key);
    return rows.map(rowToOverride);
  }

  async get(key: string): Promise<AdminConfigOverride | null> {
    const [row] = await this.db
      .select()
      .from(adminConfigOverrides)
      .where(eq(adminConfigOverrides.key, key))
      .limit(1);
    return row ? rowToOverride(row) : null;
  }

  async set(key: string, value: unknown, updatedBy: string): Promise<AdminConfigOverride> {
    const [row] = await this.db
      .insert(adminConfigOverrides)
      .values({ key, value, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: adminConfigOverrides.key,
        set: { value, updatedBy, updatedAt: new Date() },
      })
      .returning();
    return rowToOverride(row!);
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(adminConfigOverrides).where(eq(adminConfigOverrides.key, key));
  }
}

function rowToOverride(row: typeof adminConfigOverrides.$inferSelect): AdminConfigOverride {
  return {
    key: row.key,
    value: row.value,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}
