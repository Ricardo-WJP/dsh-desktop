// dsh-restart-tool — agent 可调用的宿主重启工具。
//
// 主动重启只拥有一次性 handoff intent：若调用会话存在 active+armed goal，
// 同步写入 exact session/goal/revision ticket；新宿主恢复同一 session 后消费
// ticket 并调用既有 goals.resume()。普通崩溃、手工重开与无 goal 重启仍由
// dsh-goal 的 session-start disarm 默认保护。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-restart-tool';
export const inject = ['tools', 'goals'];

const TICKET_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;

function resolveLocalAppData() {
	const value = process.env.LOCALAPPDATA
		?? (process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Local') : undefined);
	if (!value) throw new Error('restart continuation requires LOCALAPPDATA or USERPROFILE');
	return value;
}

function ticketPath(sessionId) {
	const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
	return join(resolveLocalAppData(), 'DeepSeekHarness', 'run', `restart-continuation-${safe}.json`);
}

function removeTicketBestEffort(path) {
	try { rmSync(path, { force: true }); } catch { /* authorization fences below make leftovers non-consumable */ }
}

function prepareTicket(path, ticket) {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(ticket)}\n`, { encoding: 'utf8', flag: 'wx' });
		return temp;
	} catch (error) {
		removeTicketBestEffort(temp);
		throw error;
	}
}

function readTicket(path) {
	const value = JSON.parse(readFileSync(path, 'utf8'));
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('ticket payload must be an object');
	return value;
}

function validTicketShape(ticket, sessionId, now) {
	return ticket.version === TICKET_VERSION
		&& ticket.sessionId === String(sessionId)
		&& typeof ticket.goalId === 'string'
		&& ticket.goalId.length > 0
		&& Number.isSafeInteger(ticket.revision)
		&& ticket.revision > 0
		&& Number.isSafeInteger(ticket.createdAt)
		&& Number.isSafeInteger(ticket.expiresAt)
		&& ticket.createdAt <= now
		&& ticket.expiresAt > ticket.createdAt
		&& ticket.expiresAt - ticket.createdAt <= MAX_TTL_MS
		&& ticket.expiresAt > now;
}

export function apply(ctx, config = {}) {
	const delayMs = Number.isFinite(config.delayMs) && config.delayMs >= 0 ? config.delayMs : 15000;
	const continuationTtlMs = Number.isSafeInteger(config.continuationTtlMs)
		&& config.continuationTtlMs >= 30000
		&& config.continuationTtlMs <= MAX_TTL_MS
		? config.continuationTtlMs
		: DEFAULT_TTL_MS;

	ctx.on('agent/session-start', ({ agent, source }) => {
		if (source !== 'resume') return;
		const path = ticketPath(agent.id);
		if (!existsSync(path)) return;
		let ticket;
		try {
			ticket = readTicket(path);
		} catch (error) {
			removeTicketBestEffort(path);
			ctx.logger.warn(`restart continuation discarded malformed ticket for "${agent.id}": ${String(error)}`);
			return;
		}
		const now = Date.now();
		if (!validTicketShape(ticket, agent.id, now)) {
			removeTicketBestEffort(path);
			ctx.logger.info(`restart continuation discarded stale ticket for "${agent.id}"`);
			return;
		}
		let goal;
		try {
			goal = ctx.goals.get(agent);
		} catch (error) {
			ctx.logger.warn(`restart continuation could not read goal for "${agent.id}": ${String(error)}`);
			return;
		}
		const exact = goal !== undefined
			&& goal.id === ticket.goalId
			&& goal.revision === ticket.revision
			&& goal.phase === 'active'
			&& goal.activation === 'disarmed'
			&& goal.roundsStarted < goal.maxGoalRounds;
		if (!exact) {
			removeTicketBestEffort(path);
			ctx.logger.info(`restart continuation discarded non-matching ticket for "${agent.id}"`);
			return;
		}
		try {
			const resumed = ctx.goals.resume(agent, { id: goal.id, revision: goal.revision });
			removeTicketBestEffort(path);
			ctx.logger.info(`restart continuation rearmed goal "${resumed.id}" revision ${resumed.revision} for "${agent.id}"`);
		} catch (error) {
			// Keep the exact, expiring ticket for one later resume attempt. A successful
			// goals.resume() increments revision, making the old ticket non-repeatable.
			ctx.logger.warn(`restart continuation could not rearm goal for "${agent.id}": ${String(error)}`);
		}
	});

	ctx.tools.register(defineTool({
		name: 'restart_dsh',
		description:
			'重启 DeepSeek Harness 宿主进程：延迟退出后由 launcher supervisor 拉起。若当前会话有 active+armed goal，会固化一次性续跑票据，新宿主恢复同一会话后自动进入下一 goal round。',
		parameters: {},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value) }],
		},
		async execute(_args, exec) {
			let continuation = '当前没有可自动续跑的 armed goal；仅安排宿主重启。';
			const agent = exec.agent;
			if (agent) {
				const path = ticketPath(agent.id);
				const goal = ctx.goals.get(agent);
				if (goal !== undefined
					&& goal.phase === 'active'
					&& goal.activation === 'armed'
					&& goal.roundsStarted < goal.maxGoalRounds) {
					const now = Date.now();
					// A previously published ticket must be removed strictly before a new
					// restart attempt. If Windows cannot remove it, refuse the restart.
					rmSync(path, { force: true });
					let temp;
					try {
						temp = prepareTicket(path, {
							version: TICKET_VERSION,
							sessionId: String(agent.id),
							goalId: goal.id,
							revision: goal.revision,
							createdAt: now,
							expiresAt: now + continuationTtlMs,
						});
						// Fence the 15-second handoff window before publishing authorization:
						// the old goal-round driver must not queue work before process exit.
						ctx.goals.disarm(agent);
						renameSync(temp, path);
					} catch (error) {
						if (temp !== undefined) removeTicketBestEffort(temp);
						throw error;
					}
					continuation = `已固化 goal ${goal.id} revision ${goal.revision} 的一次性自动续跑票据。`;
				} else {
					// Do not let an older authorization survive a no-goal restart.
					rmSync(path, { force: true });
				}
			}
			setTimeout(() => {
				try { process.exit(0); } catch { /* already exiting */ }
			}, delayMs);
			return `重启已安排（约 ${Math.round(delayMs / 1000)} 秒后生效）。${continuation}`;
		},
		isConcurrencySafe: () => false,
	}));
}
