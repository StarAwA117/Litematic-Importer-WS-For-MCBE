// Author: StarAwA117 & Hydrooxygen
// Litematic Importer WS For MCBE
// 通过 WebSocket 将 Litematica 建筑投影导入 Minecraft 基岩版
//
//   命令（游戏内聊天栏或运行脚本的终端中均可使用）：
//   $help       查看所有命令
//   $create     导入建筑投影（支持裁剪底部空气层）
//   $preview    粒子边框 + 实体标记预览建筑位置
//   $unpreview  清除建筑预览
//   $export     导出为 .mcstructure 结构文件
//   $list/$search 浏览建筑文件
//   $y/$n       确认 / 取消导入
//   $status     查看导入进度
//   $author     作者信息
//   注：每条命令的详细用法、参数与 trim/raw 模式说明
//       统一维护在下方 COMMAND_DEFS 表中，$help 输出自动读取。
//
//   终端操作：提示符 litematic>，输入 exit 退出；
//   需要游戏连接的操作自动委托给当前活跃的 WebSocket 连接。

import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import readline from "readline"; // 终端交互（在终端中直接执行命令）
import WebSocket, { WebSocketServer } from "ws";

const LITEMATIC_DIR = "./litematic"; // litematic 文件存放目录
const PREFIX = "$"; // 游戏内命令前缀
const PORT = Number(process.argv[2]) || 8080; // 端口号，可通过命令行参数指定
const { OPEN } = WebSocket; // WebSocket 连接状态常量

// ==================== 命令帮助信息表 is here ====================
// help指令格式: $help [命令名(可选)]
const COMMAND_DEFS = {
	help: { desc: "查看命令用法", params: [["命令名", true, "要查看的命令名，可以留空列出全部命令用法"]] },
	create: {
		desc: "导入 Litematic 文件建筑投影",
		params: [
			["文件名", false, "litematic 文件名"],
			["X", true, "放置点 X 坐标（留空使用玩家位置）"],
			["Y", true, "放置点 Y 坐标"],
			["Z", true, "放置点 Z 坐标"],
			["模式", true, "trim=裁剪底部空气对齐地面(默认), raw=保留原始高度偏移"]
		]
	},
	preview: {
		desc: "预览建筑位置与轮廓",
		params: [
			["投影文件名", false, "litematic"],
			["X", true, "放置点 X 坐标（留空使用玩家位置）"],
			["Y", true, "放置点 Y 坐标"],
			["Z", true, "放置点 Z 坐标"],
			["模式", true, "trim=裁剪底部空气对齐地面(默认), raw=保留原始高度偏移"]
		]
	},
	unpreview: { desc: "清除建筑预览", params: [] },
	export: {
		desc: "导出为MCBE结构方块文件 (.mcstructure)",
		params: [
			["文件名", false, "投影文件名"],
			["导出名", true, "导出文件名（留空则与源文件同名）"],
			["模式", true, "trim=裁剪底部空气(默认推荐), raw=保留原始高度偏移"]
		]
	},
	list: { desc: "查看建筑文件列表", params: [["页码", true, "页码（每页 5 个，默认第 1 页）"]] },
	search: { desc: "搜索建筑文件", params: [["关键词", false, "搜索关键词（不区分大小写）"], ["页码", true, "页码（默认第 1 页）"]] },
	y: { desc: "确认导入", params: [] },
	n: { desc: "取消/中断导入", params: [] },
	author: { desc: "查看作者信息", params: [] },
	status: { desc: "查看导入进度", params: [] }
};

// 将长字符串按字节数分割成多个小段
// 原因: 游戏聊天栏 / 命令对单条消息长度有限制，超长消息需要分段发送
function splitByBytes(str, max) {
	const out = [];
	let s = 0;
	while (s < str.length) {
		let e = s + 1;
		// 逐字符扩展直到达到字节数上限
		while (e <= str.length && Buffer.byteLength(str.slice(s, e), "utf8") <= max) e++;
		out.push(str.slice(s, e - 1));
		s = e - 1;
	}
	return out;
}

