# ts-backtest

独立的 TypeScript 股票/ETF Bar 回测引擎。策略通过版本化 JSON 描述，CLI 同时支持 YAML；SDK、CLI 和 stdio MCP 共用数据校验、撮合与账本。实现进度和各阶段验证证据见 [PROGRESS](docs/PROGRESS.md)。

项目地址：[ai-yang/ts-backtest](https://github.com/ai-yang/ts-backtest)。采用 [MIT License](LICENSE)。

已验证 Linux x64 上的 Node.js 24.18.0 与 22.23.4。Windows、macOS、Bun 尚未验证；生产部署需要宿主提供 Node.js。

```bash
git clone https://github.com/ai-yang/ts-backtest.git
cd ts-backtest
npm ci
npm test
npm run cli -- validate --config examples/basic.yaml
npm run cli -- run --config examples/basic.yaml --output .backtest/example.json
```

示例使用合成行情、明确的零费用与 T+0 规则，适合检查接口和账本，不能直接当作某个市场的真实交易规则。

## 计算与输入

- 单币种、现金多头、多证券共享账户；日线及一分钟 OHLCV。
- 规则表达式、目标持仓/权重、历史成员股票池内的排名组合、已成交记录核算。
- 收盘决策、下一根开盘执行；市价/限价/止损单、固定或种子化滑点、部分成交、T+N 可卖约束、整手和零股。
- 精确十进制现金/费用、按单累计最低佣金、分红应收/付款、拆股及零碎股补偿、退市现金结算。
- 现金流单位净值、金额与百分比回撤各自的区间、日收益风险指标、逐笔费用和因果决策记录。

CSV、JSONL 和 JSON 的字段约定及配置示例在 [examples](examples/README.md)。必须提供时区、明确的开收盘时间、交易日历、价格跳动、交易单位、结算规则和费用；引擎不根据证券代码猜市场规则。价格/现金使用十进制字符串，时间使用 UTC 毫秒。

`prepare` 可将输入转换为带校验和的列式缓存。运行过程不联网取行情、不执行配置中的任意 JavaScript，不需要 Python、GUI 或数据库服务。

## 解释结果

| 字段 | 口径 |
| --- | --- |
| `finalEquity` / `netProfit` / `fees` | 账户币种的精确十进制字符串 |
| 收益率、波动率、回撤百分比 | 小数比例，例如 `0.1` 表示 10% |
| `maxDrawdownPct` | 完整已观察频率的单位净值回撤 |
| `rawEquityDrawdownPct` | 原始账户资产百分比回撤，和单位净值回撤分别计算，可能受现金流影响 |
| `maxDrawdownAmount` | 原始账户资产金额回撤，可能包含提款影响 |
| `drawdownCoverage` | 回撤估值覆盖：complete / incomplete / unverified；缺失报价或未验证的分钟节奏不代表完整风险 |
| `annualizedReturn` | 按自然时间 365.25 天年化 |
| `sharpe` / `sortino` | 交易日收盘单位净值收益；年周期数由配置明确给出 |
| `unavailable` | 记录指标缺失或口径限制；样本不足通常为 null，覆盖不完整的回撤仍保留观测值并附原因 |

报价覆盖 incomplete/unverified 时，回撤数值仅代表已观测或延续估值，不能当作完整风险；原因同时见 `warnings` / `unavailable`。分钟报价节奏目前标记 unverified。

`summary` 保留指标，`trades` 另保留订单和成交，`fullTrace` 再保留净值、账本事件及决策信息。不同输出级别的指标计算分辨率一致。查询未保存的明细必须重放原始完整历史。

OHLC 不能恢复真实盘中路径。入场后止盈/止损的顺序可能有歧义，由 `intrabarPolicy` 明确选择保守模拟或报错。下一根开盘的成交量上限采用上一根已完成 Bar 的成交量。DAY 单在提交的交易日结束时到期；日收盘信号若需次日成交，应使用 GTC。

接口与精确语义见 [CONTRACT](docs/CONTRACT.md)，验收场景见 [ACCEPTANCE](docs/ACCEPTANCE.md)。不支持卖空、融资保证金、期权、跨币种转换、逐笔队列撮合或实盘交易。

## 宿主接入

MCP 接入已通过官方客户端和 Codex 实际调用验证。作业生命周期、目录边界及连接验收见 [INTEGRATION](docs/INTEGRATION.md)。

性能结论以仓库中实际测量记录为准，设计预算不作为速度承诺。


## 独立生产包

构建环境需要安装开发依赖；运行环境直接解压，无须安装 npm 依赖、TypeScript 编译器、Python 或数据库：

```bash
npm ci
npm ci --prefix optional-formats
npm run test:optional
npm run package
npm run test:package

# 将生成的 .tgz 复制到目标环境后解压
mkdir -p /opt/ts-backtest
tar -xzf dist/package/ts-backtest-0.1.0.tgz -C /opt/ts-backtest
node /opt/ts-backtest/ts-backtest/cli.cjs run \
  --config /opt/ts-backtest/ts-backtest/examples/basic.yaml
node /opt/ts-backtest/ts-backtest/mcp.cjs \
  --workspace /absolute/data --store /absolute/backtest-store --workers 2
```

只需要核心分发时使用 `npm run package:core`，不需要安装可选格式包。
`core.cjs` 是 SDK 入口，`service.cjs` 导出异步 `BacktestService`；`worker.cjs`
和 `research-worker.cjs` 必须与使用它们的入口保存在同一目录。CLI/MCP 各自是
独立 bundle。分发包同时提供类型声明、JSON Schema、示例和第三方许可证；包内
没有 `node_modules`，不包含开发依赖或 Node 可执行文件。

```js
import { importDataset, runBacktest } from '/opt/ts-backtest/ts-backtest/core.cjs';
const data = await importDataset({ path: '/data/bars.csv', format: 'csv', metadata });
const result = runBacktest(data, spec);
```

`dist/package/size-report.json` 区分压缩归档字节、解压字节和 bundle JavaScript
字节；`1 MiB = 1,048,576 bytes`，这些数值均不包含 Node 和用户行情/结果。
`dist/package/smoke-report.json` 记录实际运行版本、校验后的解压字节和验证结果。
验收将归档解压到仓库之外，清空 `PATH`/`NODE_PATH` 并禁止网络调用，再执行
SDK、CLI、研究 Worker、MCP 作业及可选格式。类型声明另行在无已安装 Zod/Decimal
运行依赖类型的消费工程中检查；Node 类型由消费工程的开发环境提供。

Parquet、Arrow IPC、XLSX 位于单独的 `ts-backtest-optional-formats-0.1.0.tgz`。
部署方通过 `--formats /absolute/path/formats.cjs` 或 SDK 的 `setFormatAdapter()`
明确启用，主包不静态包含这些解析库。三个格式沿用同样的元数据与列映射；金融
价格必须存为十进制文本，浮点价格、Excel 公式和隐式日期不会被悄悄转换。
格式配置与限制见 [optional-formats](optional-formats/README.md)。


## 研究、报告与大模型工具

原生多时间框架可聚合分钟/交易日 Bar，并将完成的高周期指标按 `availableAt`
发布给策略；示例见 [frames.json](examples/frames.json) 和 [时间框架契约](docs/FRAMES.md)。
网格扫描、滚动/扩展 Walk-forward、IC/Rank IC/分组诊断的语义和预算见
[RESEARCH](docs/RESEARCH.md)。Walk-forward 当前支持规则策略，样本外使用同一个
连续账户并保留持仓和未完成订单；因子诊断不等同于扣费后的可投资组合收益。

```bash
npm run cli -- sweep --config examples/research-config.json \
  --request examples/research-sweep.json --output /tmp/sweep.json
npm run cli -- walk-forward --config examples/research-config.json \
  --request examples/research-walk-forward.json --output /tmp/walk-forward.json
npm run cli -- factors --config examples/research-config.json \
  --request examples/research-factors.json --output /tmp/factors.json
npm run cli -- run --config examples/basic.json --output /tmp/result.json
npm run cli -- report --input /tmp/result.json --output /tmp/report.html
node examples/research-demo.mjs /tmp/backtest-research-store
```

这些五根 Bar、单一证券示例用于验证接口；横截面样本不足时 IC 返回 null。
HTML/SVG 报告自包含，无外链脚本；净值与回撤曲线需要 `fullTrace` 输出。
在解压分发包中，将 `npm run cli --` 替换为 `node cli.cjs` 即可运行对应命令。

MCP 提供 12 个工具：

| 用途 | 工具 |
| --- | --- |
| 能力、数据与计划 | `backtest_capabilities`、`backtest_prepare_data`、`backtest_validate` |
| 执行与控制 | `backtest_run`、`backtest_job` |
| 回测结果、因果解释、图表 | `backtest_result`、`backtest_explain`、`backtest_report` |
| 研究作业与结果 | `backtest_sweep`、`backtest_walk_forward`、`backtest_factors`、`backtest_study` |

耗时操作返回可轮询、可取消的作业句柄。验证大型数据时设置
`backtest_validate` 的 `background: true`，避免让宿主请求等待工作队列。
结果通过有界分页读取；原始数据、解析后的配置、种子、版本和产物校验和用于复现。
