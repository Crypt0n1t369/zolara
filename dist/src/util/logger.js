/**
 * Zolara Structured Logger
 *
 * All errors are logged with:
 * - error.code: short domain-prefixed code (e.g., TELEGRAM_SEND_FAILED)
 * - error.level: fatal | error | warn | info | debug
 * - error.context: { projectId?, roundId?, userId?, chatId?, ... }
 * - error.stack?: stack trace on errors
 *
 * When a SelfHealingAgent is registered via `setSelfHealingAgent()`,
 * all error-level logs are automatically ingested for autonomous healing.
 *
 * Domains:
 *   telegram  - Telegram API call failures
 *   llm       - LLM generation / parsing failures
 *   db        - Database operation failures
 *   redis     - Redis operation failures
 *   managed   - Managed Bots API failures
 *   crypto    - Encryption / decryption failures
 *   round     - Round lifecycle failures
 *   onboarding - Member onboarding failures
 *   initiation - Admin initiation flow failures
 *   reaction  - Reaction tracking failures
 *   webhook   - Webhook handling failures
 */
import pino from 'pino';
let _selfHealingAgent = null;
let _agentIngestEnabled = false;
export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    formatters: {
        level: (label) => ({ level: label }),
    },
    base: {
        service: 'zolara',
    },
});
// ── Core logging functions ─────────────────────────────────────────────────────
function buildCode(domain, suffix) {
    return `${domain.toUpperCase()}_${suffix.toUpperCase()}`;
}
function extractMessage(err) {
    if (err instanceof Error)
        return err.message;
    if (typeof err === 'string')
        return err;
    return String(err);
}
function extractStack(err) {
    if (err instanceof Error)
        return err.stack;
    return undefined;
}
/**
 * Build a full log entry.
 */
function buildLog(severity, code, domain, msg, context, err) {
    const payload = {
        code,
        domain,
        msg,
        ...(context && Object.keys(context).length > 0 ? { context } : {}),
        ...(err ? { stack: extractStack(err) } : {}),
        ts: new Date().toISOString(),
    };
    switch (severity) {
        case 'fatal':
            logger.fatal(payload);
            break;
        case 'error':
            logger.error(payload);
            break;
        case 'warn':
            logger.warn(payload);
            break;
        case 'info':
            logger.info(payload);
            break;
    }
    // Auto-ingest errors into self-healing agent (fire-and-forget)
    if ((severity === 'error' || severity === 'fatal') && _agentIngestEnabled && _selfHealingAgent) {
        _selfHealingAgent.ingest({
            code,
            domain,
            severity,
            message: msg,
            context: context,
            stack: err ? extractStack(err) : undefined,
        }).catch((ingestErr) => {
            // Don't let ingestion failures affect logging
            logger.warn({ msg: 'Self-healing ingest failed', error: String(ingestErr) });
        });
    }
}
// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Log a fatal error — process cannot continue.
 */
export function fatal(domain, suffix, msg, context, err) {
    buildLog('fatal', buildCode(domain, suffix), domain, msg, context, err);
}
/**
 * Log a non-fatal error — operation failed but system continues.
 */
export function error(domain, suffix, msg, context, err) {
    buildLog('error', buildCode(domain, suffix), domain, msg, context, err);
}
/**
 * Log a warning — something unexpected but recoverable.
 */
export function warn(domain, suffix, msg, context) {
    buildLog('warn', buildCode(domain, suffix), domain, msg, context);
}
/**
 * Log an informational event.
 */
