import { db } from '../data/db';
import { engagementEvents } from '../data/schema/projects';
import { logger } from './logger';
export async function auditEvent(eventType, metadata, projectId, memberId) {
    try {
        await db.insert(engagementEvents).values({
            eventType,
            ...(projectId ? { projectId } : {}),
            ...(memberId ? { memberId } : {}),
            metadata: {
                ...metadata,
                auditedAt: new Date().toISOString(),
            },
        });
    }
    catch (err) {
        logger.warn({
            msg: '[Audit] event write failed',
            eventType,
            projectId,
            memberId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
