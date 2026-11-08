# `/wait` 契约 v1.1（wait/1.1）

> 状态：**冻结**（2026-11-08）。两个实现：Python 侧 `wait_probe.py`、Node 侧 `run_cases.js`，
> 跑同一份 `fixtures/wait_probe_cases.json`。**两边都绿才算契约成立**；单边绿只说明某一侧自洽。
>
> **变更记录**
> - `wait/1.1`（2026-11-08）：`/inv/count` 明确 **count map 语义——不在表里的物品 = 0**（§7）。
>   这是语义变更：`iron_ingot == 0` 在背包没有铁锭时由 `timeout` 改为 `matched`。
>   旧实现会在这两条新用例上变红（`iv_count_absent_zero` / `iv_count_absent_nonzero`），这是预期的。
> - `wait/1`（2026-11-08）：初版。

> 改契约的流程：先改这份文档 → 加用例 → 两个实现都红 → 再改实现。不许反过来（先改实现再补文档，
> 就会得到一份描述现状而不是描述约定的文档）。

## 0. 为什么要这个东西

她的静默有一半不是"人不在了"，是**接口没有等待语义**：桥只能被问"现在怎么样"，不能"等到怎么样再叫我"。
于是她自己写出了

```bash
for i in $(seq 1 40); do sleep 15; curl -s .../state; done
```

——40 次轮询、10 分钟、每条都是一次完整的 HTTP 往返，中间任何一次掉链子就整段作废，
而且**她自己也没法从这堆输出里判断"到底等到了没有"**。`/wait` 就是把这个循环搬到服务端：

```
POST /wait {"path":"/state","condition":"invSlotsUsed >= 36","timeout_s":60}
→ 一次调用，最多阻塞 timeout_s，返回 matched / timeout / degraded / bad_request
```

设计上刻意做得**很窄**：能等的东西只有白名单里的五个只读端点，能表达的条件只有
"一个路径 一个运算符 一个字面量"。窄不是省事，是因为条件字符串来自模型生成，
而这个字符串要进一个会阻塞 60 秒的请求里。

## 1. 请求

```json
POST /wait
{"path": "/state", "condition": "invSlotsUsed >= 36", "timeout_s": 60}
```

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `path` | 是 | string | 必须是 `WAITABLE` 里的**精确**字符串，见 §2 |
| `condition` | 是 | string | 见 §3 语法；**必须是字符串**，数字/对象/数组一律拒 |
| `timeout_s` | 否 | int | 缺省 60；`1..300` 原样用；`>300` 夹到 300；`≤0` 或非整数拒 |

`timeout_s` 不接受 `"60"`（字符串）、`60.0`（浮点）、`true`（布尔）。
请求体本身也不做隐式转换——**条件字符串已经来自模型了，请求层再宽容一次，
错误就会一路滑到 60 秒后才以 `timeout` 的面目出现**，那是这个接口最坏的失败模式。

## 2. `WAITABLE` 白名单

| 路径 | payload | 备注 |
| --- | --- | --- |
| `/state` | object | 含 `invSlotsUsed` / `invSlotsTotal` 等标量 |
| `/pos` | object | 含 `x` / `y` / `z` |
| `/inv/count` | object | 扁平 count map：物品名 → 数量；**不在表里的物品 = 0**（见 §7） |
| `/time` | object | 含 `day` 等（字段名待 MC 最终确认） |
| `/health` | object | 含 `ok` |

**只有这五个，且必须是精确字符串。** 以下全部拒（`path_not_waitable`）：

- `/inv` —— 数组。要表达"第 3 格是什么"就得引入下标/节点类型分派，v1 不做。
- `/fishbot` —— **`GET /fishbot` 本身就是 toggle**。把它放进 wait 白名单，
  等于给了模型一个"等待时会顺手开/关钓鱼"的后门。这类端点永远不进白名单。
- `/state?x=1`、`/state/`、`state` —— 都不是精确路径。带 query 的路径在白名单匹配上
  必然要么放过一切、要么写成前缀匹配；两种都是漏洞，所以直接要求字面相等。

## 3. 条件语法

