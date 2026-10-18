/**
 * dsh-sysproxy — follow the Windows system proxy.
 *
 * The plugin reads `HKCU\...\Internet Settings` every few seconds and installs the
 * result as the process-wide HTTP route. Installation reuses dsh's own
 * `@deepseek-ai/dsh-http-proxy` when it can be resolved, so the global dispatcher,
 * the `dsh-web-fetch-http` route and the child-process environment all agree.
 * A self-contained undici dispatcher is the fallback.
 *
 * Switch the plugin off to restore the route dsh started with.
 */
import z from "@deepseek-ai/schemastery";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const name = "dsh-sysproxy";

export const Config = z.object({
	enabled: z
		.boolean()
		.default(true)
		.volatile()
		.description("跟随 Windows 系统代理。关闭后 dsh 直连。"),
});

/** The per-user Internet Settings key that holds the system proxy. */
const REG_KEY =
	"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
/** Re-read interval. One short `reg query` per tick. */
const POLL_MS = 5000;
/** Proxy environment names restored on teardown. */
const ENV_NAMES = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
];

/** Read every value of the Internet Settings key. Returns undefined when reg.exe fails. */
function queryRegistry() {
	const result = spawnSync("reg", ["query", REG_KEY], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 5000,
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
	const values = {};
	for (const line of result.stdout.split(/\r?\n/u)) {
		const match = /^\s{2,}(\S+)\s+REG_[A-Z_]+\s+(.*)$/u.exec(line);
		if (match) values[match[1]] = match[2].trim();
	}
	return values;
}

/** Accept `host:port` and `http://host:port`; reject anything that is not an HTTP proxy. */
function normalizeProxyUrl(raw) {
	let text = (raw ?? "").trim();
	if (text === "") return undefined;
	if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) text = `http://${text}`;
	try {
		const url = new URL(text);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.hostname === "") return undefined;
		return text;
	} catch {
		return undefined;
	}
}

/**
 * Turn the registry values into a route.
 * `key` changes exactly when the route changes, so a steady system proxy costs no reinstall.
 */
function readRoute(values) {
	if (values === undefined) {
		return { key: "unreadable", reason: "读取系统代理注册表失败" };
	}
	if (values.ProxyEnable !== "0x1" && values.ProxyEnable !== "1") {
		return { key: "disabled", reason: "系统代理未开启" };
	}
	const server = values.ProxyServer;
	if (server === undefined || server === "") {
		if (values.AutoConfigURL) {
			return {
				key: `pac:${values.AutoConfigURL}`,
				reason: `系统使用 PAC 脚本 ${values.AutoConfigURL}，本插件不解析 PAC`,
			};
		}
		return { key: "empty", reason: "系统代理未填写地址" };
	}
	let httpProxy;
	let httpsProxy;
	const rejected = [];
	for (const part of server.split(";")) {
		const item = part.trim();
		if (item === "") continue;
		const equals = item.indexOf("=");
		if (equals === -1) {
			const url = normalizeProxyUrl(item);
			if (url === undefined) {
				rejected.push(item);
				continue;
			}
			httpProxy ??= url;
			httpsProxy ??= url;
			continue;
		}
		const scheme = item.slice(0, equals).trim().toLowerCase();
		const url = normalizeProxyUrl(item.slice(equals + 1));
		if (url === undefined) {
			rejected.push(item);
			continue;
		}
		if (scheme === "http") httpProxy = url;
		else if (scheme === "https") httpsProxy = url;
		else rejected.push(item);
	}
	httpsProxy ??= httpProxy;
	if (httpProxy === undefined && httpsProxy === undefined) {
		return { key: "unusable", reason: `系统代理地址不可用：${server}` };
	}
	const bypass = (values.ProxyOverride ?? "")
		.split(";")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "" && entry !== "<local>");
	const route = {
		httpProxy,
		httpsProxy,
		noProxy: bypass.join(","),
	};
	return { key: JSON.stringify(route), route, rejected };
}

/** Resolve dsh's own proxy installer, so every seam reads one policy. */
async function loadHostInstaller() {
	const entry = process.argv[1];
	if (entry === undefined) return undefined;
	try {
		const hostRequire = createRequire(entry);
		const file = hostRequire.resolve("@deepseek-ai/dsh-http-proxy");
		const module = await import(pathToFileURL(file).href);
		if (typeof module.installProxyFromEnvironment === "function") {
			return module.installProxyFromEnvironment;
		}
	} catch {
		/* fall through to the built-in dispatcher */
	}
	return undefined;
}

/** The environment shape `installProxyFromEnvironment` reads. */
function policyEnv(route) {
	const env = new Map();
	if (route.httpProxy !== undefined) env.set("http_proxy", { value: route.httpProxy });
	if (route.httpsProxy !== undefined) env.set("https_proxy", { value: route.httpsProxy });
	if (route.noProxy !== "") env.set("no_proxy", { value: route.noProxy });
	return env;
}

/** Install through dsh's own policy code: dispatcher, web-fetch route and child env in one step. */
async function installViaHost(install, route, logger) {
	const dispose = await install(policyEnv(route), (message) => logger.warn(`dsh-sysproxy: ${message}`));
	return async () => {
		await dispose();
	};
}

