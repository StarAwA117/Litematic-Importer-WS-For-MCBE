# Litematic Importer WS For MCBE

一个通过 WebSocket 将 **Litematica** 建筑投影导入 **Minecraft 基岩版 (Bedrock Edition)** 的工具。

无需本地存档，可在任何正在运行的世界中直接导入大规模建筑，支持自动优化指令、实时进度监控和区域分割。

## 前置要求

- **Node.js** 18+
- Minecraft 基岩版（支持 WebSocket 连接的版本）

## 安装

```bash
git clone https://github.com/StarAwA117/Litematic-Importer-WS-For-MCBE.git
cd Litematic-Importer-WS-For-MCBE
npm install
```

## 使用方法

### 1. 启动服务

```bash
npm start
# 或指定端口
node litematic.js 8080
```

### 2. 连接游戏

在 Minecraft 基岩版聊天栏中输入：

```
/connect 127.0.0.1:8080
```

### 3. 放置 Litematic 文件

将 `.litematic` 文件放入项目目录下的 `litematic/` 文件夹。

## 游戏内命令

所有命令以 `$` 为前缀，在聊天栏中输入。

### $create

导入一个 Litematic 文件。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| 文件名 | string | 是 | litematic 文件名（可带或不带 `.litematic` 后缀） |
| X | int | 否 | 目标 X 坐标（留空则使用玩家当前位置） |
| Y | int | 否 | 目标 Y 坐标 |
| Z | int | 否 | 目标 Z 坐标 |
| 模式 | string | 否 | `trim`（默认）：裁剪底部空气层，建筑底部对齐放置点；`raw`：保留原始高度偏移 |

> **底部空气层说明**：Litematic 文件的区域高度通常包含大量空白空气（建筑底部可能悬空数层甚至几十层）。默认 `trim` 模式会自动检测并裁剪这些空气层，让建筑紧贴放置点地面，避免悬空和破坏地形。使用 `raw` 可保留原始偏移。

**示例：**

```
$create my_house
$create my_house 100 64 200
$create my_house 100 64 200 raw
$create "my house" raw
```

执行后会显示预览信息（尺寸、方块数、底部空气层、预计耗时），输入 `$y` 确认后开始导入。

### $preview

在不放置方块的情况下预览建筑的位置和轮廓（FMBE 风格虚拟预览）。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| 文件名 | string | 是 | litematic 文件名 |
| X | int | 否 | 目标 X 坐标（留空则使用玩家当前位置） |
| Y | int | 否 | 目标 Y 坐标 |
| Z | int | 否 | 目标 Z 坐标 |
| 模式 | string | 否 | `trim`（默认）/ `raw`，同 `$create` |

预览效果：
- **粒子边框** — 建筑底部与四角的熔岩粒子轮廓（约每 4 秒刷新一次）
- **实体标记** — 8 个角点（`✦`）与边框点（`▪`）的悬浮标记，以及顶部信息标签，持续显示
- 聊天栏显示尺寸、实际放置范围与底部空气层数

> 实体标记使用 `text_display` 实体，需要 Minecraft 1.19.60+（粒子边框任意支持 WebSocket 的版本均可用）。

**示例：**

```
$preview my_house
$preview my_house 100 64 200
```

### $unpreview

清除当前建筑预览（移除所有标记实体并停止粒子刷新）。

```
$unpreview
```

### $export

将 Litematic 导出为 Minecraft 基岩版结构文件 `.mcstructure`，可在游戏内用结构方块预览和放置。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| 文件名 | string | 是 | litematic 文件名 |
| 导出名 | string | 否 | 导出文件名（默认与 litematic 同名） |
| 模式 | string | 否 | `trim`（默认）/ `raw`，同 `$create` |

导出文件写入项目目录的 `structures/` 文件夹。使用方式：

1. 将 `.mcstructure` 文件放入行为包的 `structures` 文件夹（如 `BP/structures/mystructure/`）或单机存档的 `structures` 文件夹
2. 游戏内用结构方块加载预览，或执行 `/structure load <名称>`

**示例：**

```
$export my_house
$export my_house castle
$export my_house castle raw
```

### $list

查看 litematic 文件列表。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| 页码 | int | 否 | 指定页码（每页 5 个文件，默认第 1 页） |

**示例：**

```
$list
$list 2
```

### $search

按关键词搜索建筑文件。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| 关键词 | string | 是 | 搜索关键词（不区分大小写） |
| 页码 | int | 否 | 指定页码 |

**示例：**

```
$search castle
$search house 2
```

### $y

确认待执行的导入操作。在 `$create` 显示预览后使用。

### $n

取消待执行的导入操作，或中断正在进行的导入。

### $status

查看当前导入进度，包括：

- 已完成百分比
- 当前阶段（清除空气 / 放置方块 / 等）
- 命令执行速度
- 预计剩余时间

### $author

显示作者信息。

## 亮点

- **大规模建筑支持** — 自动分割超大建筑，分区域导入
- **实时进度监控** — 随时查看导入速度和剩余时间
- **智能指令优化** — 自动合并相邻同种方块为 fill 指令
- **无需本地存档** — 通过 WebSocket 连接任意正在运行的世界
- **自动常加载区块** — 导入期间自动创建和删除 ticking area
- **空气层自动裁剪** — 检测并裁剪建筑底部的空白空气层，避免悬空与破坏地形
- **虚拟预览** — 粒子边框 + 实体标记，放置前确认建筑位置和大小
- **结构文件导出** — 一键导出 `.mcstructure`，可用结构方块预览放置

## License

MIT
