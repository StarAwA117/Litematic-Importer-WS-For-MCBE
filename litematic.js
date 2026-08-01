import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import WebSocket, { WebSocketServer } from "ws";

const LITEMATIC_DIR = "./litematic";
const PREFIX = "$";
const PORT = Number(process.argv[2]) || 8080;
const { OPEN } = WebSocket;

function splitByBytes(str, max) {
	const out = [];
	let s = 0;
	while (s < str.length) {
		let e = s + 1;
		while (e <= str.length && Buffer.byteLength(str.slice(s, e), "utf8") <= max) e++;
		out.push(str.slice(s, e - 1));
		s = e - 1;
	}
	return out;
}

function parseArgs(input) {
	const out = [];
	let cur = "", q = false;
	for (const ch of input) {
		if (ch === '"') q = !q;
		else if (ch === " " && !q) { if (cur) { out.push(cur); cur = ""; } }
		else cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

class Command {
	constructor(name, desc) {
		this.name = name;
		this.description = desc;
		this.params = [];
		this.fn = null;
	}
	add(type, opt = false) {
		this.params.push([type, opt]);
		return this;
	}
	setFn(fn) {
		this.fn = fn;
		return this;
	}
	execute(sender, text) {
		const tokens = parseArgs(text);
		if (tokens[0] !== this.name) return false;
		const args = tokens.slice(1);
		const required = this.params.filter(p => !p[1]).length;
		if (args.length < required || args.length > this.params.length) {
			return { ok: false, msg: `参数数量错误：需要 ${required}-${this.params.length} 个参数，但提供了 ${args.length} 个` };
		}
		const values = [];
		for (let i = 0; i < this.params.length; i++) {
			const [type, opt] = this.params[i];
			const raw = args[i];
			if (opt && raw === undefined) { values.push(undefined); continue; }
			if (type === "int") {
				const n = Number(raw);
				if (!Number.isInteger(n)) return { ok: false, msg: `"${raw}" 处应为整型` };
				values.push(n);
			} else if (type === "float") {
				const n = parseFloat(raw);
				if (isNaN(n)) return { ok: false, msg: `"${raw}" 处应为浮点型` };
				values.push(n);
			} else {
				values.push(raw);
			}
		}
		if (this.fn) this.fn(sender, ...values);
		return { ok: true };
	}
}
const cmd = (name, desc) => new Command(name, desc);

class Client {
	constructor(ws) {
		this.ws = ws;
		this.back = new Map();
		ws.sendCommand = this.sendCommand.bind(this);
		ws.runCommand = this.runCommand.bind(this);
		ws.tell = this.tell.bind(this);
		ws.tellAll = this.tellAll.bind(this);
		ws.getPosition = this.getPosition.bind(this);
	}
	async sendCommand(cmd) {
		if (typeof cmd !== "string" || !this.ws || this.ws.readyState !== OPEN || Buffer.byteLength(cmd, "utf8") > 461) return;
		const id = crypto.randomUUID();
		this.ws.send(JSON.stringify({
			body: { origin: { type: "player" }, commandLine: cmd, version: 17104896 },
			header: { requestId: id, messagePurpose: "commandRequest", version: 1, messageType: "commandRequest" }
		}));
	}
	runCommand(cmd) {
		return new Promise((resolve, reject) => {
			if (typeof cmd !== "string" || !this.ws || this.ws.readyState !== OPEN || Buffer.byteLength(cmd, "utf8") > 461) return reject(new Error("无效的命令"));
			const id = crypto.randomUUID();
			this.back.set(id, resolve);
			this.ws.send(JSON.stringify({
				body: { origin: { type: "player" }, commandLine: cmd, version: 17104896 },
				header: { requestId: id, messagePurpose: "commandRequest", version: 1, messageType: "commandRequest" }
			}));
		});
	}
	tell(msg, target = "@a", prefix = true) {
		for (const m of splitByBytes(msg, 300)) {
			this.sendCommand(`tellraw ${target} ${JSON.stringify({ rawtext: prefix ? [{ text: "* " }, { translate: "commands.origin.external" }, { text: " " }, { text: m }] : [{ text: m }] })}`);
		}
	}
	tellAll(msg) {
		for (const m of splitByBytes(msg, 420)) this.sendCommand(`me ${m}`);
	}
	async getPosition(target) {
		let d;
		try { d = await this.runCommand(`querytarget ${target}`); } catch { return; }
		if (!d?.body || d.body.statusCode) return;
		let det = d.body.details;
		if (typeof det === "string") { try { det = JSON.parse(det); } catch { return; } }
		const p = (Array.isArray(det) ? det[0] : det)?.position;
		return p ? { x: p.x, y: p.y, z: p.z } : null;
	}
	onMessage(data) {
		if (data?.header?.messagePurpose !== "commandResponse") return;
		const id = data.header.requestId;
		const cb = this.back.get(id);
		if (cb) { cb(data); this.back.delete(id); }
	}
}

const END = 0, BYTE = 1, SHORT = 2, INT = 3, LONG = 4, FLOAT = 5, DOUBLE = 6, BA = 7, STR = 8, LIST = 9, COMP = 10, IA = 11, LA = 12;
const MASKS = new Uint32Array(33);
for (let i = 0; i <= 32; i++) MASKS[i] = i === 32 ? 0xFFFFFFFF : (1 << i) - 1;

function parseNbt(buf) {
	let o = 0;
	const rs = () => {
		const len = buf.readUInt16BE(o);
		const s = buf.toString("utf8", o + 2, o + 2 + len);
		o += 2 + len;
		return s;
	};
	const rt = (t) => {
		switch (t) {
			case BYTE: return buf.readInt8(o++);
			case SHORT: { const v = buf.readInt16BE(o); o += 2; return v; }
			case INT: { const v = buf.readInt32BE(o); o += 4; return v; }
			case LONG: { const hi = buf.readInt32BE(o), lo = buf.readUInt32BE(o + 4); o += 8; return hi * 4294967296 + lo; }
			case FLOAT: { const v = buf.readFloatBE(o); o += 4; return v; }
			case DOUBLE: { const v = buf.readDoubleBE(o); o += 8; return v; }
			case BA: { const len = buf.readInt32BE(o); o += 4 + len; return []; }
			case STR: return rs();
			case LIST: {
				const lt = buf.readInt8(o++), len = buf.readInt32BE(o);
				o += 4;
				const arr = [];
				for (let i = 0; i < len; i++) arr.push(rt(lt));
				return arr;
			}
			case COMP: {
				const c = {};
				while (o < buf.length) {
					const t2 = buf.readInt8(o++);
					if (t2 === END) break;
					c[rs()] = rt(t2);
				}
				return c;
			}
			case IA: { const len = buf.readInt32BE(o); o += 4 + len * 4; return []; }
			case LA: { const len = buf.readInt32BE(o); const d = o + 4; o += 4 + len * 8; return { isZeroCopyLongArray: true, buffer: buf, offset: d, length: len }; }
		}
	};
	const rootType = buf.readInt8(o++);
	if (rootType === END) return {};
	rs();
	return rt(rootType);
}

function loadMappings() {
	const file = "./generator_blocks.json";
	if (!fs.existsSync(file)) throw new Error("找不到 generator_blocks.json");
	const map = new Map(), fallback = new Map();
	for (const e of JSON.parse(fs.readFileSync(file, "utf8")).mappings) {
		const j = e.java_state, b = e.bedrock_state;
		if (!j?.Name || !b) continue;
		const key = `${j.Name}::${j.Properties ? Object.keys(j.Properties).sort().map(k => `${k}=${j.Properties[k]}`).join(",") : ""}`;
		const info = { identifier: b.bedrock_identifier || j.Name, state: { ...(b.state || {}) } };
		map.set(key, info);
		if (!fallback.has(j.Name)) fallback.set(j.Name, { identifier: info.identifier, state: { ...info.state } });
	}
	for (const [n, i] of Object.entries({ "minecraft:chain": { identifier: "chain", state: {} }, "minecraft:grass": { identifier: "grass_block", state: {} } })) {
		if (!fallback.has(n)) fallback.set(n, i);
	}
	map.fallbackMap = fallback;
	return map;
}

function parseLitematic(filePath) {
	return new Promise((resolve, reject) => zlib.gunzip(fs.readFileSync(filePath), (err, unzipped) => err ? reject(err) : resolve(unzipped)))
		.then(buf => {
			const nbt = parseNbt(buf);
			const regions = nbt.Regions;
			if (!regions) throw new Error("找不到 Regions");
			const region = regions[Object.keys(regions)[0]];
			const sx = Math.abs(region.Size.x), sy = Math.abs(region.Size.y), sz = Math.abs(region.Size.z);
			const total = sx * sy * sz;
			const pal = region.BlockStatePalette;
			const palette = Array.isArray(pal) ? pal : pal.value || pal;
			const bs = region.BlockStates;
			if (!palette || !bs) throw new Error("无效的 Litematic 文件");
			const mapping = loadMappings();
			const AIR = ["minecraft:air", "minecraft:cave_air", "minecraft:void_air"];
			const proc = palette.map(node => {
				const st = node.value !== undefined ? node.value : node;
				if (!st?.Name) return null;
				const name = typeof st.Name === "string" ? st.Name : st.Name.value;
				if (AIR.includes(name)) return null;
				const props = {};
				if (st.Properties) {
					const p = st.Properties.value || st.Properties;
					for (const k in p) props[k] = p[k].value !== undefined ? p[k].value : p[k];
				}
				const key = `${name}::${Object.keys(props).sort().map(k => `${k}=${props[k]}`).join(",")}`;
				const info = mapping.get(key) || mapping.fallbackMap?.get(name);
				return info ? { identifier: info.identifier, state: info.state } : null;
			});
			const bpi = Math.max(2, Math.ceil(Math.log2(palette.length)));
			const indices = new Uint32Array(total);
			const words = new Uint32Array(bs.length * 2);
			let p = bs.offset;
			for (let i = 0; i < bs.length; i++) {
				const idx = i << 1;
				words[idx + 1] = bs.buffer.readUInt32BE(p);
				words[idx] = bs.buffer.readUInt32BE(p + 4);
				p += 8;
			}
			let bit = 0;
			for (let i = 0; i < total; i++) {
				const wi = bit >> 5, bo = bit & 31;
				const first = Math.min(bpi, 32 - bo);
				let v = (words[wi] >>> bo) & MASKS[first];
				const rest = bpi - first;
				if (rest > 0) v |= ((words[wi + 1] || 0) & MASKS[rest]) << first;
				indices[i] = v;
				bit += bpi;
			}
			const blocks = [];
			let n = 0;
			for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
				const i = indices[n++];
				const c = i < proc.length ? proc[i] : null;
				if (c) {
					const state = c.state && Object.keys(c.state).length
						? `[${Object.entries(c.state).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `"${k}"=${k.endsWith("_bit") ? (v ? "true" : "false") : typeof v === "string" ? `"${v}"` : v}`).join(",")}]`
						: "";
					blocks.push({ x, y, z, cmd: `${c.identifier.replace(/^minecraft:/, "")}${state ? " " + state : ""}` });
				}
			}
			return { sx, sy, sz, totalCoords: total, blocks };
		});
}

function mergeRects(blocks, sx, sz) {
	const cmds = [];
	const layers = {};
	for (const b of blocks) (layers[b.y] ??= []).push(b);
	for (const y in layers) {
		const grid = Array.from({ length: sz }, () => Array(sx).fill(null));
		const used = Array.from({ length: sz }, () => Array(sx).fill(false));
		for (const b of layers[y]) grid[b.z][b.x] = b.cmd;
		for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
			if (used[z][x] || !grid[z][x]) continue;
			const c = grid[z][x];
			let mx = x;
			while (mx + 1 < sx && grid[z][mx + 1] === c && !used[z][mx + 1]) mx++;
			let mz = z, ok = true;
			while (ok && mz + 1 < sz) {
				for (let tx = x; tx <= mx; tx++) if (grid[mz + 1][tx] !== c || used[mz + 1][tx]) { ok = false; break; }
				if (ok) mz++;
			}
			for (let tz = z; tz <= mz; tz++) for (let tx = x; tx <= mx; tx++) used[tz][tx] = true;
			const area = (mx - x + 1) * (mz - z + 1);
			cmds.push(area === 1
				? { type: "setblock", x, y: +y, z, cmd: c }
				: { type: "fill", x1: x, y: +y, z1: z, x2: mx, z2: mz, cmd: c, count: area });
		}
	}
	return cmds;
}