```
expr    ::= path SP op SP literal
path    ::= ident ('.' ident)*
ident   ::= [A-Za-z0-9_]{1,64}
SP      ::= 单个空格（U+0020），多一个少一个都不合法
op      ::= '==' | '!=' | '<' | '<=' | '>' | '>='
literal ::= number | 'true' | 'false' | 'null' | string
number  ::= '-'? [0-9]+ ('.' [0-9]+)?          # 无指数、无前导 +、无 NaN/Infinity
string  ::= '"' [^"\\\n]{0,64} '"'             # 无反斜杠转义、不可含引号、不可跨行
```

上限：整条 `expr` ≤ **128** 字符；`path` ≤ **8** 段；单段 ≤ **64** 字符。

**匹配方式是全串匹配**（`\A...\Z`，不是 `search`，不是 `match` 后不管尾巴）。
所以 `"invSlotsUsed == 36\n"`、`"invSlotsUsed  ==  36"`、`" invSlotsUsed == 36"` 全部不合法。

刻意不支持的东西，以及为什么：

| 不支持 | 理由 |
| --- | --- |
| `and` / `or` / `&&` / `\|\|` | 组合条件 = 多次 `/wait`，或者由调用方在拿到两次结果后自己判。引入布尔运算就要引入优先级、括号、求值顺序，而表达式来自模型——这是通往 `eval` 的第一步。 |
| 括号 | 没有优先级就不需要括号。 |
| 函数调用（`len()`、`abs()`） | **条件字符串绝不进 `eval`/`new Function`/`vm`**。一旦允许"名字后面跟括号"，下一个需求就是 `includes()`，然后是 `map()`，然后是任意代码。 |
| 数组下标 / `[0]` | 见 §2 的 `/inv`。 |
| `=` 单等号 | 不是比较运算符；写错必须立刻拒，而不是当成 `==` 猜。 |
| 字符串排序比较（`"a" < "b"`） | Python 是码点序、JS 是 UTF-16 码元序，非 BMP 字符上必然分歧。**排序只对数字开放**，把口子焊死，而不是写一句"注意别用"。 |

## 4. 路径解析

纯字典下钻，逐段：

```
cur = payload
for seg in segments:
    if not is_object(cur):        -> type_error
    if seg not in cur:            -> missing
    cur = cur[seg]
-> ok, cur
```

- 不做属性访问、不做下标、没有 `length`、没有函数调用。
- **解析出的值是 `null` 是合法值，不是 `missing`。**
- `missing` 和 `type_error` 必须可区分（响应里是两个独立计数器）：
  - `missing` = 这个字段不存在 → 大概率是**字段名写错**或**端点换了**；
  - `type_error` = 字段在，但类型不能这么比 → 大概率是**模型对类型的假设错了**。
  两者的修法完全不同，混成一个"没等到"就没法查。

## 5. 比较语义

**绝不隐式转换。** 允许的组合只有：

| 运算 | 允许的类型 |
| --- | --- |
| `==` / `!=` | number↔number、string↔string、bool↔bool、null↔null |
| `<` `<=` `>` `>=` | **number↔number**（唯一） |

其余全部 `type_error`（记入样本统计，**不是** `bad_request`）。特别注意：

- `true == 1` → `type_error`（布尔不是数字；Python 里 `True == 1` 为真，JS 里 `true == 1` 为真，
  **两边都会"顺手"给出 true，所以这条必须显式拦**）
- `"36" == 36` → `type_error`
- `null == 36` → `type_error`；`null == null` → `true`
- `ok > false` → `type_error`

## 6. 错误与 `detail` 枚举

`reason = "bad_request"` 时，`detail` 是下列之一，按**固定顺序**检查（第一个失败的即为答案）：

| 序 | 检查 | `detail` |
| --- | --- | --- |
| 1 | `path` 是字符串且在 `WAITABLE` 中 | `path_not_waitable` |
| 2 | `condition` 存在且是字符串 | `request_shape` |
| 3 | `timeout_s`（若给）是正整数且 >0 | `request_shape` |
| 4 | `expr` 长度 ≤128 | `expr_len` |
| 5 | 全串匹配 `expr` | `condition_grammar` |
| 6 | 段数 ≤8 | `path_segments` |
| 7 | 每段 ≤64 字符 | `path_ident_len` |
| 8 | 字面量可解析 | `condition_literal` |
| 9 | `/inv/count`：首段在静态 schema 内 | `unknown_field` |

