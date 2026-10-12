# lspnet-tools-node

LSPNet 的节点代理（Node.js 版本）。它运行在每台组网节点上，定期从控制面 [lspnet-server](https://github.com/Kiritow/lspnet-server) 拉取配置，在独立的 network namespace 里维护 WireGuard 点对点链路，并用容器化的 BIRD 跑 OSPF + BFD 完成动态路由，同时把链路与路由状态回报给控制面。

## 功能

- **WireGuard 链路管理**：按控制面下发的 peer 列表创建、更新、删除 WireGuard 接口，同步监听端口、对端 endpoint（每轮重新解析 DNS，支持 DDNS）和 keepalive。
- **密钥托管**：WireGuard 私钥只在节点本地生成和保存，只把公钥上报给控制面，数量按控制面的请求补充。
- **OSPF 动态路由**：在 Podman 容器中运行 BIRD 2，所有 WireGuard 接口以 point-to-point 方式加入 area 0 并启用 BFD；链路 cost 可以固定，也可以按实测延迟自动计算。
- **Underlay 转发**：支持经 [gost](https://github.com/go-gost/gost) 的 `relay+tls` 隧道承载 WireGuard UDP 流量，或者使用节点外部自行维护的本地连接器。
- **出口节点 / 本地网络接入**：可将节点配置为出口（MASQUERADE），或通过 veth 对把宿主机网络接入 overlay。
- **遥测上报**：每轮上报每条链路的延迟、收发字节数，以及 BIRD 的 OSPF 拓扑状态。

## 工作方式

`run` 启动时会先**清空本节点 namespace 下的所有状态**（WireGuard 接口、veth、iptables 自定义链、路由容器、underlay 服务），然后每 60 秒执行一轮同步：

1. 确保 netns、iptables 自定义链、IP 转发、临时目录和 TCPMSS clamp 规则存在。
2. 上报未上报过的 WireGuard 公钥，并按控制面请求生成新密钥（每轮最多 20 个）。
3. 拉取节点配置（`/api/v1/node/config`）和 peer 列表（`/api/v1/node/peers`）。
4. 同步出口节点配置、veth 本地网络。
5. 同步 WireGuard peer：先删除过期接口、释放被其他 peer 占用的端口，再逐个创建或更新。单个 peer 出错只记录日志，不会阻塞其他 peer。
6. 生成 `bird.conf`，确保路由容器在运行，并执行 `birdc configure` 重载。
7. 测量延迟、收集流量与 OSPF 状态，上报遥测。

由于延迟测量需要对每条链路 ping 约 10 秒，单轮同步通常要几十秒。

### 在系统中创建的资源

以下 `<ns>` 指初始化时填写的 namespace：

| 资源 | 命名 |
| --- | --- |
| Network namespace | `<ns>` |
| WireGuard 接口（位于 netns 内） | `<ns>-<链路 ID>` |
| veth 对 | `<ns>-veth0`（宿主机侧）、`<ns>-veth1`（netns 内） |
| iptables 自定义链 | `<ns>-INPUT`、`<ns>-FORWARD`（filter），`<ns>-PREROUTING`、`<ns>-POSTROUTING`（nat），`<ns>-PREROUTING`（raw），`<ns>-OUTPUT`、`<ns>-POSTROUTING`（mangle） |
| 路由容器 | `<ns>-router`（镜像 `bird-router`） |
| systemd 临时单元 | `networktools-<ns>-router.service`、`networktools-<ns>-worker-<uuid>.service` |
| 临时目录 | `/tmp/networktools-<ns>/`（BIRD 配置位于 `router/bird.conf`） |

Linux 接口名最长 15 个字符，所以 namespace 要尽量短，例如 `<ns>-veth0` 要求 namespace 不超过 9 个字符。

### Underlay 模式

链路的 underlay 由控制面在 peer 的 `extra.underlay` 中下发：

| provider | 行为 |
| --- | --- |
| `gost_relay_client` | 本地启动 gost，监听 UDP `listen_port`，经 `relay+tls` 转发到 `server_addr:server_port`（`server_addr` 为空时使用 peer endpoint 的主机）；WireGuard endpoint 指向 `127.0.0.1:listen_port`。 |
| `gost_relay_server` | 本地启动 gost，在 `listen_port` 接受 `relay+tls` 连接并转发到本接口的 WireGuard 监听端口。 |
| `local` | 不启动任何进程，只把 WireGuard endpoint 指向节点外部自行维护的连接器 `endpoint`。 |

gost 两种模式都支持可选的 `username` / `password` 认证（两者都填写时才启用），gost 进程通过 `systemd-run` 以 `Restart=always` 运行。

### 链路 cost

每条 WireGuard 链路的 OSPF cost 计算规则如下：

- 默认使用 `extra.ospf.cost`，未配置时为 1000。
- `extra.ospf.ping` 为 true 时，改用实测平均延迟（毫秒，去掉极端值后取平均）。
- 结果加上 `extra.ospf.offset`，再限制在 1 ~ 65535 之间。

## 环境要求

- Linux，带 systemd，需要 root 权限（以非 root 身份运行时，所有命令会通过 `sudo` 执行）。
- Node.js ≥ 22.13（使用内置的 `node:sqlite`）。
- `iproute2`、`iptables`、`wireguard-tools`、`iputils-ping`、`podman`。
- 使用 gost underlay 时需要 `bin/gost`（`install.sh` 会下载）。

## 安装

`install.sh` 面向 Debian / Ubuntu（使用 apt）和 amd64 架构：

```bash
git clone https://github.com/Kiritow/lspnet-tools-node.git
cd lspnet-tools-node
./install.sh
```

脚本会执行以下步骤：

1. `npm install` 并构建到 `dist/`。
2. 安装 `wireguard`、`podman`、`socat`。
3. 下载 gost v3.2.6 与 frp v0.54.0 到 `bin/`。
4. 用仓库内的 `Dockerfile` 构建 `bird-router` 镜像（Ubuntu + bird2，读取 `/data/bird.conf`）。
5. 安装 systemd 模板单元 `network-tools@.service`，以当前目录为工作目录。

## 使用

### 1. 初始化节点

```bash
node dist/index.js init -d local/<实例名>.db
```

如果数据库文件不存在会自动创建，然后交互式询问：

- **Ethernet interface name**：宿主机的出口网卡名（如 `eth0`），用于出口节点 MASQUERADE 和 veth SNAT。
- **namespace**：本节点使用的 netns 名，同时也是接口、iptables 链、容器的命名前缀。
- **controller domain prefix**：控制面地址。请填写带协议头的完整地址，如 `https://lspnet.example.com`，末尾不要带 `/`。
- **join-cluster token**：在控制面获取的入网 token。

初始化时会生成节点的 Ed25519 签名密钥，并向控制面注册，获得节点 ID。这些信息都保存在 SQLite 数据库中。对已存在的数据库再次执行 `init` 只会补全缺失的项。

### 2. 以 systemd 服务运行

服务实例名对应 `local/` 下的数据库文件名：

```bash
sudo systemctl enable --now network-tools@<实例名>
journalctl -u network-tools@<实例名> -f
```

日志只输出到 stdout / stderr，可通过 journald 查看。

### 前台运行（调试）

```bash
./start.sh local/<实例名>.db
```

`start.sh` 会先构建，再以前台方式执行 `run`。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `INSTALL_DIR` | 安装目录，用于定位 `$INSTALL_DIR/bin/gost`。链路使用 gost underlay 时必须设置。 |

## 数据库

每个节点实例使用一个 SQLite 文件，包含以下表：

| 表 | 内容 |
| --- | --- |
| `nodeconfig` | 节点设置：`namespace`、`ethName`、`privateKey`（Ed25519 PEM）、`nodeId`、`domainPrefix` |
| `wgkey` | 本地生成的 WireGuard 密钥对及是否已上报 |
| `simplekv` | 带 TTL 的 KV，目前用于记录每个接口的 underlay 状态 |

数据库中保存着节点签名私钥和全部 WireGuard 私钥，请妥善保管。

## 与控制面的通信

注册之后的请求都用节点的 Ed25519 私钥签名，并带上以下请求头：

| 请求头 | 内容 |
| --- | --- |
| `X-Client-Id` | 公钥（SPKI DER）的 SHA-256 |
| `X-Client-Nonce` | 随机 nonce |
| `X-Client-Sign` | 签名的十六进制编码。GET 请求签 `url\nnonce\nquery`，POST 请求签 `url\nnonce\nbody` |
| `X-Client-Version` | 构建时的 git commit 前 8 位 |

用到的接口如下：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/v1/node/join` | 入网注册（不签名，使用 token） |
| GET | `/api/v1/node/config` | 节点配置 |
| GET | `/api/v1/node/peers` | peer / 链路列表 |
| POST | `/api/v1/node/sync_wireguard_keys` | 上报公钥，返回需要新生成的密钥数量 |
| POST | `/api/v1/node/link_telemetry` | 链路遥测 |
| POST | `/api/v1/node/router_telemetry` | OSPF 遥测 |

## 开发

```bash
npm install
npm run build    # 写入版本信息到 src/version.ts → eslint → tsc 输出到 dist/
npm run eslint
```

- 代码风格由 Prettier 约束（4 空格缩进、双引号），并通过 ESLint 检查。
- `src/version.ts` 由构建脚本生成，不纳入版本控制。
- peer 的 `extra`（包括 underlay 格式）与 lspnet-server 共享同一套 schema。如果节点解析 `extra` 失败（例如遇到不认识的 underlay provider），整个 `extra` 都会被丢弃，链路会退化为直连，OSPF cost / ping 配置也会失效。因此修改这部分格式时需要两个仓库同步改动，并且**先升级节点，再升级控制面**。

### 源码结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | CLI 入口（`init` / `run`） |
| `src/cli-api.ts` | 交互式初始化与入网 |
| `src/service.ts` | 启动清理与主循环 |
| `src/controller.ts` | 单轮同步逻辑（密钥、出口、veth、peer、underlay、BIRD、遥测） |
| `src/nodemanager-client.ts` | 控制面 API 客户端与数据 schema |
| `src/config-store.ts` / `src/base-sqlite.ts` | 本地 SQLite 存储 |
| `src/device.ts` | WireGuard / veth 等网络接口操作 |
| `src/iptables.ts` | iptables 链与规则管理 |
| `src/bird.ts` / `src/bird-ospf.ts` | BIRD 配置生成与 OSPF 状态解析 |
| `src/podman.ts` | 路由容器管理 |
| `src/external-tools.ts` | gost 进程管理 |
| `src/ping.ts` | 链路延迟测量 |
| `src/pki.ts` | 节点签名密钥 |

## License

MIT