class Litematic {
	constructor(client) {
		this.client = client;
		this.pending = null;
		this.job = null;
	}
	commands() {
		const c = this.client;
		return {
			op: [
				cmd("create", "导入 Litematic 建筑投影").add("文件名").add("X", true).add("Y", true).add("Z", true)
					.setFn(async (sender, file, x, y, z) => {
						if (this.job) return c.tell("§c已有导入进程运行中，请等待完成或 $n 中断", sender);
						await this.create(file, sender, x, y, z);
					}),
				cmd("list", "查看建筑文件列表").add("页码", true)
					.setFn((sender, page) => this.listFiles(page, sender)),
				cmd("search", "搜索建筑文件").add("关键词").add("页码", true)
					.setFn((sender, kw, page) => this.searchFiles(kw, page, sender)),
				cmd("y", "确认导入操作").setFn((sender) => {
					if (!this.pending) return c.tell("§c没有待确认的导入任务", sender);
					c.tell("§a已确认，开始导入…", sender);
					this.run();
				}),
				cmd("n", "取消/中断操作").setFn((sender) => {
					if (this.job) { this.job.cancelled = true; c.tell("§c正在中断导入…", sender); }
					else if (this.pending) { this.pending = null; c.tell("§c已取消导入", sender); }
					else c.tell("§c没有进行中的操作", sender);
				}),
				cmd("author", "查看作者信息").setFn((sender) => {
					c.tell("StarAwA117", sender);
				}),
				cmd("status", "查看导入进度").setFn((sender) => {
					if (!this.job) return c.tell("§c没有进行中的导入任务", sender);
					const j = this.job;
					const el = ((Date.now() - j.startTime) / 1000).toFixed(1);
					const speed = j.phasePlaced > 0 ? Math.round(j.phasePlaced / parseFloat(el)) : 0;
					c.tellAll(
						`§f正在导入 §b${j.fileName} §7| 总进度 §e${j.total > 0 ? (j.phasePlaced / j.total * 100).toFixed(1) : "0.0"}% §7| 预计 §f${speed > 0 ? ((j.total - j.phasePlaced) / speed).toFixed(1) : "undefined"}s\n` +
						`§f阶段: §e${j.phase} §7(${j.areaIndex}/${j.areaTotal} 区域)\n` +
						`§f进度: §e${j.phaseTotal > 0 ? (j.phasePlaced / j.phaseTotal * 100).toFixed(1) : "0.0"}%§f | §e${j.phasePlaced}§f / §7${j.phaseTotal}§f 命令 | 方块 §e${j.phaseBlocksPlaced}§f / §7${j.phaseBlockTotal}§f\n` +
						`§f速度: §b${speed}§f 命令/s | §7${el}s | 预计 §f${speed > 0 ? ((j.phaseTotal - j.phasePlaced) / speed).toFixed(1) : "undefined"}s`
					);
				})
			]
		};
	}
	pageList(sender, files, header) {
		if (!fs.existsSync(LITEMATIC_DIR)) return this.client.tell("§c建筑目录不存在", sender);
		if (!files.length) return this.client.tell("§c没有找到文件", sender);
		const totalPages = Math.ceil(files.length / 5);
		const page = this.page ?? 1;
		const pn = Math.max(1, Math.min(page, totalPages));
		this.page = pn;
		const start = (pn - 1) * 5;
		const items = files.slice(start, start + 5).map((f, i) => {
			const size = fs.statSync(path.join(LITEMATIC_DIR, f)).size;
			return `§f${String(start + i + 1).padStart(2, " ")}. §b${f.replace(/\.litematic$/i, "")} §7${size < 1024 ? size + "B" : size < 1048576 ? (size / 1024).toFixed(1) + "KB" : (size / 1048576).toFixed(1) + "MB"}`;
		}).join("\n");
		this.client.tell(`${header} §7(${pn}/${totalPages}) §7共 §f${files.length} §7个\n${items}`, sender);
	}
	listFiles(page, sender) {
		this.page = page ?? 1;
		const files = fs.existsSync(LITEMATIC_DIR) ? fs.readdirSync(LITEMATIC_DIR).filter(f => f.endsWith(".litematic")).sort() : [];
		this.pageList(sender, files, "§e=== §f建筑文件列表 §e===");
	}
	searchFiles(keyword, page, sender) {
		this.page = page ?? 1;
		const files = fs.existsSync(LITEMATIC_DIR) ? fs.readdirSync(LITEMATIC_DIR).filter(f => f.endsWith(".litematic") && f.toLowerCase().includes(keyword.toLowerCase())).sort() : [];
		this.pageList(sender, files, `§e=== §f搜索结果: §b${keyword} §e===`);
	}
	async create(file, sender, x, y, z) {
		const c = this.client;
		const coords = [x, y, z].filter(v => v !== undefined && v !== null);
		if (coords.length > 0 && coords.length < 3) return c.tell("§c坐标参数不完整，需要同时提供 X Y Z 或都不提供（使用自身坐标）", sender);
		const filePath = path.join(LITEMATIC_DIR, file.endsWith(".litematic") ? file : file + ".litematic");
		if (!fs.existsSync(filePath)) return c.tell(`§c文件不存在: §f${file}`, sender);
		c.tell("§7正在解析 Litematic 文件…", sender);
		let data;
		try { data = await parseLitematic(filePath); }
		catch (e) { return c.tell(`§c解析失败: §f${e.message}`, sender); }
		let origin;
		if (coords.length === 3) origin = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
		else {
			try {
				const pos = await c.getPosition("@s");
				if (!pos) return c.tell("§c无法获取你的坐标", sender);
				origin = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
			} catch { return c.tell("§c无法获取你的坐标", sender); }
		}
		if (origin.y < -64 || origin.y + data.sy - 1 > 320) return c.tell(`§cY 轴超出限制: §f${origin.y} ~ ${origin.y + data.sy - 1} §c(允许 -64 ~ 320)`, sender);
		this.pending = { file, origin, data };
		const minX = origin.x, minY = origin.y, minZ = origin.z;
		const maxX = minX + data.sx - 1, maxY = minY + data.sy - 1, maxZ = minZ + data.sz - 1;
		const blockCount = data.blocks.length;
		const cmdCount = mergeRects(data.blocks, data.sx, data.sz).length;
		const cX = Math.floor(maxX / 16) - Math.floor(minX / 16) + 1;
		const cZ = Math.floor(maxZ / 16) - Math.floor(minZ / 16) + 1;
		const chunks = cX * cZ;
		let areas = 1;
		if (chunks > 100) areas = cZ > 100 ? Math.ceil(cZ / 100) * cX : Math.ceil(cX / Math.floor(100 / cZ));
		c.tellAll(
			`§e=== Litematic 导入预览 ===\n` +
			`§f文件: §b${file}\n` +
			`§f尺寸: §b${data.sx}§f × §b${data.sy}§f × §b${data.sz}§f = §e${data.totalCoords}§f 坐标\n` +
			`§f非空气方块: §e${blockCount}§f → §e${cmdCount}§f 条指令\n` +
			`§f区块: §e${chunks}§f 个 §7(${cX}×${cZ}) → §e${areas}§f 个区域\n` +
			`§f范围: §7(${minX}, ${minY}, ${minZ}) → (${maxX}, ${maxY}, ${maxZ})\n` +
			`§f预计耗时: §e${(areas + cmdCount) * 0.001 + 1}s\n` +
			`§f确认请发送 §a$y§f，取消请发送 §c$n`
		);
	}
	async run() {
		const { data, origin, file } = this.pending;
		this.pending = null;
		const c = this.client;
		const blocks = data.blocks, total = blocks.length;
		const { sx, sy, sz } = data;
		const rects = mergeRects(blocks, sx, sz);
		this.job = { file, total: rects.length, cancelled: false, startTime: Date.now(), blockTotal: total, phase: "准备", areaIndex: 0, areaTotal: 0, phasePlaced: 0, phaseTotal: 0, phaseBlocksPlaced: 0, phaseBlockTotal: 0 };
		const delay = ms => new Promise(r => setTimeout(r, ms));
		const cX1 = Math.floor(origin.x / 16), cZ1 = Math.floor(origin.z / 16);
		const cX2 = Math.floor((origin.x + sx - 1) / 16), cZ2 = Math.floor((origin.z + sz - 1) / 16);
		const tX = cX2 - cX1 + 1, tZ = cZ2 - cZ1 + 1;
		const areas = [];
		if (tX * tZ <= 100) areas.push({ cx1: cX1, cz1: cZ1, cx2: cX2, cz2: cZ2 });
		else if (tZ > 100) for (let cz = cZ1; cz <= cZ2; cz += 100) areas.push({ cx1: cX1, cz1: cz, cx2: cX2, cz2: Math.min(cz + 99, cZ2) });
		else {
			const mX = Math.floor(100 / tZ);
			for (let cx = cX1; cx <= cX2; cx += mX) areas.push({ cx1: cx, cz1: cZ1, cx2: Math.min(cx + mX - 1, cX2), cz2: cZ2 });
		}
		for (let i = 0; i < areas.length; i++) {
			if (this.job.cancelled) break;
			const a = areas[i];
			const x1 = a.cx1 * 16, z1 = a.cz1 * 16, x2 = (a.cx2 + 1) * 16 - 1, z2 = (a.cz2 + 1) * 16 - 1;
			Object.assign(this.job, { areaIndex: i + 1, areaTotal: areas.length, phase: "创建常加载区块", phasePlaced: 0, phaseTotal: 1, phaseBlocksPlaced: 0, phaseBlockTotal: 0 });
			await c.runCommand(`/tickingarea add ${x1} ${origin.y} ${z1} ${x2} ${origin.y + sy - 1} ${z2} litematic_${i}`);
			const fx1 = Math.max(x1, origin.x), fz1 = Math.max(z1, origin.z);
			const fx2 = Math.min(x2, origin.x + sx - 1), fz2 = Math.min(z2, origin.z + sz - 1);
			const perY = Math.floor(32767 / ((fx2 - fx1 + 1) * (fz2 - fz1 + 1)));
			Object.assign(this.job, { phase: "清除空气", phaseTotal: perY >= sy ? 1 : Math.ceil(sy / perY), phasePlaced: 0, phaseBlocksPlaced: 0, phaseBlockTotal: 0 });
			if (perY >= sy) { c.sendCommand(`/fill ${fx1} ${origin.y} ${fz1} ${fx2} ${origin.y + sy - 1} ${fz2} air`); this.job.phasePlaced = 1; }
			else for (let ys = 0; ys < sy; ys += perY) {
				if (this.job.cancelled) break;
				c.sendCommand(`/fill ${fx1} ${origin.y + ys} ${fz1} ${fx2} ${origin.y + Math.min(ys + perY - 1, sy - 1)} ${fz2} air`);
				this.job.phasePlaced++;
				await delay(1);
			}
			await delay(1000);
			const chunkRects = [];
			for (const r of rects) {
				const rx1 = r.type === "setblock" ? r.x : r.x1, rx2 = r.type === "setblock" ? r.x : r.x2;
				const rz1 = r.type === "setblock" ? r.z : r.z1, rz2 = r.type === "setblock" ? r.z : r.z2;
				const ax1 = origin.x + rx1, ax2 = origin.x + rx2, az1 = origin.z + rz1, az2 = origin.z + rz2, ay = origin.y + r.y;
				if (r.type === "setblock") {
					if (ax1 >= fx1 && ax1 <= fx2 && az1 >= fz1 && az1 <= fz2) chunkRects.push({ r, cx1: ax1, cy1: ay, cz1: az1, cx2: ax1, cy2: ay, cz2: az1 });
				} else if (ax2 >= fx1 && ax1 <= fx2 && az2 >= fz1 && az1 <= fz2) {
					const bx1 = Math.max(ax1, fx1), bz1 = Math.max(az1, fz1);
					const bx2 = Math.min(ax2, fx2), bz2 = Math.min(az2, fz2);
					chunkRects.push({ r, cx1: bx1, cy1: ay, cz1: bz1, cx2: bx2, cy2: ay, cz2: bz2, clipped: (bx2 - bx1 + 1) * (bz2 - bz1 + 1) });
				}
			}
			Object.assign(this.job, { phase: "放置方块", phaseTotal: chunkRects.length, phasePlaced: 0, phaseBlocksPlaced: 0, phaseBlockTotal: chunkRects.reduce((s, cr) => s + (cr.clipped || 1), 0) });
			for (const cr of chunkRects) {
				if (this.job.cancelled) break;
				const { r, cx1, cy1, cz1, cx2, cy2, cz2 } = cr;
				if (r.type === "setblock") c.sendCommand(`/setblock ${cx1} ${cy1} ${cz1} ${r.cmd}`);
				else c.sendCommand(`/fill ${cx1} ${cy1} ${cz1} ${cx2} ${cy2} ${cz2} ${r.cmd}`);
				this.job.phasePlaced++;
				this.job.phaseBlocksPlaced += cr.clipped || 1;
				await delay(1);
			}
			await delay(1000);
			Object.assign(this.job, { phase: "删除常加载区块", phasePlaced: 0, phaseTotal: 1, phaseBlocksPlaced: 0, phaseBlockTotal: 0 });
			await c.runCommand(`/tickingarea remove litematic_${i}`);
		}
		if (!this.job.cancelled) {
			const el = ((Date.now() - this.job.startTime) / 1000).toFixed(1);
			c.tellAll(`§aLitematic 导入完成 §7(§f${file}§7) §f共 §e${total}§f 个方块 §7${rects.length}§f 条指令 §7耗时 §f${el}s`);
		}
		this.job = null;
	}
	destroy() {
		if (this.job) this.job.cancelled = true;
		this.pending = null;
		this.job = null;
		this.client = null;
	}
}