顺序固定是为了**让两个实现的失败原因可比**：同一条坏输入，Python 和 Node 必须报同一个
`detail`，否则 diff 里全是噪声，看多了就没人看了。

## 7. `/inv/count`：静态 schema 预检 + count map 语义（**两个机制，别混**）

`/inv/count` 的 payload 是扁平 count map：`{"iron_ingot": 100, "coal": 3, ...}`，
所以条件里的**首段就是物品名**，路径是相对的（没有 `items.` 前缀）。

这里有**两件独立的事**，2026-11-08 我把它们混在一张表里，写错了一格
（被 feiyu-os-repo 用探针当场证伪：`iron_ingot == 0` + 背包里没铁锭，实际是 `timeout` 而不是 `matched`）：

1. **静态 schema 预检**：条件首段必须在 1333 个已知物品名里。它**只决定要不要立刻 400**，
   不改变任何求值结果。
2. **count map 语义**：map 里**不在表里的物品，数量就是 0**。这是 map 的定义，不是求值器的宽容。

两条合起来的真实行为：

| 输入 | schema 预检 | 求值 | 结果 |
| --- | --- | --- | --- |
| `iron_ingot == 0`，背包里**没有**铁锭 | 通过 | 末段缺失 → 按 **0** | **立刻 `matched`** |
| `iron_ingot >= 64`，背包里**没有**铁锭 | 通过 | `0 >= 64` → false | 等到超时（`samples_missing = 0`、`samples_ok > 0`） |
| `iron_ingot == 0`，背包里**有**铁锭且数量 0 | 通过 | `0 == 0` | 立刻 `matched` |
| `iron_ingott == 0`（拼错） | **不通过** | 不求值 | **立刻 `bad_request` / `unknown_field`** |

**为什么第 2 条必须存在**：她要 `/wait` 的最常见理由是"等到我包里没有某样东西了"（腾格子、等烧完）。
如果把"不在表里"当 `missing`，这个条件会在**真正满足的时候**永远 `timeout`——
最难查的那种失败：错的是"没等到"，而实际状态早就对了。

**为什么 schema 预检仍然必须存在**：只有它能分开"没有这个物品"（正常，按 0）和"物品名拼错了"
（配置错误，立刻报）。两者在当前 payload 里长得一模一样。

**中间段没有默认值**：`/inv/count` 是扁平 map，只有一段。若将来出现嵌套路径，
只有**末段**能用默认值，中间段缺失仍是 `missing`（否则 `a.b.c` 会在 `a` 不存在时假装 `a` 是空对象）。

夹具把这两条钉死：`iv_count_absent_zero`（必须 matched）、`iv_count_absent_nonzero`
（必须 timeout 且 `samples_missing = 0`）、`iv_count_typo`（必须 400）。

## 8. 采样、统计与 fixture 语义

生产实现：`t=0` 立刻采一次，之后每 `poll`（建议 1s，允许 0.5–2s）采一次，直到命中或
`timeout_s` 用完；**命中立刻返回**。

样本分类（响应里的计数器）：

| 字段 | 定义 |
| --- | --- |
| `samples_total` | 采样次数 |
| `samples_ok` | **payload 拿到了**（HTTP 2xx 且能解析）——与条件是否成立无关 |
| `samples_failed` | payload 拿不到（连接失败 / 非 2xx / 非 JSON / 挂载点解包失败） |
| `samples_missing` | `samples_ok` 的子集：路径解析为 missing（`/inv/count` 末段缺失按 0 处理，**不计** missing，见 §7） |
| `samples_type_error` | `samples_ok` 的子集：类型不允许这个比较 |
| `matched_at_sample` | 首次命中的样本序号（1 起），未命中为 `null` |