export function info(domain, suffix, msg, context) {
    buildLog('info', buildCode(domain, suffix), domain, msg, context);
}
// ── Domain-specific helpers ─────────────────────────────────────────────────────
export const telegram = {
    sendFailed: (msg, context, err) => error('telegram', 'SEND_FAILED', msg, context, err),
    callbackFailed: (msg, context, err) => error('telegram', 'CALLBACK_FAILED', msg, context, err),
    apiError: (msg, context, err) => error('telegram', 'API_ERROR', msg, context, err),
    webhookFailed: (context, err) => error('telegram', 'WEBHOOK_FAILED', 'Webhook update handling failed', context, err),
};
export const llm = {
    generationFailed: (context, err) => error('llm', 'GENERATION_FAILED', 'LLM generation failed', context, err),
    parseFailed: (msg, context, err) => error('llm', 'PARSE_FAILED', `LLM parse failed: ${msg}`, context, err),
    apiError: (msg, context, err) => error('llm', 'API_ERROR', `LLM API error: ${msg}`, context, err),
};
export const db = {
    queryFailed: (operation, context, err) => error('db', 'QUERY_FAILED', `DB query failed: ${operation}`, context, err),
    insertFailed: (table, context, err) => error('db', 'INSERT_FAILED', `DB insert failed: ${table}`, context, err),
    updateFailed: (table, context, err) => error('db', 'UPDATE_FAILED', `DB update failed: ${table}`, context, err),
    connectionFailed: (context, err) => fatal('db', 'CONNECTION_FAILED', 'Database connection failed', context, err),
};
export const redis = {
    operationFailed: (op, context, err) => error('redis', 'OP_FAILED', `Redis operation failed: ${op}`, context, err),
    stateNotFound: (key, context) => warn('redis', 'STATE_NOT_FOUND', `Redis state not found: ${key}`, context),
};
export const managed = {
    tokenFetchFailed: (botUserId, context, err) => error('managed', 'TOKEN_FETCH_FAILED', `Failed to get bot token for ${botUserId}`, context, err),
    webhookSetupFailed: (context, err) => error('managed', 'WEBHOOK_SETUP_FAILED', 'Failed to set bot webhook', context, err),
    botInfoFailed: (botUserId, context, err) => error('managed', 'BOT_INFO_FAILED', `Failed to get bot info for ${botUserId}`, context, err),
};
export const crypto = {
    encryptFailed: (context, err) => error('crypto', 'ENCRYPT_FAILED', 'Encryption failed', context, err),
    decryptFailed: (context, err) => error('crypto', 'DECRYPT_FAILED', 'Decryption failed', context, err),
    keyNotSet: () => fatal('crypto', 'KEY_NOT_SET', 'ENCRYPTION_KEY environment variable is not set'),
};
export const round = {
    triggerFailed: (context, err) => error('round', 'TRIGGER_FAILED', 'Failed to trigger round', context, err),
    synthesisFailed: (roundId, context, err) => error('round', 'SYNTHESIS_FAILED', `Synthesis failed for round ${roundId}`, context, err),
    deadlineCheckFailed: (context, err) => error('round', 'DEADLINE_CHECK_FAILED', 'Deadline check failed', context, err),
    cancelFailed: (roundId, context, err) => error('round', 'CANCEL_FAILED', `Failed to cancel round ${roundId}`, context, err),
    stateTransitionFailed: (from, to, context, err) => error('round', 'STATE_TRANSITION_FAILED', `Failed to transition ${from} → ${to}`, context, err),
    insufficientResponses: (roundId, count, min, context) => warn('round', 'INSUFFICIENT_RESPONSES', `Round ${roundId}: ${count} responses (min ${min})`, context),
    memberUnreachable: (roundId, count, memberIds, context) => warn('round', 'MEMBER_UNREACHABLE', `Round ${roundId}: ${count} members cannot be reached (not started bot): ${memberIds}`, context),
};
export const onboarding = {
    stepFailed: (step, context, err) => error('onboarding', 'STEP_FAILED', `Onboarding step '${step}' failed`, context, err),
    joinFailed: (projectId, context, err) => error('onboarding', 'JOIN_FAILED', `Failed to join project ${projectId}`, context, err),
    finalizeFailed: (context, err) => error('onboarding', 'FINALIZE_FAILED', 'Failed to finalize onboarding', context, err),
};
export const initiation = {
    stepFailed: (step, context, err) => error('initiation', 'STEP_FAILED', `Initiation step '${step}' failed`, context, err),
    botCreationFailed: (context, err) => error('initiation', 'BOT_CREATION_FAILED', 'Bot creation failed', context, err),
};
export const reaction = {
    trackFailed: (context, err) => error('reaction', 'TRACK_FAILED', 'Failed to track reaction', context, err),
    voteUpdateFailed: (context, err) => error('reaction', 'VOTE_UPDATE_FAILED', 'Failed to update vote', context, err),
};
export const webhook = {
    invalidSecret: (chatId) => warn('webhook', 'INVALID_SECRET', 'Webhook secret mismatch', { chatId }),
    parseFailed: (context, err) => error('webhook', 'PARSE_FAILED', 'Failed to parse webhook payload', context, err),
    unhandledFailed: (context, err) => error('webhook', 'UNHANDLED_FAILED', 'Unhandled webhook error', context, err),
};
// ── Self-Healing Agent Integration ─────────────────────────────────────────────
/**
 * Register a SelfHealingAgent to receive all error-level logs automatically.
 * When set, every `error()` and `fatal()` call will be ingested into the agent
 * for autonomous diagnosis and remediation.
 */
export function setSelfHealingAgent(agent) {
    _selfHealingAgent = agent;
    _agentIngestEnabled = true;
    logger.info('Self-healing agent registered — error auto-ingestion enabled');
}
/**
 * Enable or disable self-healing agent ingestion at runtime.
 */
export function setSelfHealingIngestion(enabled) {
    _agentIngestEnabled = enabled;
    logger.info(`Self-healing ingestion ${enabled ? 'enabled' : 'disabled'}`);
}