// 解析命令行参数（类似 shell 分词）
// 支持双引号包裹带空格的参数: $create "my house"
function parseArgs(input) {
	const out = [];
	let cur = "", q = false; // q 标记当前是否在双引号内
	for (const ch of input) {
		if (ch === '"') q = !q;
		else if (ch === " " && !q) { if (cur) { out.push(cur); cur = ""; } }
		else cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

// Command 类: 声明式命令系统
// 用法: cmd("名字", "描述").add("参数类型", 是否可选).setFn(处理函数)
class Command {
	constructor(name, desc) {
		this.name = name;
		this.description = desc;
		this.params = []; // 参数定义列表: [[类型, 是否可选], ...]
		this.fn = null;
	}
	// 添加参数定义，返回 this 支持链式调用
	// type: 参数名（"文件名"/"X"/"模式"等）；opt: 是否可选；desc: 参数说明（用于 $help）
	add(type, opt = false, desc = "") {
		this.params.push([type, opt, desc]);
		return this;
	}
	// 设置命令处理函数
	setFn(fn) {
		this.fn = fn;
		return this;
	}
	// 执行命令: 解析参数 → 类型校验 → 调用处理函数
	execute(sender, text) {
		const tokens = parseArgs(text);
		if (tokens[0] !== this.name) return false; // 不是本命令
		const args = tokens.slice(1);
		const required = this.params.filter(p => !p[1]).length; // 必选参数个数
		if (args.length < required || args.length > this.params.length) {
			return { ok: false, msg: `参数数量错误：需要 ${required}-${this.params.length} 个参数，但提供了 ${args.length} 个` };
		}
		const values = [];
		// 按类型转换并校验每个参数
		for (let i = 0; i < this.params.length; i++) {
			const [type, opt] = this.params[i];
			const raw = args[i];
			if (opt && raw === undefined) { values.push(undefined); continue; } // 可选参数缺省
			if (type === "int") {
				const n = Number(raw);
				if (!Number.isInteger(n)) return { ok: false, msg: `"${raw}" 处应为整型` };
				values.push(n);
			} else if (type === "float") {
				const n = parseFloat(raw);
				if (isNaN(n)) return { ok: false, msg: `"${raw}" 处应为浮点型` };
				values.push(n);
			} else {
				values.push(raw); // 默认按字符串处理
			}
		}
		if (this.fn) this.fn(sender, ...values);
		return { ok: true };
	}
	// 生成用法字符串: $name <必选参数> [可选参数]
	// 例: create <文件名> [X] [Y] [Z] [模式]
	usage() {
		const parts = this.params.map(([type, opt]) => {
			const inner = type; // 参数名即类型说明（"文件名"/"X"/"模式"等）
			return opt ? `[${inner}]` : `<${inner}>`;
		});
		return `$${this.name} ${parts.join(" ")}`.trim();
	}
	// 生成参数类型的中文说明（用于详细帮助）
	static typeName(type) {
		if (type === "int") return "整数";
		if (type === "float") return "小数";
		return "文本";
	}
	// 生成参数详情行列表（用于详细帮助）
	paramDetail() {
		return this.params.map(([type, opt, desc]) => {
			const bracket = opt ? "可选" : "必选";
			const typeInfo = Command.typeName(type);
			let line = `§f<${type}> §7(${bracket}${typeInfo !== "文本" ? `, ${typeInfo}` : ""})`;
			if (desc) line += ` §f- §7${desc}`; // 追加参数说明（如模式的可选值）
			return line;
		});
	}
}
const cmd = (name, desc) => new Command(name, desc); // 快捷创建命令

// 从 COMMAND_DEFS 帮助信息表创建命令外壳（描述 + 参数定义，不含处理函数）
// 用法: defCmd("create").setFn(...)  — 帮助内容统一在文件头部维护
function defCmd(name) {
	const def = COMMAND_DEFS[name];
	if (!def) throw new Error(`命令帮助表缺少定义: ${name}`);
	const cm = cmd(name, def.desc);
	for (const [pname, opt, pdesc] of def.params) cm.add(pname, opt, pdesc);
	return cm;
}

// Client 类: 封装与游戏客户端的 WebSocket 通信
// 发送基岩版命令协议包，并支持异步等待命令响应
class Client {
	constructor(ws) {
		this.ws = ws;
		this.back = new Map(); // 请求 ID → Promise resolve 回调（用于 runCommand 等待响应）
		ws.sendCommand = this.sendCommand.bind(this);
		ws.runCommand = this.runCommand.bind(this);
		ws.tell = this.tell.bind(this);
		ws.tellAll = this.tellAll.bind(this);
		ws.getPosition = this.getPosition.bind(this);
	}
	// 发送游戏命令（fire-and-forget，不等待响应）
	// 注意: 基岩版命令最大长度为 461 字节，超出则丢弃
	async sendCommand(cmd) {
		if (typeof cmd !== "string" || !this.ws || this.ws.readyState !== OPEN || Buffer.byteLength(cmd, "utf8") > 461) return;
		const id = crypto.randomUUID();
		this.ws.send(JSON.stringify({
			body: { origin: { type: "player" }, commandLine: cmd, version: 17104896 },
			header: { requestId: id, messagePurpose: "commandRequest", version: 1, messageType: "commandRequest" }
		}));
	}
	// 发送游戏命令并等待响应（用于需要返回值的命令，如 querytarget）
	runCommand(cmd) {
		return new Promise((resolve, reject) => {
			if (typeof cmd !== "string" || !this.ws || this.ws.readyState !== OPEN || Buffer.byteLength(cmd, "utf8") > 461) return reject(new Error("无效的命令"));
			const id = crypto.randomUUID();
			this.back.set(id, resolve); // 登记回调，onMessage 收到响应时触发
			this.ws.send(JSON.stringify({
				body: { origin: { type: "player" }, commandLine: cmd, version: 17104896 },
				header: { requestId: id, messagePurpose: "commandRequest", version: 1, messageType: "commandRequest" }
			}));
		});
	}
	// 向指定玩家（默认所有玩家）发送消息，使用 tellraw 支持颜色代码
	// 自动按 300 字节分段
	tell(msg, target = "@a", prefix = true) {
		for (const m of splitByBytes(msg, 300)) {
			this.sendCommand(`tellraw ${target} ${JSON.stringify({ rawtext: prefix ? [{ text: "* " }, { translate: "commands.origin.external" }, { text: " " }, { text: m }] : [{ text: m }] })}`);
		}
	}
	// 通过 /me 广播消息（所有人可见，显示为玩家动作）
	tellAll(msg) {
		for (const m of splitByBytes(msg, 420)) this.sendCommand(`me ${m}`);
	}
	// 查询实体的坐标（使用 querytarget 命令）
	// 返回 {x, y, z} 或 null
	async getPosition(target) {
		let d;
		try { d = await this.runCommand(`querytarget ${target}`); } catch { return; }
		if (!d?.body || d.body.statusCode) return;
		let det = d.body.details;
		if (typeof det === "string") { try { det = JSON.parse(det); } catch { return; } }
		const p = (Array.isArray(det) ? det[0] : det)?.position;
		return p ? { x: p.x, y: p.y, z: p.z } : null;
	}
	// 处理收到的消息：匹配 runCommand 登记的回调
	onMessage(data) {
		if (data?.header?.messagePurpose !== "commandResponse") return;
		const id = data.header.requestId;
		const cb = this.back.get(id);
		if (cb) { cb(data); this.back.delete(id); }
	}
}

// ---- NBT 解析（Named Binary Tag，Java 版 litematic 使用大端序） ----
// NBT 类型标签（Tag ID）
const END = 0, BYTE = 1, SHORT = 2, INT = 3, LONG = 4, FLOAT = 5, DOUBLE = 6, BA = 7, STR = 8, LIST = 9, COMP = 10, IA = 11, LA = 12;
// 位掩码表: MASKS[i] = 低 i 位全 1（用于从位数组提取 palette 索引）
const MASKS = new Uint32Array(33);
for (let i = 0; i <= 32; i++) MASKS[i] = i === 32 ? 0xFFFFFFFF : (1 << i) - 1;

// 解析 NBT 二进制数据（Big-endian），返回 JavaScript 对象
// 说明: 字节数组(BA)/整数数组(IA)直接跳过不解析内容，长整型数组(LA)零拷贝保留原始 buffer
function parseNbt(buf) {
	let o = 0; // 当前读取偏移
	// 读取字符串: 2 字节长度前缀 + UTF-8 内容
	const rs = () => {
		const len = buf.readUInt16BE(o);
		const s = buf.toString("utf8", o + 2, o + 2 + len);
		o += 2 + len;
		return s;
	};
	// 递归读取一个指定类型的值
	const rt = (t) => {
		switch (t) {
			case BYTE: return buf.readInt8(o++);
			case SHORT: { const v = buf.readInt16BE(o); o += 2; return v; }
			case INT: { const v = buf.readInt32BE(o); o += 4; return v; }
			case LONG: { const hi = buf.readInt32BE(o), lo = buf.readUInt32BE(o + 4); o += 8; return hi * 4294967296 + lo; } // 高32位×2^32 + 低32位
			case FLOAT: { const v = buf.readFloatBE(o); o += 4; return v; }
			case DOUBLE: { const v = buf.readDoubleBE(o); o += 8; return v; }
			case BA: { const len = buf.readInt32BE(o); o += 4 + len; return []; } // 字节数组，跳过
			case STR: return rs();
			case LIST: { // 列表: 1 字节元素类型 + 4 字节长度 + 元素
				const lt = buf.readInt8(o++), len = buf.readInt32BE(o);
				o += 4;
				const arr = [];
				for (let i = 0; i < len; i++) arr.push(rt(lt));
				return arr;
			}
			case COMP: { // 复合标签: 键值对直到 END 标记
				const c = {};
				while (o < buf.length) {
					const t2 = buf.readInt8(o++);
					if (t2 === END) break;
					c[rs()] = rt(t2);
				}
				return c;
			}
			case IA: { const len = buf.readInt32BE(o); o += 4 + len * 4; return []; } // 整数数组，跳过
			case LA: { const len = buf.readInt32BE(o); const d = o + 4; o += 4 + len * 8; return { isZeroCopyLongArray: true, buffer: buf, offset: d, length: len }; } // 长整型数组: 零拷贝引用原始 buffer
		}
	};
	// 根标签: 1 字节类型 + 根名称 + 内容
	const rootType = buf.readInt8(o++);
	if (rootType === END) return {};
	rs(); // 跳过根名称
	return rt(rootType);
}

// 加载 Java → Bedrock 方块映射表（generator_blocks.json）
// 返回 Map: 键为 "java方块名::属性键值对"（排序），值为 { identifier, state }
// 同时维护 fallbackMap: 仅按方块名（不带属性）的兜底映射
function loadMappings() {
	const file = "./generator_blocks.json";
	if (!fs.existsSync(file)) throw new Error("找不到 generator_blocks.json");
	const map = new Map(), fallback = new Map();
	for (const e of JSON.parse(fs.readFileSync(file, "utf8")).mappings) {
		const j = e.java_state, b = e.bedrock_state;
		if (!j?.Name || !b) continue;
		// 构造精确匹配键: 属性按名称排序后拼接
		const key = `${j.Name}::${j.Properties ? Object.keys(j.Properties).sort().map(k => `${k}=${j.Properties[k]}`).join(",") : ""}`;
		const info = { identifier: b.bedrock_identifier || j.Name, state: { ...(b.state || {}) } };
		map.set(key, info);
		// 每个方块名只记录第一个出现（无属性）的兜底映射
		if (!fallback.has(j.Name)) fallback.set(j.Name, { identifier: info.identifier, state: { ...info.state } });
	}
	// 补充两个特殊方块的手动映射（Java 名 → Bedrock 名）
	for (const [n, i] of Object.entries({ "minecraft:chain": { identifier: "chain", state: {} }, "minecraft:grass": { identifier: "grass_block", state: {} } })) {
		if (!fallback.has(n)) fallback.set(n, i);
	}
	map.fallbackMap = fallback;
	return map;
}

// 解析 .litematic 文件（gzip 压缩的 NBT）为建筑数据
// 返回: { sx, sy, sz, totalCoords, blocks, minY, maxY }
//   blocks: [{ x, y, z, identifier, state, cmd }] 其中 cmd 为可直接执行的基岩版命令片段
//   minY/maxY: 非空气方块的实际 Y 范围（用于裁剪底部空气层）
function parseLitematic(filePath) {
	// 第一步: 解压 gzip
	return new Promise((resolve, reject) => zlib.gunzip(fs.readFileSync(filePath), (err, unzipped) => err ? reject(err) : resolve(unzipped)))
		.then(buf => {
			// 第二步: 解析 NBT 结构
			const nbt = parseNbt(buf);
			const regions = nbt.Regions;
			if (!regions) throw new Error("找不到 Regions");
			const region = regions[Object.keys(regions)[0]]; // 只处理第一个区域
			// 区域尺寸（可能为负，表示翻转，取绝对值）
			const sx = Math.abs(region.Size.x), sy = Math.abs(region.Size.y), sz = Math.abs(region.Size.z);
			const total = sx * sy * sz; // 区域总格子数
			// 方块状态调色板（palette）与位压缩存储的方块索引
			const pal = region.BlockStatePalette;
			const palette = Array.isArray(pal) ? pal : pal.value || pal;
			const bs = region.BlockStates;
			if (!palette || !bs) throw new Error("无效的 Litematic 文件");
			const mapping = loadMappings();
			const AIR = ["minecraft:air", "minecraft:cave_air", "minecraft:void_air"];
			// 第三步: 将 palette 中每个 Java 方块状态映射为 Bedrock 方块
			// proc[i] = { identifier, state } 或 null（空气/无法映射）
			const proc = palette.map(node => {
				const st = node.value !== undefined ? node.value : node;
				if (!st?.Name) return null;
				const name = typeof st.Name === "string" ? st.Name : st.Name.value;
				if (AIR.includes(name)) return null; // 空气方块 → null
				// 提取方块属性
				const props = {};
				if (st.Properties) {
					const p = st.Properties.value || st.Properties;
					for (const k in p) props[k] = p[k].value !== undefined ? p[k].value : p[k];
				}
				// 精确匹配（带属性）→ 兜底匹配（仅方块名）
				const key = `${name}::${Object.keys(props).sort().map(k => `${k}=${props[k]}`).join(",")}`;
				const info = mapping.get(key) || mapping.fallbackMap?.get(name);
				return info ? { identifier: info.identifier, state: info.state } : null;
			});
			// 第四步: 从位压缩数据解出每个格子的 palette 索引
			// 每个索引占 bpi 位（最少 2 位），按位连续存储在大端 64 位字中
			const bpi = Math.max(2, Math.ceil(Math.log2(palette.length)));
			const indices = new Uint32Array(total);
			// 将字节流转为 32 位大端字数组
			const words = new Uint32Array(bs.length * 2);
			let p = bs.offset;
			for (let i = 0; i < bs.length; i++) {
				const idx = i << 1;
				words[idx + 1] = bs.buffer.readUInt32BE(p);
				words[idx] = bs.buffer.readUInt32BE(p + 4);
				p += 8;
			}
			// 按位提取索引（可能跨 32 位字边界）
			let bit = 0;
			for (let i = 0; i < total; i++) {
				const wi = bit >> 5, bo = bit & 31; // 所在字索引与字内偏移
				const first = Math.min(bpi, 32 - bo); // 当前字内能取到的位数
				let v = (words[wi] >>> bo) & MASKS[first];
				const rest = bpi - first; // 跨到下个字的位数
				if (rest > 0) v |= ((words[wi + 1] || 0) & MASKS[rest]) << first;
				indices[i] = v;
				bit += bpi;
			}
			// 第五步: 遍历所有格子，收集非空气方块（x 变化最快）
			const blocks = [];
			let n = 0, minY = Infinity, maxY = -Infinity;
			for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
				const i = indices[n++];
				const c = i < proc.length ? proc[i] : null;
				if (c) {
					// 记录实际方块 Y 范围（用于空气层裁剪）
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
					// 生成命令参数部分: 如 "stone" 或 'oak_planks ["axis"="y"]'
					// 布尔属性（*_bit 结尾）转成 true/false，其余按类型输出
					const state = c.state && Object.keys(c.state).length
						? `[${Object.entries(c.state).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `"${k}"=${k.endsWith("_bit") ? (v ? "true" : "false") : typeof v === "string" ? `"${v}"` : v}`).join(",")}]`
						: "";
					blocks.push({
						x, y, z,
						identifier: c.identifier, // Bedrock 完整标识符（如 minecraft:stone）
						state: c.state || {}, // 方块状态对象
						cmd: `${c.identifier.replace(/^minecraft:/, "")}${state ? " " + state : ""}` // 命令片段
					});
				}
			}
			return {
				sx, sy, sz, totalCoords: total, blocks,
				minY: minY === Infinity ? 0 : minY,
				maxY: maxY === -Infinity ? sy - 1 : maxY
			};
		});
}

// 裁剪底部空气层：将建筑最低的非空气方块对齐到 Y=0（对应放置点地面）
// 裁剪底部空气层：将建筑最低的非空气方块对齐到 Y=0（对应放置点地面）
// 效果: 建筑不再悬空，且不会在清除空气阶段挖掉放置点下方地形
function trimAir(data) {
	const off = data.minY; // 底部空气层数 = 最低非空气方块的高度
	data.trimmedAir = off; // 记录裁剪量（用于预览信息显示）
	if (off > 0) {
		for (const b of data.blocks) b.y -= off; // 所有方块下移
		data.sy = data.maxY - off + 1; // 重新计算有效高度
		data.totalCoords = data.sx * data.sy * data.sz;
	}
	return data;
}

// ---- .mcstructure 生成 (Little-endian NBT, 未压缩) ----
// .mcstructure 是基岩版结构方块文件格式，可在游戏内用结构方块预览/放置
// NBT 类型标签（小端序）
const T_BYTE = 1, T_INT = 3, T_STRING = 8, T_LIST = 9, T_COMPOUND = 10;
// NBT 节点构造器: nt(类型, 值)，便于统一序列化
const nt = (t, v) => ({ t, v });
const nByte = v => nt(T_BYTE, v);
const nInt = v => nt(T_INT, v);
const nStr = v => nt(T_STRING, v);
const nList = (elemType, v) => nt(T_LIST, { elemType, v });
const nComp = v => nt(T_COMPOUND, v);

// 小端序字符串: 2 字节长度前缀（LE）+ UTF-8 内容
function leString(s) {
	const b = Buffer.from(s, "utf8");
	const h = Buffer.alloc(2);
	h.writeUInt16LE(b.length);
	return Buffer.concat([h, b]);
}

// 将 NBT 节点序列化为二进制（不含类型标签与名称，供嵌套调用）
function nbtPayload(n) {
	switch (n.t) {
		case T_BYTE: return Buffer.from([n.v & 0xFF]);
		case T_INT: { const b = Buffer.alloc(4); b.writeInt32LE(n.v); return b; }
		case T_STRING: return leString(n.v);
		case T_LIST: { // 列表: 1 字节元素类型 + 4 字节长度 + 元素内容
			const parts = [];
			for (const item of n.v.v) parts.push(nbtPayload(item));
			const head = Buffer.alloc(5);
			head[0] = n.v.elemType;
			head.writeInt32LE(n.v.v.length, 1);
			return Buffer.concat([head, ...parts]);
		}
		case T_COMPOUND: { // 复合: 依次为 [类型][名称][内容]... 以 END(0) 结尾
			const parts = [];
			for (const k in n.v) {
				const child = n.v[k];
				parts.push(Buffer.from([child.t]));
				parts.push(leString(k));
				parts.push(nbtPayload(child));
			}
			parts.push(Buffer.from([0]));
			return Buffer.concat(parts);
		}
	}
	throw new Error(`不支持的 NBT 类型: ${n.t}`);
}

// NBT 根标签: [根类型][根名称][内容]
function nbtRoot(name, node) {
	return Buffer.concat([Buffer.from([node.t]), leString(name), nbtPayload(node)]);
}

// 构建 .mcstructure 文件内容
// 说明: block_indices 按 ZYX 顺序（z 变化最快），-1 表示该位置留空
//   palette 去重后生成 block_palette，索引写入两层 block_indices（第二层用于覆盖方块，这里留空）
function buildMcStructure(data) {
	const { sx, sy, sz } = data;
	// 收集去重后的方块调色板
	const palette = [];
	const indexMap = new Map();
	for (const b of data.blocks) {
		if (!indexMap.has(b.cmd)) { indexMap.set(b.cmd, palette.length); palette.push(b); }
	}
	const total = sx * sy * sz;
	// 两层索引: base（主方块层）+ overlay（覆盖层，全部 -1 留空）
	const base = new Int32Array(total).fill(-1);
	const overlay = new Int32Array(total).fill(-1);
	for (const b of data.blocks) {
		base[(b.x * sy + b.y) * sz + b.z] = indexMap.get(b.cmd);
	}
	// 方块状态值转 NBT: 布尔→字节，数字→整数，其他→字符串
	const toState = v => typeof v === "boolean" ? nByte(v ? 1 : 0) : typeof v === "number" ? nInt(v) : nStr(String(v));
	const blockPalette = palette.map(p => nComp({
		name: nStr(p.identifier),
		states: nComp(Object.fromEntries(Object.entries(p.state || {}).map(([k, v]) => [k, toState(v)]))),
		version: nInt(18168865) // 方块格式版本号（1.21.60）
	}));
	const root = nComp({
		format_version: nInt(1),
		size: nList(T_INT, [nInt(sx), nInt(sy), nInt(sz)]), // [X, Y, Z]
		structure: nComp({
			block_indices: nList(T_LIST, [
				nList(T_INT, Array.from(base, v => nInt(v))),
				nList(T_INT, Array.from(overlay, v => nInt(v)))
			]),
			entities: nList(T_COMPOUND, []), // 结构内实体（本工具不导出实体）
			palette: nComp({
				default: nComp({
					block_palette: nList(T_COMPOUND, blockPalette),
					block_position_data: nComp({}) // 方块附加数据（NBT 实体等），此处留空
				})
			})
		}),
		structure_world_origin: nList(T_INT, [nInt(0), nInt(0), nInt(0)]) // 保存时世界原点（导出时归零）
	});
	return nbtRoot("", root);
}

// 将方块列表按层合并为矩形区域（fill 命令）
// 算法: 每层建二维网格，贪心扩展最大同色矩形
// 返回: [{ type: "setblock"|"fill", ...坐标, cmd, count }]
function mergeRects(blocks, sx, sz) {
	const cmds = [];
	const layers = {}; // 按 y 分层: { y: [方块...] }
	for (const b of blocks) (layers[b.y] ??= []).push(b);
	for (const y in layers) {
		const grid = Array.from({ length: sz }, () => Array(sx).fill(null)); // 该层方块命令网格
		const used = Array.from({ length: sz }, () => Array(sx).fill(false)); // 已合并标记
		for (const b of layers[y]) grid[b.z][b.x] = b.cmd;
		// 逐格寻找未合并的矩形
		for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
			if (used[z][x] || !grid[z][x]) continue;
			const c = grid[z][x];
			// 先向右扩展最大宽度
			let mx = x;
			while (mx + 1 < sx && grid[z][mx + 1] === c && !used[z][mx + 1]) mx++;
			// 再向下扩展行，要求整行都与当前矩形同色
			let mz = z, ok = true;
			while (ok && mz + 1 < sz) {
				for (let tx = x; tx <= mx; tx++) if (grid[mz + 1][tx] !== c || used[mz + 1][tx]) { ok = false; break; }
				if (ok) mz++;
			}
			// 标记矩形占用
			for (let tz = z; tz <= mz; tz++) for (let tx = x; tx <= mx; tx++) used[tz][tx] = true;
			const area = (mx - x + 1) * (mz - z + 1);
			// 单格用 setblock，多格用 fill（大幅减少指令数量）
			cmds.push(area === 1
				? { type: "setblock", x, y: +y, z, cmd: c }
				: { type: "fill", x1: x, y: +y, z1: z, x2: mx, z2: mz, cmd: c, count: area });
		}
	}
	return cmds;
}

