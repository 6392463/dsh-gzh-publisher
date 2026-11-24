# 收录条目草稿（不属于插件本体）

这个目录只是**给三个收录渠道准备的条目文件**，方便直接复制去开 PR。
`package.json` 的 `files` 白名单不含 `market/`，所以它不会进 npm 包，也不会被插件加载。

| 渠道 | 复制到这个路径 | 本目录的文件 |
| --- | --- | --- |
| awesome-dsh-plugin.com | `data/plugins/6392463__dsh-gzh-publisher.yml` | `awesome-dsh-plugin/6392463__dsh-gzh-publisher.yml` |
| 1024 Store（deepseek1024.com） | `catalog/plugins/6392463--dsh-gzh-publisher.json` | `1024store/6392463--dsh-gzh-publisher.json` |
| dshfind（dshfind.com / dsh-plugin.app） | **没有提交入口**：给仓库加 `dsh-plugin` topic，它每天同步 | — |

## 提交前必须满足（照两边的 CONTRIBUTING 抄，别省）

1. **一个 PR 只放这一个文件**，别顺手改 README/CI。1024Store 的门禁会拒掉 `catalog/plugins/*.json` 以外的一切改动；awesome 侧一个 PR 最多 3 条。
2. `package.json` 里 `dsh.bundle.patch` 非空，且 `cordis.patch.yml` 真的在同一个 revision 里——两边都会通过 GitHub API 读默认分支的 tree 复核，不是看你 PR 里写了什么。
3. **1024Store 只从 npm 安装**：没发 npm 也能收录，但会标成 browse-only（只有仓库链接、没有安装命令）。发上 npm（`npm publish --access public`，包名 `dsh-gzh-publisher`）之后目录会自动认出来，**不用再开一个 PR**。
4. 给仓库加 `dsh-plugin` topic（1024Store 要求 + dshfind 的唯一入口）。
5. awesome 侧要求**仓库存在满 1 天**，且 `icon` 必须是 GitHub 上的位图（我们现在只有 SVG，先留空或换 PNG）。
6. 两边都是静态门禁 + 人工看源码；描述要客观、具体，不要「最强 / 一键 / 完美」这类词。

## 改描述就改这里

`1024store/*.json` 是权威副本，awesome 的 `*.yml` 与它同义。`added` 是**提交日**，不是发布日。
