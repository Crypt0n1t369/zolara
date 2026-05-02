import { db } from '../data/db';
import { engagementEvents } from '../data/schema/projects';
import { logger } from './logger';

export async function auditEvent(
  eventType: string,
  metadata: Record<string, unknown>,
  projectId?: string | null,
  memberId?: number | null
): Promise<void> {
  try {
    await db.insert(engagementEvents).values({
      eventType,
      projectId: projectId ?? null,
      memberId: memberId ?? null,
      metadata: {
        ...metadata,
        auditedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn({
      msg: '[Audit] event write failed',
      eventType,
      projectId,
      memberId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