注意 `samples_missing + samples_type_error ≤ samples_ok`：它们描述的是"拿到了但判不了"，
不是"没拿到"。把这两类混进 `samples_failed`，降级门就会被"字段名写错"触发，
从而把一次**可诊断的配置错误**伪装成**链路故障**。

**fixture 语义里 `timeout_s` 不决定采样次数。** 用例用 `max_samples` 给采样预算，
`snapshot` 每个元素是一次采样的 payload（用完后重复最后一个），`{"__error": "..."}`
表示这次拿不到 payload。理由：时间行为跨语言不可比，硬测只会得到一堆假红；
真实实现的 timeout 计算靠端到端跑（一次 3 秒的调用，`elapsed_ms` 在 2900–3200 之间）。
`effective_timeout_s` 仍然要自报，且**夹具里可以断言**（它是纯计算，不是时间）。

## 9. 判定优先级

```
bad_request  >  degraded  >  matched  >  timeout
```

具体规则：

| # | 规则 |
| --- | --- |
| R1 | 请求校验失败 → `bad_request`，**不采样**（`samples_total = 0`） |
| R2 | 采样期间任一样本命中 → 记住 `matched_at_sample` 并**停止采样** |
| R3 | 结束时 `samples_failed / samples_total > 0.5` → `degraded`，**即使已经命中** |
| R4 | 命中，但"含命中样本在内的最近 3 个样本"里有 ≥2 个 `failed` → `degraded`（不是 `matched`） |
| R5 | 未命中且未降级 → `timeout` |
| R6 | `total = 0` 不可能（至少采一次）；实现必须保证这一点 |

R3 的 `>` 是严格的：失败率正好 0.5 **不算**降级（有用例 `dg_ratio_half` 钉这个边界）。
R3/R4 的用意是同一个：**"看不见"和"条件不成立"必须能分开**。把一次全废的等待报成
`timeout`，她会以为"东西还没到"然后继续等；报成 `degraded`，她才会去看链路。

## 10. 跨语言分歧清单（每行都是 `semantics_probe.py` / `.js` 跑出来的）

**改这张表之前必须先跑探针。** 任何"两边都会……"的句子都要附探针键名，否则就是记忆而不是事实
（2026-11-08 我在这一节断言过"JS 的 `$` 也匹配结尾换行前"，被 minecraft 当场证伪：
JS 无 `/m` 的 `$` 就是绝对结尾。写错方向的代价很坏——它会让人去修一个不存在的问题，
同时漏掉真问题）。

| 探针键 | Python | JS | 本契约的解法 |
| --- | --- | --- | --- |
| `dollar_before_trailing_nl` | `true` | `false` | **不要依赖 `$` 的语义**：Python 用 `\Z`；JS 用 `$` 本身即够（无 `/m`），但**绝不许加 `/m`、绝不许先 `trim()`** |
| `\d` 是否吃全角数字 | `true` | `false` | 字符类写死 `[0-9]`，两侧都不许用 `\d`（Python 侧尤其危险：`\d` 会接受 `３`） |
| `null >= 0` | 抛 `TypeError` | `true` | 排序前必须显式判数值类型，否则 JS 把 `null` 当 0 参与比较 |
| `str36_eq_36` | `false` | `true` | 等值比较必须显式分派类型，不许交给语言默认（§5） |
| `true_eq_1` | `true` | `true` | **不是分歧，是共同陷阱**：两侧都必须显式拦（§5） |
| `nonbmp_lt_bmpmax` | `false` | `true` | 字符串排序两侧语义不同 → 排序只对数字开放（§3） |
| `dot_matches_newline` | `false` | `false` | 一致，但仍要求全串锚定（防实现改用 `search`/`.test` 半匹配） |
| `int_float_eq` | `true` | `true` | 数值比较按数值语义，不比较字面形式；响应里的计数一律整数 |
| `null_eq_0` | `false` | `false` | 一致；`null` 与"字段不存在"仍须分开（§4 的 `ok(null)` / `missing`） |

跑法：

```bash
python semantics_probe.py --json > py.json
node   semantics_probe.js  --json > js.json
# 逐键比对：出现 DIFF 的键必须在本表里有一行
```