/** Which proxy one URL uses, or undefined for a direct connection. */
function proxyFor(route, url) {
	const proxy = url.protocol === "https:" ? route.httpsProxy : url.protocol === "http:" ? route.httpProxy : undefined;
	if (proxy === undefined) return undefined;
	const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
	if (host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./u.test(host)) return undefined;
	const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
	for (const raw of (route.noProxy ?? "").split(/[,\s]+/u)) {
		const entry = raw.trim().toLowerCase();
		if (entry === "") continue;
		if (entry === "*") return undefined;
		const colon = entry.lastIndexOf(":");
		const named = colon > 0 && entry.indexOf(":", colon + 1) === -1;
		const hostPart = named ? entry.slice(0, colon) : entry;
		if (named && entry.slice(colon + 1) !== port) continue;
		const candidate = hostPart.replace(/^\*?\./u, "");
		if (candidate !== "" && (host === candidate || host.endsWith(`.${candidate}`))) return undefined;
	}
	return proxy;
}

/** Publish the route to child processes; returns the restore function. */
function publishEnv(route) {
	const previous = {};
	for (const envName of ENV_NAMES) previous[envName] = process.env[envName];
	const values = {
		http_proxy: route.httpProxy,
		HTTP_PROXY: route.httpProxy,
		https_proxy: route.httpsProxy,
		HTTPS_PROXY: route.httpsProxy,
		no_proxy: route.noProxy === "" ? undefined : route.noProxy,
		NO_PROXY: route.noProxy === "" ? undefined : route.noProxy,
	};
	for (const [envName, value] of Object.entries(values)) {
		if (value === undefined) Reflect.deleteProperty(process.env, envName);
		else process.env[envName] = value;
	}
	return () => {
		for (const [envName, value] of Object.entries(previous)) {
			if (value === undefined) Reflect.deleteProperty(process.env, envName);
			else process.env[envName] = value;
		}
	};
}

/** Install a self-contained undici dispatcher plus the environment. */
async function installBuiltin(route) {
	const undici = await import("undici");
	const { Agent, Pool, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } = undici;
	const agent = new Agent({
		factory(origin, options) {
			const url = new URL(String(origin));
			const proxy = proxyFor(route, url);
			if (proxy !== undefined) return new ProxyAgent({ ...options, uri: proxy });
			return new Pool(origin, options);
		},
	});
	const previous = getGlobalDispatcher();
	setGlobalDispatcher(agent);
	const restoreEnv = publishEnv(route);
	return async () => {
		setGlobalDispatcher(previous);
		restoreEnv();
		await agent.close().catch(() => {});
	};
}

/** Describe a route for the log. */
function describe(route) {
	const parts = [];
	if (route.httpProxy !== undefined) parts.push(`http=${route.httpProxy}`);
	if (route.httpsProxy !== undefined && route.httpsProxy !== route.httpProxy) parts.push(`https=${route.httpsProxy}`);
	if (route.noProxy !== "") parts.push(`bypass=${route.noProxy}`);
	return parts.join(" ");
}

export function apply(ctx, config) {
	const logger = ctx.logger;
	if (process.platform !== "win32") {
		logger.info("dsh-sysproxy: 仅支持 Windows，已跳过");
		return;
	}

	let current;
	let installer;
	let stopped = false;
	let busy = false;
	let lastNote;

	const enabled = () => {
		const value = config?.enabled;
		return typeof value?.get === "function" ? value.get() !== false : value !== false;
	};

	const note = (key, message) => {
		if (key === lastNote) return;
		lastNote = key;
		logger.info(`dsh-sysproxy: ${message}`);
	};

	const clear = async () => {
		const previous = current;
		current = undefined;
		if (previous === undefined) return;
		try {
			await previous.dispose();
		} catch (error) {
			logger.warn(`dsh-sysproxy: 恢复直连失败：${error?.message ?? error}`);
		}
	};

	const resolveInstaller = async () => {
		if (installer !== undefined) return installer;
		installer = (await loadHostInstaller()) ?? null;
		if (installer === null) logger.info("dsh-sysproxy: 未找到 dsh-http-proxy，改用内置路由");
		return installer;
	};

	const sync = async () => {
		if (busy || stopped) return;
		busy = true;
		try {
			if (!enabled()) {
				await clear();
				note("off", "已关闭，dsh 直连");
				return;
			}
			const state = readRoute(queryRegistry());
			if (state.route === undefined) {
				await clear();
				note(state.key, `${state.reason}，dsh 直连`);
				return;
			}
			if (current?.key === state.key) return;
			await clear();
			const install = await resolveInstaller();
			const dispose =
				install === null
					? await installBuiltin(state.route)
					: await installViaHost(install, state.route, logger);
			current = { key: state.key, dispose };
			note(state.key, `已接入系统代理 ${describe(state.route)}`);
			if (state.rejected.length > 0) {
				logger.warn(`dsh-sysproxy: 已忽略不支持的条目 ${state.rejected.join("; ")}`);
			}
		} catch (error) {
			logger.warn(`dsh-sysproxy: ${error?.message ?? error}`);
		} finally {
			busy = false;
		}
	};

	void sync();
	const timer = setInterval(() => {
		void sync();
	}, POLL_MS);
	timer.unref?.();

	ctx.effect(
		() => () => {
			stopped = true;
			clearInterval(timer);
			void clear();
		},
		"dsh-sysproxy lifecycle",
	);
}