const server = new WebSocketServer({ port: PORT });
console.log(`[Litematic] listening on ws://localhost:${PORT}`);
server.on("connection", ws => {
	const cli = new Client(ws);
	const mod = new Litematic(ws);
	const commands = mod.commands().op;
	cli.ws.send(JSON.stringify({ body: { eventName: "PlayerMessage" }, header: { requestId: crypto.randomUUID(), messagePurpose: "subscribe", version: 1, messageType: "commandRequest" } }));
	ws.on("message", msg => {
		let data;
		try { data = JSON.parse(String(msg)); } catch { return; }
		cli.onMessage(data);
		if (data?.header?.messagePurpose === "event" && data.header.eventName === "PlayerMessage") {
			const sender = data.body?.sender, text = data.body?.message, type = data.body?.type;
			if (!sender || !text || type !== "chat" || text.length >= 256 || !text.startsWith(PREFIX)) return;
			for (const c of commands) {
				const r = c.execute(sender, text.slice(1));
				if (r) {
					if (!r.ok) ws.tell(`Command §c${r.msg}`, sender);
					return;
				}
			}
			ws.tell(`§c未知的命令 ${text.split(" ")[0]}`, sender);
		}
	});
	ws.on("close", () => mod.destroy());
	ws.on("error", e => console.error("[Litematic] error:", e.message));
	ws.tellAll("§aLitematic §f已连接");
	console.log("[Litematic] client connected");
});
server.on("error", e => console.error("[Litematic] server error:", e.message));