当前实测：**6 个键两侧不同、4 个键相同**。这 6 个 DIFF 全部已在上表有对应规则。


## 11. fixture 格式

```json
{
  "fixture_v": 1,
  "contract": "wait/1",
  "cases": [
    {
      "id": "gp_ge",
      "intent": ">= 第二条样本才命中（长轮询语义）",
      "path": "/state",
      "condition": "invSlotsUsed >= 36",
      "timeout_s": 60,            // 可选
      "payload_of": "data",       // 可选，挂载参数
      "known_fields": ["iron_ingot"], // 可选，/inv/count 的静态 schema
      "snapshot": [{"invSlotsUsed": 35}, {"invSlotsUsed": 36}],
      "max_samples": 2,           // 可选，缺省 = len(snapshot)
      "expect": {"reason": "matched", "matched_at_sample": 2}
    }
  ]
}
```

判定规则：

1. `expect` 里列出的键必须逐一对上；**`expect` 里出现响应没有的键必须报错**
   （拼错的键名会让用例"永远通过"，这比不写用例更坏）。
2. `expect` 里没列出的键不参与判定（`value` / `elapsed_ms` / `effective_timeout_s` 默认不判）。
3. 用例对象里多出来的键忽略（前向兼容）；`fixture_v` 不认识就整体拒。
4. `contract` 字段用于对齐版本；与实现不一致时直接报错，不要"尽力跑"。

## 12. 阳性对照（`--mutation-check`）

一份全绿的 fixture 只证明"实现和夹具自洽"，不证明"夹具能抓错"。所以 Python 侧带一个
变异检查：把实现按 9 种方式改坏，**每种都必须至少打红一条用例**。

| 变异体 | 植入的缺陷 | 必须打红 |
| --- | --- | --- |
| `no_coercion` | 等值比较改成 `str()` 两边再比 | `ty_str_vs_num` `ty_num_vs_null` `ty_bool_vs_num` |
| `ratio_ge` | 降级门 `>` 写成 `>=` | `dg_ratio_half` |
| `allowlist_wide` | 白名单放宽成"任何 `/` 开头" | `sc_*` 四条 |
| `no_schema` | 去掉 `/inv/count` 静态 schema 预检 | `iv_count_typo` |
| `zero_as_missing` | 把 `0` 当成字段缺失 | `iv_count_zero` |
| `dollar_anchor` | 结尾锚点用 `$` | `gn_trailing_nl` |
| `strip` | 顺手 trim + 折叠空格 | `gn_double_space` `gn_trailing_nl` |
| `unicode_digit` | 数字字面量用 `\d` 而不是 `[0-9]` | `gn_fullwidth_digit` |
| `no_map_default` | 去掉 `/inv/count` 的「不在表里 = 0」 | `iv_count_absent_zero` |

Node 侧建议照抄这个思路（哪怕只是 3 个变异体）：**"0 条失败"这个指标本身需要阳性对照**，
否则一次"忘了真的跑"和一次"真的全过"在输出上完全一样。

## 13. v1 明确不做

| 不做 | 原因 |
| --- | --- |
| `/inv` 进条件面 | 数组 → 需要下标与节点类型分派，v1 不引入 |
| `and` / `or` | 见 §3；组合由调用方做 |
| 条件里带正则 / 通配 | 同上 |
| 客户端断开的夹具用例 | 断开的正确行为是"停止采样、不写响应"，这是时序性质，跨语言不可比；只在 R10（实现要求）里约束：用 `select`+`MSG_PEEK` 检测，**不许先采完再写一个必然失败的响应** |
| single-flight 的断言 | 允许实现共享 1 秒内的相同等待，但这不改变任何可观测判定，写进夹具只会锁死实现自由度 |
| `/wait` 拿动作锁 | **绝不允许**。它是只读端点，拿锁就等于让"等待"阻塞"操作" |

## 14. 待确认

- `/time` 的字段名：夹具里用 `day`（`pin_time_day`）。若 MC 侧真名不同，**改夹具不改桥**
  ——夹具是契约的产物，桥的字段名是既成事实。
- `poll` 间隔的默认值：本契约只约束"0.5–2s"，具体取 1s 由实现定。