// Litematic 主模块: 管理导入任务、预览、导出
class Litematic {
	constructor(client) {
		this.client = client; // Client 实例（WebSocket 通信封装）
		this.pending = null; // 待确认的导入任务（$create 后等待 $y）
		this.job = null; // 正在执行的导入任务状态
		this.previewTimer = null; // 预览粒子刷新定时器
		this.previewData = null; // 当前预览的建筑数据
	}
	// 注册全部游戏内命令（$ 前缀）
	// 命令的描述与参数定义统一在文件头部 COMMAND_DEFS 表中维护
	commands() {
		const c = this.client;
		return {
			op: [
				// $help [命令名] — 列出所有命令，或查看指定命令的用法
				defCmd("help")
					.setFn((sender, name) => {
						const all = Object.values(this.commands()).flat();
						if (name) {
							// 查看单个命令的详细用法
							const cm = all.find(x => x.name === name);
							if (!cm) return c.tell(`§c没有找到命令: §f${name} §c(输入 $help 查看全部命令)`, sender);
							const params = cm.paramDetail().length
								? cm.paramDetail().map((p, i) => `  §7参数${i + 1}: §f${p}`).join("\n")
								: "  §7无参数";
							c.tell(
								`§e=== 命令帮助: §b${cm.usage()} §e===\n` +
								`§f说明: §7${cm.description}\n` +
								`§f参数:\n${params}`, sender
							);
						} else {
							// 列出全部命令（含用法）
							const lines = all.map(cm =>
								`§a${cm.usage()} §7- §f${cm.description}`
							).join("\n");
							c.tell(
								`§e=== 可用命令 ===\n${lines}\n` +
								`§7输入 §a$help <命令名> §7查看详细参数`, sender
							);
						}
					}),
				// $create <文件> [X] [Y] [Z] [trim|raw] — 导入建筑投影
				defCmd("create")
					.setFn(async (sender, file, x, y, z, mode) => {
						if (this.job) return c.tell("§c已有导入进程运行中，请等待完成或 $n 中断", sender);
						await this.create(file, sender, x, y, z, mode);
					}),
				// $preview <文件> [X] [Y] [Z] [trim|raw] — 粒子+实体边框预览
				defCmd("preview")
					.setFn(async (sender, file, x, y, z, mode) => {
						await this.preview(file, sender, x, y, z, mode);
					}),
				// $unpreview — 清除预览
				defCmd("unpreview").setFn((sender) => this.clearPreview(sender)),
				// $export <文件> [导出名] [trim|raw] — 导出 .mcstructure 结构文件
				defCmd("export")
					.setFn(async (sender, file, name, mode) => {
						await this.exportStructure(file, sender, name, mode);
					}),
				// $list [页码] — 浏览建筑文件
				defCmd("list")
					.setFn((sender, page) => this.listFiles(page, sender)),
				// $search <关键词> [页码] — 搜索建筑文件
				defCmd("search")
					.setFn((sender, kw, page) => this.searchFiles(kw, page, sender)),
				// $y — 确认待执行的导入
				defCmd("y").setFn((sender) => {
					if (!this.pending) return c.tell("§c没有待确认的导入任务", sender);
					c.tell("§a已确认，开始导入…", sender);
					this.run();
				}),
				// $n — 取消待确认任务或中断正在进行的导入
				defCmd("n").setFn((sender) => {
					if (this.job) { this.job.cancelled = true; c.tell("§c正在中断导入…", sender); }
					else if (this.pending) { this.pending = null; c.tell("§c已取消导入", sender); }
					else c.tell("§c没有进行中的操作", sender);
				}),
				// $author — 作者信息
				defCmd("author").setFn((sender) => {
					c.tell("StarAwA117 & Hydrooxzgen", sender);
				}),
				// $status — 查看导入进度
				defCmd("status").setFn((sender) => {
					if (!this.job) return c.tell("§c没有进行中的导入任务", sender);
					const j = this.job;
					const el = ((Date.now() - j.startTime) / 1000).toFixed(1); // 已耗时（秒）
					const speed = j.phasePlaced > 0 ? Math.round(j.phasePlaced / parseFloat(el)) : 0; // 命令/秒
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
	// 分页显示文件列表（每页 5 个，附带文件大小）
	pageList(sender, files, header) {
		if (!fs.existsSync(LITEMATIC_DIR)) return this.client.tell("§c建筑目录不存在", sender);
		if (!files.length) return this.client.tell("§c没有找到文件", sender);
		const totalPages = Math.ceil(files.length / 5);
		const page = this.page ?? 1;
		const pn = Math.max(1, Math.min(page, totalPages)); // 页码越界钳制
		this.page = pn;
		const start = (pn - 1) * 5;
		const items = files.slice(start, start + 5).map((f, i) => {
			const size = fs.statSync(path.join(LITEMATIC_DIR, f)).size;
			// 文件大小格式化: B / KB / MB
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
	// 解析放置参数：支持 $cmd file raw 或 $cmd file x y z raw
	parsePlacement(x, y, z, mode) {
		let raw = false;
		if (mode === "raw") raw = true;
		else if (mode === "trim") raw = false;
		else if (mode !== undefined) return { raw: null, coords: [] };
		if (mode === undefined && x === "raw") { raw = true; x = undefined; }
		const coords = [x, y, z].filter(v => v !== undefined && v !== null);
		return { raw, coords };
	}
	async create(file, sender, x, y, z, mode) {
		const c = this.client;
		const { raw, coords } = this.parsePlacement(x, y, z, mode);
		if (raw === null) return c.tell("§c模式参数无效：应为 raw（保留原始高度）或 trim（裁剪底部空气，默认）", sender);
		if (coords.length > 0 && coords.length < 3) return c.tell("§c坐标参数不完整，需要同时提供 X Y Z 或都不提供（使用自身坐标）", sender);
		const filePath = path.join(LITEMATIC_DIR, file.endsWith(".litematic") ? file : file + ".litematic");
		if (!fs.existsSync(filePath)) return c.tell(`§c文件不存在: §f${file}`, sender);
		c.tell("§7正在解析 Litematic 文件…", sender);
		let data;
		try { data = await parseLitematic(filePath); }
		catch (e) { return c.tell(`§c解析失败: §f${e.message}`, sender); }
		if (!raw) trimAir(data);
		let origin;
		if (coords.length === 3) origin = { x: Math.floor(coords[0]), y: Math.floor(coords[1]), z: Math.floor(coords[2]) };
		else {
			try {
				const pos = await c.getPosition("@s");
				if (!pos) return c.tell("§c无法获取你的坐标", sender);
				origin = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
			} catch { return c.tell("§c无法获取你的坐标", sender); }
		}
		if (origin.y < -64 || origin.y + data.sy - 1 > 320) return c.tell(`§cY 轴超出限制: §f${origin.y} ~ ${origin.y + data.sy - 1} §c(允许 -64 ~ 320)`, sender);
		this.pending = { file, origin, data, raw };
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
			`§f尺寸: §b${data.sx}§f×§b${data.sy}§f×§b${data.sz}§f = §e${data.totalCoords}§f\n` +
			`§f方块: §e${blockCount}§f → §e${cmdCount}§f 条指令\n` +
			`§f底部空气: §e${data.trimmedAir}§f 层 §7(${raw ? `raw: 保留高度偏移 ${data.trimmedAir} 层` : "trim: 已裁剪对齐地面"})\n` +
			`§f区块: §e${chunks}§f §7(${cX}×${cZ}) → §e${areas}§f 区域\n` +
			`§f范围: §7(${minX},${minY},${minZ})→(${maxX},${maxY},${maxZ})\n` +
			`§f预计: §e${((areas + cmdCount) * 0.001 + 1).toFixed(1)}s`
		);
		// 确认提示单独一条消息，避免与预览详情被截断拆分
		c.tellAll(`§f确认请发送 §a$y§f §7| §f取消请发送 §c$n`);
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
	// ---- 预览 ----
	async preview(file, sender, x, y, z, mode) {
		const c = this.client;
		const { raw, coords } = this.parsePlacement(x, y, z, mode);
		if (raw === null) return c.tell("§c模式参数无效：应为 raw（保留原始高度）或 trim（裁剪底部空气，默认）", sender);
		if (coords.length > 0 && coords.length < 3) return c.tell("§c坐标参数不完整，需要同时提供 X Y Z 或都不提供（使用自身坐标）", sender);
		const filePath = path.join(LITEMATIC_DIR, file.endsWith(".litematic") ? file : file + ".litematic");
		if (!fs.existsSync(filePath)) return c.tell(`§c文件不存在: §f${file}`, sender);
		c.tell("§7正在解析 Litematic 文件…", sender);
		let data;
		try { data = await parseLitematic(filePath); }
		catch (e) { return c.tell(`§c解析失败: §f${e.message}`, sender); }
		if (!raw) trimAir(data);
		let origin;
		if (coords.length === 3) origin = { x: Math.floor(coords[0]), y: Math.floor(coords[1]), z: Math.floor(coords[2]) };
		else {
			try {
				const pos = await c.getPosition("@s");
				if (!pos) return c.tell("§c无法获取你的坐标", sender);
				origin = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
			} catch { return c.tell("§c无法获取你的坐标", sender); }
		}
		if (origin.y < -64 || origin.y + data.sy - 1 > 320) return c.tell(`§cY 轴超出限制: §f${origin.y} ~ ${origin.y + data.sy - 1} §c(允许 -64 ~ 320)`, sender);
		this.clearPreview();
		this.previewData = { origin, data, file };
		this.spawnPreviewEntities();
		this.spawnPreviewParticles();
		this.previewTimer = setInterval(() => this.spawnPreviewParticles(), 4000);
		c.tell(
			`§a已生成预览: §b${file} §f尺寸 §e${data.sx}§f×§e${data.sy}§f×§e${data.sz}\n` +
			`§f范围: §7(${origin.x}, ${origin.y}, ${origin.z}) §f→ §7(${origin.x + data.sx - 1}, ${origin.y + data.sy - 1}, ${origin.z + data.sz - 1})\n` +
			`§f底部空气: §e${data.trimmedAir}§f 层 §7(${raw ? "保留原始高度" : "已裁剪，建筑底部对齐放置点"})\n` +
			`§f§o实体标记持续显示，输入 §a$unpreview §f清除`, sender
		);
	}
	clearPreview(sender) {
		const c = this.client;
		if (this.previewTimer) { clearInterval(this.previewTimer); this.previewTimer = null; }
		this.previewData = null;
		c.sendCommand(`/kill @e[name="§a[LIT]▪"]`);
		c.sendCommand(`/kill @e[name="§e[LIT]✦"]`);
		c.sendCommand(`/kill @e[name="§b[LIT]INFO"]`);
		if (sender) c.tell("§7已清除建筑预览", sender);
	}
	// 12 条边框边（角点对）
	static previewEdges(x1, y1, z1, x2, y2, z2) {
		return [
			[[x1, y1, z1], [x2, y1, z1]], [[x1, y1, z2], [x2, y1, z2]],
			[[x1, y2, z1], [x2, y2, z1]], [[x1, y2, z2], [x2, y2, z2]],
			[[x1, y1, z1], [x1, y2, z1]], [[x2, y1, z1], [x2, y2, z1]],
			[[x1, y1, z2], [x1, y2, z2]], [[x2, y1, z2], [x2, y2, z2]],
			[[x1, y1, z1], [x1, y1, z2]], [[x2, y1, z1], [x2, y1, z2]],
			[[x1, y2, z1], [x1, y2, z2]], [[x2, y2, z1], [x2, y2, z2]]
		];
	}
	spawnPreviewEntities() {
		const c = this.client;
		const { origin, data } = this.previewData;
		const x1 = origin.x, y1 = origin.y, z1 = origin.z;
		const x2 = x1 + data.sx - 1, y2 = y1 + data.sy - 1, z2 = z1 + data.sz - 1;
		const step = Math.max(3, Math.ceil(Math.max(data.sx, data.sy, data.sz) / 50));
		for (const [px, py, pz] of [[x1, y1, z1], [x2, y1, z1], [x1, y1, z2], [x2, y1, z2], [x1, y2, z1], [x2, y2, z1], [x1, y2, z2], [x2, y2, z2]]) {
			c.sendCommand(`/summon text_display ${px} ${py} ${pz} "§e[LIT]✦"`);
		}
		for (const [a, b] of Litematic.previewEdges(x1, y1, z1, x2, y2, z2)) {
			const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
			const len = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
			const n = Math.floor(len / step);
			for (let i = 1; i <= n; i++) {
				c.sendCommand(`/summon text_display ${Math.round(a[0] + dx * i / n)} ${Math.round(a[1] + dy * i / n)} ${Math.round(a[2] + dz * i / n)} "§a[LIT]▪"`);
			}
		}
		c.sendCommand(`/summon text_display ${Math.floor((x1 + x2) / 2)} ${y2 + 2} ${Math.floor((z1 + z2) / 2)} "§b[LIT]INFO"`);
	}
	spawnPreviewParticles() {
		const c = this.client;
		if (!this.previewData) return;
		const { origin, data } = this.previewData;
		const x1 = origin.x, y1 = origin.y, z1 = origin.z;
		const x2 = x1 + data.sx - 1, y2 = y1 + data.sy - 1, z2 = z1 + data.sz - 1;
		const step = Math.max(4, Math.ceil(Math.max(data.sx, data.sy, data.sz) / 40));
		// 底边 4 条 + 立柱 4 条（顶部省略，避免粒子过多）
		const edges = Litematic.previewEdges(x1, y1, z1, x2, y2, z2).slice(0, 8);
		for (const [a, b] of edges) {
			const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
			const len = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
			const n = Math.floor(len / step);
			for (let i = 0; i <= n; i++) {
				c.sendCommand(`/particle minecraft:lava_particle ${a[0] + dx * i / n + 0.5} ${a[1] + dy * i / n + 0.5} ${a[2] + dz * i / n + 0.5}`);
			}
		}
	}
	// ---- 导出 .mcstructure ----
	async exportStructure(file, sender, exportName, mode) {
		const c = this.client;
		let raw = false;
		if (mode === "raw") raw = true;
		else if (mode === "trim") raw = false;
		else if (mode !== undefined) return c.tell("§c模式参数无效：应为 raw 或 trim", sender);
		if (mode === undefined && exportName === "raw") { raw = true; exportName = undefined; }
		const filePath = path.join(LITEMATIC_DIR, file.endsWith(".litematic") ? file : file + ".litematic");
		if (!fs.existsSync(filePath)) return c.tell(`§c文件不存在: §f${file}`, sender);
		c.tell("§7正在解析 Litematic 文件…", sender);
		let data;
		try { data = await parseLitematic(filePath); }
		catch (e) { return c.tell(`§c解析失败: §f${e.message}`, sender); }
		if (!raw) trimAir(data);
		const name = (exportName || file.replace(/\.litematic$/i, "")).replace(/[\\/:*?"<>|]/g, "_");
		const dir = path.join(process.cwd(), "structures");
		fs.mkdirSync(dir, { recursive: true });
		const outPath = path.join(dir, name + ".mcstructure");
		try { fs.writeFileSync(outPath, buildMcStructure(data)); }
		catch (e) { return c.tell(`§c导出失败: §f${e.message}`, sender); }
		c.tell(
			`§a已导出结构文件: §f${outPath}\n` +
			`§f尺寸: §e${data.sx}§f × §e${data.sy}§f × §e${data.sz}§f | 方块: §e${data.blocks.length}§f | 底部空气: §e${data.trimmedAir}§f 层\n` +
			`§7用法: 将文件放入行为包 §fstructures§7 文件夹（如 §fBP/structures/mystructure/§7）或单机存档的 §fstructures§7 文件夹，` +
			`游戏内用结构方块预览放置，或执行 §f/structure load <名称>§7`, sender
		);
	}
	destroy() {
		if (this.job) this.job.cancelled = true;
		this.pending = null;
		this.job = null;
		this.clearPreview();
		this.client = null;
	}
}

// ==================== 终端控制台支持 ====================
// 除了在游戏内聊天栏输入命令，也可以在运行本脚本的终端中直接输入 $ 命令。
// 需要游戏连接的操作（查询坐标、放置方块）自动委托给当前活跃的 WebSocket 连接。

let activeWs = null; // 当前活跃的游戏连接（终端命令的委托目标，取第一个连接）

// 去掉 Minecraft 颜色代码（§x），用于终端纯文本显示
function stripColor(msg) {
	return String(msg).replace(/§[0-9a-fk-or]/g, "");
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt("litematic> ");
rl.prompt();

// 输出到终端：清空当前输入行 → 打印（去颜色码）→ 恢复提示符
function consoleOut(msg) {
	process.stdout.write("\r\x1b[K");
	console.log(stripColor(msg));
	rl.prompt();
}

// 控制台客户端：对 Litematic 暴露与游戏连接相同的接口
// sendCommand / runCommand / getPosition → 委托给活跃游戏连接
// tell / tellAll → 输出到终端（tellAll 同时转发给游戏内玩家广播）
const consoleClient = {
	sendCommand: (...args) => activeWs ? activeWs.sendCommand(...args) : null,
	runCommand: (...args) => activeWs ? activeWs.runCommand(...args) : Promise.resolve({ body: { statusCode: 1 } }),
	getPosition: (...args) => activeWs ? activeWs.getPosition(...args) : Promise.resolve(null),
	tell: (msg) => consoleOut(msg),
	tellAll: (msg) => { consoleOut(msg); if (activeWs) activeWs.tellAll(msg); }
};

// 终端专用的 Litematic 实例（与游戏连接各自的实例相互独立，各自维护 pending/job 状态）
const consoleMod = new Litematic(consoleClient);

// 解析并执行一条命令（游戏内聊天与终端输入共用）
// 返回 true 表示命令已匹配
function dispatchCommand(mod, sender, text) {
	const commands = mod.commands().op;
	for (const c of commands) {
		const r = c.execute(sender, text);
		if (r) {
			if (!r.ok) mod.client.tell(`Command §c${r.msg}`, sender);
			return true;
		}
	}
	return false;
}

// 终端输入监听：输入 $ 前缀命令直接执行
rl.on("line", line => {
	const text = line.trim();
	if (!text) return; // 空输入直接忽略（提示符仍在）
	if (text === "exit" || text === "quit") { rl.close(); process.exit(0); return; } // 退出脚本
	if (!text.startsWith(PREFIX)) { consoleOut(`§7命令需以 ${PREFIX} 开头，输入 $help 查看帮助`); return; }
	if (!dispatchCommand(consoleMod, "console", text.slice(1))) consoleOut(`§c未知的命令 ${text.split(" ")[0]}`);
});

const server = new WebSocketServer({ port: PORT });
console.log(`[Litematic] listening on ws://localhost:${PORT}`);
console.log(`[Litematic] 终端命令可用，输入 $help 查看帮助，exit 退出`);
server.on("connection", ws => {
	const cli = new Client(ws);
	const mod = new Litematic(ws);
	if (!activeWs) activeWs = ws; // 记录第一个连接，供终端命令委托
	cli.ws.send(JSON.stringify({ body: { eventName: "PlayerMessage" }, header: { requestId: crypto.randomUUID(), messagePurpose: "subscribe", version: 1, messageType: "commandRequest" } }));
	ws.on("message", msg => {
		let data;
		try { data = JSON.parse(String(msg)); } catch { return; }
		cli.onMessage(data);
		if (data?.header?.messagePurpose === "event" && data.header.eventName === "PlayerMessage") {
			const sender = data.body?.sender, text = data.body?.message, type = data.body?.type;
			if (!sender || !text || type !== "chat" || text.length >= 256 || !text.startsWith(PREFIX)) return;
			if (!dispatchCommand(mod, sender, text.slice(1))) ws.tell(`§c未知的命令 ${text.split(" ")[0]}`, sender);
		}
	});
	ws.on("close", () => {
		mod.destroy();
		if (activeWs === ws) activeWs = null; // 连接断开后清除委托目标
	});
	ws.on("error", e => console.error("[Litematic] error:", e.message));
	ws.tellAll("§aLitematic §f已连接");
	console.log("[Litematic] client connected");
});
server.on("error", e => console.error("[Litematic] server error:", e.message));
