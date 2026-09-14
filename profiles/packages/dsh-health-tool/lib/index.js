// dsh-health-tool — 聚合健康自检（对标 Codex 的 doctor/diagnose 体验）。
// 一个工具检查关键子系统：宿主进程、监督进程（state/PID 交叉校验）、关键插件
// 注册、Mnemon CLI（真实命令）、Clash 代理、磁盘（实测字节 + 分区余量）。
//
// 设计约束：
// - 这是「本地结构/命令检查」，不消耗任何外部视觉/LLM 配额；ModLens 只确认
//   wrapper 已注册，绝不承诺其 live provider 配额或地区状态（live 未测试）。
// - 每一项结果带 status 等级 ok|info|warn|fail，输出映射为 [OK]/[INFO]/[WARN]/[FAIL]，
//   summary 区分 fail、warn、info 与“基础检查通过”。
// - 不读取/回显任何 key、命令行或环境 secret；只报告结构状态。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync, readFileSync, readdirSync, lstatSync, statfsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

export const name = 'dsh-health-tool';
export const inject = ['tools', 'llm'];

// ---- 内部状态等级：ok | info | warn | fail ----
const LEVEL = { ok: 'ok', info: 'info', warn: 'warn', fail: 'fail' };
const LEVEL_BADGE = { [LEVEL.ok]: 'OK', [LEVEL.info]: 'INFO', [LEVEL.warn]: 'WARN', [LEVEL.fail]: 'FAIL' };
const DISK_CACHE_TTL_MS = 30000; // 磁盘扫描结果缓存 30 秒

function humanBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return '未知';
	if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
	if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${Math.round(bytes)} B`;
}

function probePidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH -> 进程不存在；EPERM -> 存在但无权限（按存活处理）。
		return Boolean(error) && typeof error === 'object' && error.code === 'EPERM';
	}
}

// ---- Clash 7892 混合端口；本机代理是 DSH 访问外部服务的前提 ----
function checkProxy() {
	return new Promise((resolve) => {
		let settled = false;
		let socket;
		const settle = (result) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const cleanup = () => {
			if (!socket) return;
			socket.removeListener('connect', onConnect);
			socket.removeListener('error', onError);
			socket.removeListener('timeout', onTimeout);
			socket.destroy();
			socket = null;
		};
		const onConnect = () => settle({ name: 'proxy', status: LEVEL.ok, detail: 'Clash 127.0.0.1:7892 可达' });
		const onError = () => settle({ name: 'proxy', status: LEVEL.fail, detail: 'Clash 127.0.0.1:7892 不可达' });
		const onTimeout = () => settle({ name: 'proxy', status: LEVEL.warn, detail: 'Clash 127.0.0.1:7892 连接超时' });
		try {
			socket = net.connect(7892, '127.0.0.1');
			socket.setTimeout(2000);
			socket.once('connect', onConnect);
			socket.once('error', onError);
			socket.once('timeout', onTimeout);
		} catch (error) {
			settle({ name: 'proxy', status: LEVEL.fail, detail: `代理检查异常: ${String(error?.message ?? error)}` });
		}
	});
}

// ---- Mnemon：找 CLI，并用真实命令验证可执行（不消耗外部配额）----
function checkMnemon() {
	const candidates = [process.env.MNEMON_CLI_PATH, 'C:\\DSH\\bin\\mnemon.exe'].filter(Boolean);
	const cli = candidates.find((p) => p && existsSync(p));
	if (!cli) {
		return { name: 'mnemon', status: LEVEL.fail, detail: 'mnemon CLI 未找到（MNEMON_CLI_PATH 未配置或文件缺失）' };
	}
	try {
		const res = spawnSync(cli, ['--readonly', 'status'], {
			timeout: 10000,
			windowsHide: true,
			stdio: 'ignore', // 不捕获 stdout/stderr，避免 maxBuffer
		});
		if (res.error) {
			return { name: 'mnemon', status: LEVEL.fail, detail: `mnemon CLI 无法执行: ${String(res.error?.message ?? res.error)}` };
		}
		if (res.status === 0) {
			return { name: 'mnemon', status: LEVEL.ok, detail: 'mnemon CLI 存在且 --readonly status 退出码 0' };
		}
		if (res.signal) {
			return { name: 'mnemon', status: LEVEL.fail, detail: `mnemon CLI --readonly status 被信号终止 (${res.signal})` };
		}
		return { name: 'mnemon', status: LEVEL.fail, detail: `mnemon CLI --readonly status 退出码 ${res.status}` };
	} catch (error) {
		return { name: 'mnemon', status: LEVEL.fail, detail: `mnemon 检查异常: ${String(error?.message ?? error)}` };
	}
}

// ---- 磁盘缓存：模块级，30 秒 TTL；JS 单线程保证首次同步扫描不会并行重入 ----
let diskCache = { ts: 0, bytes: 0, files: 0, skipped: 0, rootReadable: false };
function getDiskCache(now) {
	return now - diskCache.ts <= DISK_CACHE_TTL_MS ? diskCache : null;
}

// ---- 磁盘：递归统计 ~/.dsh 普通文件真实字节 + 分区余量 ----
// 迭代遍历（避免深层递归爆栈）；使用 lstat 一次判定，符号链接 / junction 一律跳过，
// 普通文件直接累加 lstat.size（不二次 stat）；单项不可读计入 skipped，不让整体扫描崩溃。
function walkRegularBytes(root) {
	let total = 0;
	let files = 0;
	let skipped = 0;
	let rootReadable = false;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		let names;
		try {
			names = readdirSync(dir, { withFileTypes: false });
			if (dir === root) rootReadable = true;
		} catch {
			skipped++;
			if (dir === root) return { bytes: total, files, skipped, rootReadable: false };
			continue;
		}
		for (const name of names) {
			const full = join(dir, name);
			let lst;
			try {
				lst = lstatSync(full);
			} catch {
				skipped++;
				continue;
			}
			// 符号链接 / junction（Windows 将 junction 视为 symbolic link）。
			if (lst.isSymbolicLink()) {
				skipped++;
				continue;
			}
			if (lst.isDirectory()) stack.push(full);
			else if (lst.isFile()) {
				total += lst.size;
				files++;
			} else {
				skipped++; // socket/device/未知文件类型
			}
		}
	}
	return { bytes: total, files, skipped, rootReadable };
}

function checkDisk() {
	const root = join(homedir(), '.dsh');
	const now = Date.now();

	let walk;
	const cached = getDiskCache(now);
	if (cached) {
		walk = cached;
	} else {
		try {
			walk = walkRegularBytes(root);
		} catch (error) {
			return { name: 'disk', status: LEVEL.warn, detail: `~/.dsh 扫描失败: ${String(error?.message ?? error)}` };
		}
		// 根目录不可读不是成功扫描，必须 WARN 且不缓存，下次重试。
		if (!walk.rootReadable) {
			return { name: 'disk', status: LEVEL.warn, detail: '~/.dsh 根目录不存在或不可读' };
		}
		diskCache = { ts: now, bytes: walk.bytes, files: walk.files, skipped: walk.skipped, rootReadable: true };
	}

	let partDetail = '';
	let partitionReadable = true;
	try {
		const st = statfsSync(root);
		const bsize = Number(st.bsize || st.bs || 4096);
		const free = Number(st.bavail) * bsize;
		const cap = Number(st.blocks) * bsize;
		partDetail = `；分区可用 ${humanBytes(free)} / ${humanBytes(cap)}`;
	} catch {
		partitionReadable = false;
		partDetail = '；分区余量不可读';
	}

	const part = {
		name: 'disk',
		status: walk.files === 0 && !partitionReadable ? LEVEL.warn : LEVEL.ok,
		detail: `~/.dsh 实测 ${humanBytes(walk.bytes)}（${walk.files} 个普通文件）${partDetail}`,
	};
	if (walk.skipped > 0) part.detail += `；跳过不可读/符号项 ${walk.skipped} 个`;
	return part;
}

// ---- 插件 / provider 注册（只读本地注册，不消耗外部额度）----
function checkPlugins(ctx) {
	const checks = [];
	if (!ctx || !ctx.llm) {
		checks.push({ name: 'llm-providers', status: LEVEL.fail, detail: 'ctx.llm 不可用（llm 服务未注入）' });
		return checks;
	}
	try {
		const providers = typeof ctx.llm.listProviders === 'function' ? ctx.llm.listProviders() : [];
		const ids = (providers || []).map((p) => p.id);
		checks.push({ name: 'llm-providers', status: ids.length > 0 ? LEVEL.ok : LEVEL.info, detail: ids.join(', ') || '无' });
		// openai-codex：只确认“已注册”，是注册层面的检查。
		checks.push({
			name: 'openai-codex',
			status: ids.includes('openai-codex') ? LEVEL.ok : LEVEL.fail,
			detail: ids.includes('openai-codex') ? '已注册（注册检查）' : '未注册（dsh-codex-connect 可能未加载）',
		});
		// modlens：只确认 wrapper 已注册；live 配额/地区不在本检查测试，不用外部额度。
		const hasModLens = ids.some((id) => id.startsWith('modlens-') || id === 'deepseek-modlens');
		checks.push({
			name: 'modlens',
			status: hasModLens ? LEVEL.info : LEVEL.fail,
			detail: hasModLens
				? '已注册（wrapper）；live provider 配额/地区未在本检查测试'
				: '未注册（modlens 视觉 wrapper 未加载）',
		});
	} catch (error) {
		checks.push({ name: 'llm-providers', status: LEVEL.fail, detail: `provider 列表读取异常: ${String(error?.message ?? error)}` });
	}
	return checks;
}

// ---- 宿主进程 ----
function checkHost() {
	return { name: 'host', status: LEVEL.ok, detail: `宿主 PID ${process.pid}` };
}

// 把一枚生文件 PID 解析为合法整数；非法返回 null。
function parsePidFile(file) {
	try {
		const n = Number((readFileSync(file, 'utf8') || '').trim());
		return Number.isInteger(n) && n > 0 ? n : null;
	} catch {
		return null;
	}
}

// ---- 监督进程：state.supervisorPid/childPid 与 supervisor.pid/dsh.pid 交叉校验 ----
function checkSupervisor() {
	const runDir = join(
		process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
		'DeepSeekHarness',
		'run'
	);

	let state;
	try {
		state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8') || '{}');
	} catch {
		// state.json 缺失/不可读 -> FAIL。
		return { name: 'supervisor', status: LEVEL.fail, detail: 'state.json 缺失或不可读' };
	}

	// 来源 1：state.json 里的 supervisorPid / childPid。
	const supStatePid = Number.isInteger(Number(state.supervisorPid)) && Number(state.supervisorPid) > 0 ? Number(state.supervisorPid) : null;
	const childStatePid = Number.isInteger(Number(state.childPid)) && Number(state.childPid) > 0 ? Number(state.childPid) : null;
	// 来源 2：supervisor.pid / dsh.pid 文件。
	const supFilePid = parsePidFile(join(runDir, 'supervisor.pid'));
	const childFilePid = parsePidFile(join(runDir, 'dsh.pid'));

	const supStateAlive = supStatePid !== null && probePidAlive(supStatePid);
	const childStateAlive = childStatePid !== null && probePidAlive(childStatePid);
	const supFileAlive = supFilePid !== null && probePidAlive(supFilePid);
	const childFileAlive = childFilePid !== null && probePidAlive(childFilePid);

	const running = String(state.state) === 'running';
	const anyPidAlive = supStateAlive || childStateAlive || supFileAlive || childFileAlive;

	// OK 必须由 current schema 的两项 state PID 与两项 PID file 共同证明。
	const allPidsPresent = supStatePid !== null && childStatePid !== null && supFilePid !== null && childFilePid !== null;
	const allPidsAlive = supStateAlive && childStateAlive && supFileAlive && childFileAlive;
	const pidsConsistent = supStatePid === supFilePid && childStatePid === childFilePid;

	if (running && allPidsPresent && allPidsAlive && pidsConsistent) {
		return {
			name: 'supervisor',
			status: LEVEL.ok,
			detail: `state=running，PID 号存活（监督${supFilePid}、宿主${childFilePid}）`,
		};
	}
	// 任一来源非法 / 两来源不一致，但还有 PID 活着 -> WARN。
	if (anyPidAlive) {
		return {
			name: 'supervisor',
			status: LEVEL.warn,
			detail: `state=${String(state.state)}，PID 号存活（监督=${supStateAlive || supFileAlive ? '是' : '否'}，宿主=${childStateAlive || childFileAlive ? '是' : '否'}）`,
		};
	}
	// 两条 PID 都不活 / 全部来源非法 -> FAIL。
	return {
		name: 'supervisor',
		status: LEVEL.fail,
		detail: `state=${String(state.state)}，PID 号缺失/死亡（监督=${supStateAlive || supFileAlive ? '是' : '否'}，宿主=${childStateAlive || childFileAlive ? '是' : '否'}）`,
	};
}

// 归一化：未知 status 不得静默伪装 INFO/OK，一律按 FAIL 处理并计入 fail。
function normalizeStatus(result) {
	return LEVEL[result.status]
		? { ...result }
		: { ...result, status: LEVEL.fail, __badStatus: true };
}

export function apply(ctx, config = {}) {
	ctx.tools.register(defineTool({
		name: 'dsh_health_check',
		description:
			'本地健康自检：检查 DeepSeek Harness 宿主进程、监督进程（state/PID 交叉校验）、LLM provider 注册、OpenAI Codex 注册检查、modlens 视觉 wrapper 是否注册、Mnemon 记忆 CLI 是否可执行、Clash 代理、磁盘空间与 ~/.dsh 实测大小。这是本地结构/命令检查，不消耗外部视觉/LLM 额度；只提供注册与命令级状态，不承诺任何 live 配额/地区。',
		parameters: {},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: String(value) }],
		},
		async execute() {
			const results = [
				checkHost(),
				checkSupervisor(),
				...checkPlugins(ctx),
				checkMnemon(),
			];
			results.push(await checkProxy());
			results.push(checkDisk());

			// 归一化每个结果状态，未知状态一律 FAIL。
			const normalized = results.map(normalizeStatus);

			const failCount = normalized.filter((r) => r.status === LEVEL.fail).length;
			const warnCount = normalized.filter((r) => r.status === LEVEL.warn).length;
			const infoCount = normalized.filter((r) => r.status === LEVEL.info).length;
			const lines = normalized.map((r) => `- [${LEVEL_BADGE[r.status]}] ${r.name}: ${r.detail}`);

			let title;
			let summary;
			if (failCount > 0) {
				title = '异常';
				summary = `⚠️ ${failCount} 项 FAIL、${warnCount} 项 WARN — 存在异常，请按 FAIL 项进一步诊断。`;
			} else if (warnCount > 0) {
				title = '部分注意';
				summary = `ℹ️ ${warnCount} 项 WARN — 基础检查通过，但存在需要注意的状态（见上）。`;
			} else if (infoCount > 0) {
				title = '基础检查通过（含未实测项）';
				summary = `✅ 基础检查通过（结构/命令级），但有 ${infoCount} 项 INFO/未实测项，见上。`;
			} else {
				title = '基础检查通过';
				summary = '✅ 基础检查全部通过（本地结构/命令级别）。';
			}
			return [`## DSH 健康自检 ${title}`, ...lines, `\n${summary}`].join('\n');
		},
		isConcurrencySafe: () => true,
	}));
}
